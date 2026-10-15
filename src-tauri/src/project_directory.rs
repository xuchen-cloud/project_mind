//! Read-only access to the current DB project's physical directory.
use crate::{
    models::ProjectIdInput,
    source_file_snapshot::{open_regular, FileStamp},
    AppState,
};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::{Manager, State, Webview};

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const IMAGE_LIMIT: usize = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryEntry {
    name: String,
    relative_path: String,
    kind: &'static str,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DirectoryPreview {
    Text {
        text: String,
        bytes: u64,
    },
    Image {
        mime: String,
        base64: String,
        bytes: u64,
    },
    Open {
        reason: &'static str,
        bytes: u64,
    },
}

#[derive(Debug)]
struct ResolvedPath {
    root: PathBuf,
    requested: PathBuf,
    canonical: PathBuf,
}

fn resolve(root: &Path, relative: &str) -> Result<ResolvedPath> {
    // The IPC path format is slash-separated on every platform. Reject Windows
    // drive/UNC syntax on Unix too, rather than treating it as a filename.
    if relative.contains('\\')
        || relative.contains(':')
        || relative.contains('\0')
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("路径必须是项目目录内的相对路径，不能包含 .. 或绝对路径");
    }
    if relative
        .split('/')
        .any(crate::db::project_directory_files::excluded_component)
    {
        bail!("隐藏文件和隐藏目录不属于项目业务文件");
    }
    if fs::symlink_metadata(root)
        .with_context(|| format!("无法访问项目目录：{}", root.display()))?
        .file_type()
        .is_symlink()
    {
        bail!("项目目录不能是符号链接");
    }
    let root = root
        .canonicalize()
        .with_context(|| format!("无法访问项目目录：{}", root.display()))?;
    if !root.is_dir() {
        bail!("项目根路径不是目录：{}", root.display());
    }
    let requested = root.join(relative);
    if crate::db::project_directory_files::hidden_project_path(&root, &requested)? {
        bail!("隐藏文件和隐藏目录不属于项目业务文件");
    }
    crate::db::file_versions::relative(&root, &requested).or_else(|error| {
        if relative.is_empty() {
            Ok(String::new())
        } else {
            Err(error)
        }
    })?;
    let canonical = requested
        .canonicalize()
        .with_context(|| format!("无法访问项目路径：{relative}"))?;
    if !canonical.starts_with(&root) {
        bail!("路径或符号链接指向项目目录之外");
    }
    Ok(ResolvedPath {
        root,
        requested,
        canonical,
    })
}

impl ResolvedPath {
    // Recheck after external filesystem I/O, before returning bytes or handing a
    // path to the opener. This also detects a parent symlink swapped during I/O.
    fn verify(&self) -> Result<()> {
        if self.root.canonicalize()? != self.root
            || self.requested.canonicalize()? != self.canonical
        {
            bail!("项目路径在读取期间发生变化，请刷新后重试");
        }
        Ok(())
    }
}

