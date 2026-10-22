use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const TEMPLATE: &str =
    include_str!("../../packages/dsh-assistant/skills/project-mind-memory/SKILL.md");
const MAX_BYTES: usize = 128 * 1024;
const RELATIVE_PATH: &str = ".project-mind/skills/project-mind-memory/SKILL.md";
const CONFLICT: &str = "REVISION_CONFLICT: 行为文件已变化，请重新读取并合并修改";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Behavior {
    pub path: String,
    pub content: String,
    pub revision: String,
}

fn failure(error: impl std::fmt::Display) -> String {
    format!("记忆行为文件：{error}")
}
fn revision(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
fn initialized_path(root: &Path) -> Result<PathBuf, String> {
    let path = root.join(RELATIVE_PATH);
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(failure)?;
    if !path.exists() {
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(failure)?;
        temp.write_all(TEMPLATE.as_bytes()).map_err(failure)?;
        temp.as_file().sync_all().map_err(failure)?;
        if let Err(error) = temp.persist_noclobber(&path) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(failure(error));
            }
        }
    }
    Ok(path)
}
fn read_path(path: &Path) -> Result<Behavior, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(failure)?
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > MAX_BYTES {
        return Err("记忆行为文件超过 128 KiB，请缩短内容；未截断文件".into());
    }
    let content = String::from_utf8(bytes).map_err(failure)?;
    Ok(Behavior {
        path: path.to_string_lossy().into_owned(),
        revision: revision(&content),
        content,
    })
}
pub fn read(root: &Path) -> Result<Behavior, String> {
    let path = initialized_path(root)?;
    read_path(&path)
}
pub fn save(root: &Path, expected_revision: &str, content: &str) -> Result<Behavior, String> {
    if content.len() > MAX_BYTES {
        return Err("记忆行为文件超过 128 KiB，请缩短内容；未保存".into());
    }
    let path = initialized_path(root)?;
    if read_path(&path)?.revision != expected_revision {
        return Err(CONFLICT.into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(failure)?;
    temp.write_all(content.as_bytes()).map_err(failure)?;
    temp.as_file().sync_all().map_err(failure)?;
    // AppState serializes native callers. Recheck after staging to detect manual
    // edits too; an external editor racing the final rename cannot be locked out.
    if read_path(&path)?.revision != expected_revision {
        return Err(CONFLICT.into());
    }
    temp.persist(&path).map_err(failure)?;
    read_path(&path)
}

#[tauri::command]
pub(crate) fn memory_behavior_get(
    state: tauri::State<'_, crate::AppState>,
    caller: tauri::Webview,
    binding: crate::agent::models::WorkspaceBinding,
) -> Result<Behavior, String> {
    crate::dsh_assistant::authorize_caller(&caller)?;
    crate::dsh_assistant::authorize_scope_label(caller.label(), None)?;
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("请先打开工作区")?;
    if runtime.agent_binding != binding {
        return Err("工作区已变化，请重新打开记忆面板".into());
    }
    read(&runtime.paths.root_path)
}
#[tauri::command]
pub(crate) fn memory_behavior_save(
    state: tauri::State<'_, crate::AppState>,
    caller: tauri::Webview,
    binding: crate::agent::models::WorkspaceBinding,
    expected_revision: String,
    content: String,
) -> Result<Behavior, String> {
    crate::dsh_assistant::authorize_caller(&caller)?;
    crate::dsh_assistant::authorize_scope_label(caller.label(), None)?;
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("请先打开工作区")?;
    if runtime.agent_binding != binding {
        return Err("工作区已变化，请重新打开记忆面板".into());
    }
    save(&runtime.paths.root_path, &expected_revision, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initializes_once_and_observes_manual_edits() {
        let root = tempfile::tempdir().unwrap();
        let first = read(root.path()).unwrap();
        assert_eq!(first.content, TEMPLATE);
        fs::write(&first.path, "user custom skill").unwrap();
        let next = read(root.path()).unwrap();
        assert_eq!(next.content, "user custom skill");
        assert_ne!(next.revision, first.revision);
        assert!(save(root.path(), &first.revision, "stale edit")
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        assert_eq!(read(root.path()).unwrap().content, "user custom skill");
    }
    #[test]
    fn saves_using_current_revision_and_rejects_stale_writer() {
        let root = tempfile::tempdir().unwrap();
        let first = read(root.path()).unwrap();
        let next = save(root.path(), &first.revision, "new instructions").unwrap();
        assert_eq!(next.content, "new instructions");
        assert_ne!(next.revision, first.revision);
        assert!(save(root.path(), &first.revision, "stale writer").is_err());
        assert_eq!(read(root.path()).unwrap().content, next.content);
    }
    #[test]
    fn rejects_oversize_without_truncation() {
        let root = tempfile::tempdir().unwrap();
        let first = read(root.path()).unwrap();
        let too_large = "x".repeat(MAX_BYTES + 1);
        assert!(save(root.path(), &first.revision, &too_large).is_err());
        assert_eq!(read(root.path()).unwrap().revision, first.revision);
        fs::write(&first.path, &too_large).unwrap();
        assert!(read(root.path()).unwrap_err().contains("128 KiB"));
        assert_eq!(fs::read_to_string(first.path).unwrap(), too_large);
    }
}