fn list(root: &Path, relative: &str) -> Result<Vec<DirectoryEntry>> {
    let resolved = resolve(root, relative)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&resolved.canonical).context("无法读取项目目录")? {
        let entry = entry?;
        let kind = entry.file_type()?;
        // Do not offer links or special files as navigable ordinary entries.
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("项目目录包含无法显示的非 UTF-8 文件名"))?;
        if crate::db::project_directory_files::excluded_component(&name) {
            continue;
        }
        if crate::db::project_directory_files::hidden_metadata(&entry.metadata()?) {
            continue;
        }
        let relative_path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let child = resolve(&resolved.root, &relative_path)?;
        let metadata = fs::metadata(&child.canonical)?;
        if !metadata.is_dir() && !metadata.is_file() {
            bail!("目录子项在读取期间发生变化，请刷新后重试");
        }
        entries.push(DirectoryEntry {
            name,
            relative_path,
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
            bytes: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
        child.verify()?;
    }
    resolved.verify()?;
    entries.sort_by(|a, b| {
        (a.kind != "directory")
            .cmp(&(b.kind != "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

fn preview(root: &Path, relative: &str) -> Result<DirectoryPreview> {
    let resolved = resolve(root, relative)?;
    let before = fs::symlink_metadata(&resolved.canonical)?;
    if !before.is_file() {
        bail!("只能预览普通文件");
    }
    let expected = FileStamp::from_metadata(&before);
    let mut file = open_regular(&resolved.canonical)
        .map_err(|error| anyhow::anyhow!("无法安全打开项目文件：{error:?}"))?;
    let opened = file.metadata()?;
    if !opened.is_file() || FileStamp::from_metadata(&opened) != expected {
        bail!("文件在打开期间发生变化，请刷新后重试");
    }
    let mime = mime_guess::from_path(&resolved.canonical)
        .first_raw()
        .unwrap_or("application/octet-stream");
    let raster = matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    );
    let limit = if raster { IMAGE_LIMIT } else { TEXT_LIMIT };
    if opened.len() > limit as u64 {
        resolved.verify()?;
        return Ok(DirectoryPreview::Open {
            reason: "tooLarge",
            bytes: opened.len(),
        });
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    resolved.verify()?;
    if FileStamp::from_metadata(&file.metadata()?) != expected
        || FileStamp::from_metadata(&fs::symlink_metadata(&resolved.canonical)?) != expected
    {
        bail!("文件在读取期间发生变化，请刷新后重试");
    }
    if bytes.len() > limit {
        return Ok(DirectoryPreview::Open {
            reason: "tooLarge",
            bytes: bytes.len() as u64,
        });
    }
    let length = bytes.len() as u64;
    if raster {
        let detected = match image::guess_format(&bytes) {
            Ok(image::ImageFormat::Png) => Some("image/png"),
            Ok(image::ImageFormat::Jpeg) => Some("image/jpeg"),
            Ok(image::ImageFormat::Gif) => Some("image/gif"),
            Ok(image::ImageFormat::WebP) => Some("image/webp"),
            _ => None,
        };
        if let Some(mime) = detected {
            return Ok(DirectoryPreview::Image {
                mime: mime.into(),
                base64: STANDARD.encode(bytes),
                bytes: length,
            });
        }
        return Ok(DirectoryPreview::Open {
            reason: "binary",
            bytes: length,
        });
    }
    // SVG is ordinary text; the frontend never embeds it as an image or HTML.
    match String::from_utf8(bytes) {
        Ok(text)
            if !text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) =>
        {
            Ok(DirectoryPreview::Text {
                text,
                bytes: length,
            })
        }
        _ => Ok(DirectoryPreview::Open {
            reason: "binary",
            bytes: length,
        }),
    }
}

fn project_root(state: State<'_, AppState>, project_id: i64) -> Result<PathBuf, String> {
    crate::with_db(state, |db| {
        Ok(PathBuf::from(
            db.project_page_get(ProjectIdInput { project_id })?
                .project
                .root_path,
        ))
    })
}

fn authorize_identity(
    label: &str,
    window_label: &str,
    project_id: i64,
    local_origin: bool,
) -> Result<(), String> {
    if project_id <= 0
        || (label != "main" && label != format!("project-{project_id}"))
        || window_label != label
        || !local_origin
    {
        return Err("此窗口不能访问该项目目录".into());
    }
    Ok(())
}

fn authorize_caller(caller: &Webview, project_id: i64) -> Result<(), String> {
    let url = caller.url().map_err(|_| "无法验证目录浏览调用窗口")?;
    let local_origin = if cfg!(dev) {
        caller
            .app_handle()
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin())
    } else {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
    };
    authorize_identity(
        caller.label(),
        caller.window().label(),
        project_id,
        local_origin,
    )
}

#[tauri::command]
pub(crate) fn project_directory_list(
    caller: Webview,
    state: State<'_, AppState>,
    project_id: i64,
    relative_path: Option<String>,
) -> Result<Vec<DirectoryEntry>, String> {
    authorize_caller(&caller, project_id)?;
    list(
        &project_root(state, project_id)?,
        relative_path.as_deref().unwrap_or(""),
    )
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub(crate) fn project_directory_preview(
    caller: Webview,
    state: State<'_, AppState>,
    project_id: i64,
    relative_path: String,
) -> Result<DirectoryPreview, String> {
    authorize_caller(&caller, project_id)?;
    preview(&project_root(state, project_id)?, &relative_path).map_err(|error| format!("{error:#}"))
}

/// Resolve an assistant link using the authoritative project directory.
fn reference_relative(root: &Path, reference: &str) -> Result<String> {
    if !Path::new(reference).is_absolute() {
        let resolved = resolve(root, reference)?;
        resolved.verify()?;
        return Ok(reference.to_owned());
    }
    let root = root.canonicalize()?;
    let path = Path::new(reference);
    if path
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("文件引用不能包含 ..");
    }
    let target = path.canonicalize()?;
    let relative = target
        .strip_prefix(&root)
        .context("文件引用位于当前项目目录之外")?;
    let relative = relative
        .to_str()
        .context("文件路径不能显示为 UTF-8")?
        .replace('\\', "/");
    let resolved = resolve(&root, &relative)?;
    resolved.verify()?;
    Ok(relative)
}

#[tauri::command]
pub(crate) fn project_directory_resolve_reference(
    caller: Webview,
    state: State<'_, AppState>,
    project_id: i64,
    reference: String,
) -> Result<String, String> {
    authorize_caller(&caller, project_id)?;
    reference_relative(&project_root(state, project_id)?, &reference)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub(crate) fn project_directory_open(
    caller: Webview,
    state: State<'_, AppState>,
    project_id: i64,
    relative_path: String,
) -> Result<(), String> {
    authorize_caller(&caller, project_id)?;
    let resolved = resolve(&project_root(state, project_id)?, &relative_path)
        .map_err(|error| format!("{error:#}"))?;
    resolved.verify().map_err(|error| format!("{error:#}"))?;
    crate::open_path_with_system_app(&resolved.canonical).map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ds_store_directory_fixture() -> tempfile::TempDir {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("sub")).unwrap();
        for relative in [
            ".DS_Store",
            "sub/.DS_Store",
            ".env",
            "sub/.env",
            "note.txt",
            "sub/note.txt",
        ] {
            fs::write(root.path().join(relative), b"file contents").unwrap();
        }
        for directory in [".git/nested", "sub/.cache/nested"] {
            fs::create_dir_all(root.path().join(directory)).unwrap();
            fs::write(
                root.path().join(directory).join("ordinary.txt"),
                b"hidden descendant",
            )
            .unwrap();
        }
        root
    }

    #[test]
    fn ds_store_directory_list_hides_root_and_nested_metadata_keeps_ordinary_files() {
        let root = ds_store_directory_fixture();
        let mut root_names: Vec<_> = list(root.path(), "")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        root_names.sort();
        let mut sub_names: Vec<_> = list(root.path(), "sub")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        sub_names.sort();
        assert_eq!(
            (root_names, sub_names),
            (
                vec!["note.txt".to_owned(), "sub".to_owned()],
                vec!["note.txt".to_owned()],
            )
        );
    }

    #[test]
    fn ds_store_directory_preview_rejects_metadata_keeps_ordinary_files() {
        let root = ds_store_directory_fixture();
        for relative in ["note.txt", "sub/note.txt"] {
            assert!(
                matches!(preview(root.path(), relative).unwrap(), DirectoryPreview::Text { text, .. } if text == "file contents")
            );
        }
        let rejected: Vec<_> = [".DS_Store", "sub/.DS_Store", ".env", "sub/.env"]
            .map(|relative| preview(root.path(), relative).is_err())
            .into();
        assert_eq!(rejected, [true; 4]);
    }

    #[test]
    fn ds_store_directory_resolve_rejects_metadata_keeps_ordinary_files() {
        let root = ds_store_directory_fixture();
        for relative in ["note.txt", "sub/note.txt"] {
            assert_eq!(
                resolve(root.path(), relative).unwrap().canonical,
                root.path().join(relative).canonicalize().unwrap()
            );
        }
        let rejected = [".DS_Store", "sub/.DS_Store", ".env", "sub/.env"]
            .map(|relative| resolve(root.path(), relative).is_err());
        assert_eq!(rejected, [true; 4]);
    }

    #[test]
    fn hidden_directory_ancestors_block_listing_preview_and_resolve() {
        let root = ds_store_directory_fixture();
        for relative in [".git", ".git/nested", "sub/.cache", "sub/.cache/nested"] {
            assert!(list(root.path(), relative).is_err(), "{relative}");
            assert!(resolve(root.path(), relative).is_err(), "{relative}");
        }
        for relative in [".git/nested/ordinary.txt", "sub/.cache/nested/ordinary.txt"] {
            assert!(preview(root.path(), relative).is_err(), "{relative}");
            assert!(resolve(root.path(), relative).is_err(), "{relative}");
            assert_eq!(
                fs::read(root.path().join(relative)).unwrap(),
                b"hidden descendant"
            );
        }
        assert!(preview(root.path(), "note.txt").is_ok());
        assert!(preview(root.path(), "sub/note.txt").is_ok());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn hidden_native_attributes_hide_files_and_directory_descendants_from_business_access() {
        let root = ds_store_directory_fixture();
        fs::write(root.path().join("native-file.txt"), b"native hidden file").unwrap();
        fs::create_dir_all(root.path().join("native-folder/nested")).unwrap();
        fs::write(
            root.path().join("native-folder/nested/ordinary.txt"),
            b"native hidden descendant",
        )
        .unwrap();
        for relative in ["native-file.txt", "native-folder"] {
            #[cfg(target_os = "macos")]
            let output = std::process::Command::new("chflags")
                .arg("hidden")
                .arg(root.path().join(relative))
                .output()
                .unwrap();
            #[cfg(windows)]
            let output = std::process::Command::new("attrib")
                .arg("+h")
                .arg(root.path().join(relative))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "could not mark {relative} hidden: {:?}",
                output
            );
        }
        let mut names: Vec<_> = list(root.path(), "")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        assert_eq!(names, ["note.txt", "sub"]);
        for relative in ["native-folder", "native-folder/nested"] {
            assert!(list(root.path(), relative).is_err(), "{relative}");
        }
        for relative in ["native-file.txt", "native-folder/nested/ordinary.txt"] {
            assert!(preview(root.path(), relative).is_err(), "{relative}");
            assert!(resolve(root.path(), relative).is_err(), "{relative}");
            assert!(root.path().join(relative).is_file());
        }
        assert!(preview(root.path(), "note.txt").is_ok());
        assert!(resolve(root.path(), "sub/note.txt").is_ok());
    }

    #[test]
    fn directory_business_access_excludes_internal_data_and_all_symlinks() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".project-mind")).unwrap();
        fs::write(root.path().join(".project-mind/private"), b"secret").unwrap();
        fs::write(root.path().join("visible"), b"safe").unwrap();
        assert_eq!(list(root.path(), "").unwrap().len(), 1);
        assert!(preview(root.path(), ".project-mind/private").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("visible"), root.path().join("alias"))
                .unwrap();
            assert!(preview(root.path(), "alias").is_err());
        }
    }

    #[test]
    fn assistant_references_resolve_only_inside_the_actual_project() {
        let project = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(project.path().join("file.txt"), "inside").unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        assert_eq!(
            reference_relative(project.path(), "file.txt").unwrap(),
            "file.txt"
        );
        assert_eq!(
            reference_relative(
                project.path(),
                project.path().join("file.txt").to_str().unwrap()
            )
            .unwrap(),
            "file.txt"
        );
        assert!(reference_relative(
            project.path(),
            outside.path().join("secret.txt").to_str().unwrap()
        )
        .is_err());
        assert!(reference_relative(project.path(), "../secret.txt").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("secret.txt"),
                project.path().join("escape.txt"),
            )
            .unwrap();
            assert!(reference_relative(project.path(), "escape.txt").is_err());
        }
    }

    #[test]
    fn only_local_business_parent_views_can_access_their_project() {
        assert!(authorize_identity("main", "main", 2, true).is_ok());
        assert!(authorize_identity("project-2", "project-2", 2, true).is_ok());
        for (label, window, project, local) in [
            ("project-1", "project-1", 2, true),
            ("dsh-assistant", "main", 2, true),
            ("main", "main", 2, false),
            ("project-2", "main", 2, true),
            ("main", "main", 0, true),
        ] {
            assert!(authorize_identity(label, window, project, local).is_err());
        }
    }

    #[test]
    fn lists_real_unregistered_files_and_rejects_traversal_and_missing_roots() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("sub")).unwrap();
        fs::write(root.path().join("new.txt"), "new").unwrap();
        let entries = list(root.path(), "").unwrap();
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].relative_path, "new.txt");
        assert_eq!(entries[1].bytes, 3);
        for input in [
            "../outside",
            "/tmp",
            "sub/../new.txt",
            "C:/file",
            "\\\\server\\file",
        ] {
            assert!(resolve(root.path(), input).is_err(), "{input}");
        }
        assert!(resolve(&root.path().join("missing"), "")
            .unwrap_err()
            .to_string()
            .contains("无法访问项目目录"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_detects_parent_swap() {
        use std::os::unix::fs::symlink;
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(resolve(root.path(), "escape/secret").is_err());
        assert!(list(root.path(), "").unwrap().is_empty());
        fs::create_dir(root.path().join("sub")).unwrap();
        fs::write(root.path().join("sub/secret"), "safe").unwrap();
        let resolved = resolve(root.path(), "sub/secret").unwrap();
        fs::rename(root.path().join("sub"), root.path().join("old")).unwrap();
        symlink(outside.path(), root.path().join("sub")).unwrap();
        assert!(resolved.verify().is_err());
    }

    #[test]
    fn text_svg_binary_and_budget_boundaries() {
        let root = tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| fs::write(root.path().join(name), bytes).unwrap();
        write("note.txt", &vec![b'a'; TEXT_LIMIT]);
        assert!(
            matches!(preview(root.path(), "note.txt").unwrap(), DirectoryPreview::Text { bytes, .. } if bytes == TEXT_LIMIT as u64)
        );
        write("large.txt", &vec![b'a'; TEXT_LIMIT + 1]);
        assert!(matches!(
            preview(root.path(), "large.txt").unwrap(),
            DirectoryPreview::Open {
                reason: "tooLarge",
                ..
            }
        ));
        write("binary.bin", &[0, 1, 255]);
        assert!(matches!(
            preview(root.path(), "binary.bin").unwrap(),
            DirectoryPreview::Open {
                reason: "binary",
                ..
            }
        ));
        write("unsafe.svg", b"<svg><script>alert(1)</script></svg>");
        assert!(matches!(
            preview(root.path(), "unsafe.svg").unwrap(),
            DirectoryPreview::Text { .. }
        ));
        write("photo.png", b"\x89PNG\r\n\x1a\nfixture");
        assert!(
            matches!(preview(root.path(), "photo.png").unwrap(), DirectoryPreview::Image { mime, bytes: 15, .. } if mime == "image/png")
        );
        write("huge.png", &vec![0; IMAGE_LIMIT + 1]);
        assert!(matches!(
            preview(root.path(), "huge.png").unwrap(),
            DirectoryPreview::Open {
                reason: "tooLarge",
                ..
            }
        ));
    }
}

use crate::agent::models::{ObjectRef, Scope, WorkspaceBinding};
use crate::db::project_directory_files::{
    DirectoryFile, DirectoryScan, FileBytesInput, FileBytesResult, FileServiceError,
};

fn object_project(object: &ObjectRef) -> Result<i64, FileServiceError> {
    match object.scope {
        Scope::Project { project_id } if project_id > 0 => Ok(project_id),
        _ => Err(FileServiceError {
            code: "ownership_mismatch",
            message: "File requires a Project".into(),
        }),
    }
}
fn file_caller(caller: &Webview, project: i64) -> Result<(), FileServiceError> {
    authorize_caller(caller, project).map_err(|message| FileServiceError {
        code: "ownership_mismatch",
        message,
    })
}
pub(crate) fn bound_file_command<S, T>(
    store: &S,
    binding: &WorkspaceBinding,
    task: impl FnOnce(&crate::db::Database) -> Result<T>,
) -> Result<T, FileServiceError>
where
    S: crate::source_service::BoundSourceStore + crate::committed_changes::CommittedChangePublisher,
{
    use crate::agent::errors::{AgentError, ErrorCode};
    let request_id = format!("gui:{:032x}", rand::random::<u128>());
    let (result, changes) = store
        .with_current(|current, db| {
            if current != binding {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "File Workspace was closed or reopened",
                ));
            }
            crate::committed_changes::capture_committed(current, db, &request_id, || {
                Ok(task(db).map_err(FileServiceError::from_error))
            })
        })
        .map_err(|error| FileServiceError {
            code: if error.code == ErrorCode::WorkspaceChanged {
                "workspace_changed"
            } else {
                "io_failed"
            },
            message: error.message,
        })?;
    if let Some(changes) = changes {
        store.publish_committed(changes);
    }
    result.map_err(|error| FileServiceError {
        code: "io_failed",
        message: error.message,
    })?
}
fn file_db<T>(
    state: State<'_, AppState>,
    binding: &WorkspaceBinding,
    task: impl FnOnce(&crate::db::Database) -> Result<T>,
) -> Result<T, FileServiceError> {
    bound_file_command(&*state, binding, task)
}
#[tauri::command]
pub(crate) fn project_file_register(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    project_id: i64,
    relative_path: String,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, project_id)?;
    file_db(state, &binding, |db| {
        db.project_file_register(&binding.workspace_id, project_id, &relative_path)
    })
}
#[tauri::command]
pub(crate) fn project_file_resolve(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| db.project_file_resolve(&object))
}
#[tauri::command]
pub(crate) fn project_file_read_bytes(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    input: FileBytesInput,
) -> Result<FileBytesResult, FileServiceError> {
    file_caller(&caller, object_project(&input.object)?)?;
    file_db(state, &binding, |db| db.project_file_read_bytes(&input))
}
#[tauri::command]
pub(crate) fn project_file_move(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
    relative_path: String,
    expected_version_number: u32,
    expected_content_hash: String,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| {
        db.project_file_move(
            &object,
            &relative_path,
            expected_version_number,
            &expected_content_hash,
        )
    })
}
#[tauri::command]
pub(crate) fn project_file_rename(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
    name: String,
    expected_version_number: u32,
    expected_content_hash: String,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| {
        db.project_file_rename(
            &object,
            &name,
            expected_version_number,
            &expected_content_hash,
        )
    })
}
#[tauri::command]
pub(crate) fn project_file_reconcile(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
    relative_path: String,
    expected_version_number: u32,
    expected_content_hash: String,
    confirmation: String,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| {
        db.project_file_reconcile(
            &object,
            &relative_path,
            expected_version_number,
            &expected_content_hash,
            &confirmation,
        )
    })
}
#[tauri::command]
pub(crate) fn project_file_scan(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    project_id: i64,
    cursor: Option<String>,
    limit: Option<u32>,
    cancelled: Option<bool>,
) -> Result<DirectoryScan, FileServiceError> {
    file_caller(&caller, project_id)?;
    file_db(state, &binding, |db| {
        db.project_file_scan(
            &binding.workspace_id,
            project_id,
            cursor.as_deref(),
            limit.unwrap_or(50),
            cancelled.unwrap_or(false),
        )
    })
}

#[tauri::command]
pub(crate) fn project_file_resolve_related(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
    relative_reference: String,
) -> Result<DirectoryFile, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| {
        db.project_file_resolve_related(&object, &relative_reference)
    })
}

#[tauri::command]
pub(crate) fn project_file_open_local(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
) -> Result<(), FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    file_db(state, &binding, |db| {
        db.project_file_open_local_with(&object, crate::open_path_with_system_app)
    })
}

// The plan is obtained through the same identity/path guard as opening. OS
// enumeration runs without the DB lock, then the async boundary is revalidated.
fn native_application_error(message: String) -> FileServiceError {
    FileServiceError {
        code: "io_failed",
        message,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn native_file_path(db: &crate::db::Database, object: &ObjectRef) -> Result<PathBuf> {
    let mut path = None;
    db.project_file_open_local_with(object, |current| {
        path = Some(current.to_path_buf());
        Ok(())
    })?;
    Ok(path.expect("validated local File callback"))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn revalidate_native_file<T>(
    db: &crate::db::Database,
    object: &ObjectRef,
    planned_path: &Path,
    action: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    let mut result = None;
    db.project_file_open_local_with(object, |current| {
        if current != planned_path {
            return Err(FileServiceError {
                code: "revision_conflict",
                message: "Current File location changed during application lookup".into(),
            }
            .into());
        }
        result = Some(action(current)?);
        Ok(())
    })?;
    Ok(result.expect("validated local File callback"))
}

#[tauri::command]
pub(crate) async fn project_file_applications(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
) -> Result<Vec<crate::native_file_icons::NativeFileApplication>, FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    let permit = crate::native_file_icons::native_icon_permit()
        .await
        .map_err(native_application_error)?;
    let _ = state;
    let app = caller.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let state = app.state::<AppState>();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let path = file_db(state.clone(), &binding, |db| native_file_path(db, &object))?;
            let applications = crate::native_file_icons::Applications::load(&path)
                .map_err(native_application_error)?;
            file_db(state, &binding, |db| {
                revalidate_native_file(db, &object, &path, |_| Ok(applications.list()))
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        file_db(state, &binding, |db| {
            db.project_file_open_local_with(&object, |_| Ok(()))?;
            Ok(Vec::new())
        })
    })
    .await
    .map_err(|error| native_application_error(error.to_string()))?
}

#[tauri::command]
pub(crate) async fn project_file_open_with(
    caller: Webview,
    state: State<'_, AppState>,
    binding: WorkspaceBinding,
    object: ObjectRef,
    application_id: String,
) -> Result<(), FileServiceError> {
    file_caller(&caller, object_project(&object)?)?;
    let permit = crate::native_file_icons::native_icon_permit()
        .await
        .map_err(native_application_error)?;
    let _ = state;
    let app = caller.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let state = app.state::<AppState>();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let path = file_db(state.clone(), &binding, |db| native_file_path(db, &object))?;
            let applications = crate::native_file_icons::Applications::load(&path)
                .map_err(native_application_error)?;
            crate::native_file_icons::select_application(&applications.list(), &application_id)?;
            file_db(state, &binding, |db| {
                revalidate_native_file(db, &object, &path, |current| {
                    applications.open(&application_id, current)
                })
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (state, binding, object, application_id);
            Err(native_application_error(
                "Open with is unsupported on this platform".into(),
            ))
        }
    })
    .await
    .map_err(|error| native_application_error(error.to_string()))?
}

#[cfg(test)]
mod bound_tests {
    use super::*;
    use crate::{
        agent::errors::AgentResult,
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        models::ProjectCreateInput,
        source_service::BoundSourceStore,
    };
    struct Store {
        db: crate::db::Database,
        binding: WorkspaceBinding,
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &crate::db::Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db)
        }
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _changes: CommittedChanges) {}
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn native_fixture() -> (tempfile::TempDir, Store, DirectoryFile) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            crate::db::Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("workspace").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Native application guard".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        fs::write(
            Path::new(&project.root_path).join("current.txt"),
            "current original",
        )
        .unwrap();
        let file = db
            .project_file_register("workspace", project.id, "current.txt")
            .unwrap();
        (
            root,
            Store {
                db,
                binding: WorkspaceBinding {
                    workspace_id: "workspace".into(),
                    generation: "open".into(),
                },
            },
            file,
        )
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn native_file_icons_guard_revalidates_generation_and_original_location_after_lookup() {
        let (_root, mut store, file) = native_fixture();
        let binding = store.binding.clone();
        let path =
            bound_file_command(&store, &binding, |db| native_file_path(db, &file.object)).unwrap();
        let current = bound_file_command(&store, &binding, |db| {
            revalidate_native_file(db, &file.object, &path, |actual| Ok(actual.to_path_buf()))
        })
        .unwrap();
        assert_eq!(current, path);
        store.binding.generation = "reopened".into();
        assert_eq!(
            bound_file_command(&store, &binding, |db| revalidate_native_file(
                db,
                &file.object,
                &path,
                |_| -> Result<()> { panic!("stale workspace must not launch") }
            ))
            .unwrap_err()
            .code,
            "workspace_changed"
        );
        store.binding = binding.clone();
        store
            .db
            .project_file_rename(
                &file.object,
                "renamed.txt",
                file.version_number,
                file.content_hash.as_deref().unwrap(),
            )
            .unwrap();
        assert_eq!(
            bound_file_command(&store, &binding, |db| revalidate_native_file(
                db,
                &file.object,
                &path,
                |_| -> Result<()> { panic!("changed location must not launch") }
            ))
            .unwrap_err()
            .code,
            "revision_conflict"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn native_file_icons_guard_accepts_same_path_replacement_but_rejects_foreign_ownership_and_missing_original() {
        let (_root, store, file) = native_fixture();
        let binding = store.binding.clone();
        let path =
            bound_file_command(&store, &binding, |db| native_file_path(db, &file.object)).unwrap();
        let mut foreign = file.object.clone();
        foreign.workspace_id = "another-workspace".into();
        assert!(bound_file_command(&store, &binding, |db| native_file_path(db, &foreign)).is_err());
        foreign = file.object.clone();
        foreign.scope = Scope::Project {
            project_id: object_project(&file.object).unwrap() + 1,
        };
        assert!(bound_file_command(&store, &binding, |db| native_file_path(db, &foreign)).is_err());
        let replacement = path.with_file_name("replacement.txt");
        for (content, version) in [("current original", 1), ("externally saved", 2)] {
            fs::write(&replacement, content).unwrap();
            fs::rename(&replacement, &path).unwrap();
            bound_file_command(&store, &binding, |db| revalidate_native_file(
                db,
                &file.object,
                &path,
                |actual| -> Result<()> {
                    assert_eq!(actual, path);
                    assert_eq!(fs::read_to_string(actual).unwrap(), content);
                    Ok(())
                }
            ))
            .unwrap();
            let current = store.db.project_file_resolve(&file.object).unwrap();
            assert_eq!(current.state, "ready");
            assert_eq!(current.version_number, version);
        }
        fs::remove_file(&path).unwrap();
        assert!(
            bound_file_command(&store, &binding, |db| revalidate_native_file(
                db,
                &file.object,
                &path,
                |_| -> Result<()> { panic!("historical snapshot must not launch") }
            ))
            .is_err()
        );
    }
    #[test]
    fn directory_file_bound_commands_reject_old_generation_after_same_workspace_reopens() {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            crate::db::Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("workspace").unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Generation".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        fs::write(Path::new(&project.root_path).join("data.bin"), [0, 255]).unwrap();
        let current = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "reopened".into(),
        };
        let stale = WorkspaceBinding {
            workspace_id: "workspace".into(),
            generation: "closed".into(),
        };
        let store = Store {
            db,
            binding: current.clone(),
        };
        let rejected = bound_file_command(&store, &stale, |db| {
            db.project_file_register("workspace", project.id, "data.bin")
        })
        .unwrap_err();
        assert_eq!(rejected.code, "workspace_changed");
        let allowed = bound_file_command(&store, &current, |db| {
            db.project_file_register("workspace", project.id, "data.bin")
        })
        .unwrap();
        assert_eq!(allowed.version_number, 1);
    }
}
