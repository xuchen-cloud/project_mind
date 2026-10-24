//! Fixed pyannote 3.0 + 3D-Speaker ERes2Net CPU package.
use super::model_package::ModelPackageStatus;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const PACKAGE_ID: &str = "pyannote-3.0-eres2net-zh-16k-v1";
const EXTRACTED_DIR: &str = "sherpa-onnx-pyannote-segmentation-3-0";
const VERIFIED_MARKER: &str = ".verified.json";
pub const EMBEDDING_FILE: &str = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
// Official sherpa releases (speaker-segmentation-models / speaker-recongition-models).
// Segmentation LICENSE is MIT, copyright CNRS 2022, bundled in the official archive.
// 3D-Speaker LICENSE (Apache-2.0):
// https://raw.githubusercontent.com/modelscope/3D-Speaker/065629c313eaf1a01c65c640c46d77e61e9607b4/LICENSE
// Save the latter as EMBEDDING-LICENSE beside the model files.
// Embedding mirror revision 0743f301363dec56491a490f6d6cbc9d67f9a3bf at
// https://huggingface.co/csukuangfj/speaker-embedding-models (official export author).
pub(super) const FILES: [(&str, &str); 4] = [
    (
        "model.onnx",
        "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    ),
    (
        "LICENSE",
        "14d7016ad68e7394d6e6b78d96cc2ae431c905287b89674cfdf021e79e62b8ba",
    ),
    (
        EMBEDDING_FILE,
        "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
    ),
    (
        "EMBEDDING-LICENSE",
        "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    ),
];
pub(super) const FILE_SIZES: [u64; 4] = [5_992_913, 1_061, 39_593_761, 11_357];

#[cfg(test)]
pub(super) fn import_install_fixture(
    source: &Path,
    cache_root: &Path,
    files: &[(&str, &str)],
) -> Result<()> {
    import_verified(source, cache_root, files, "install-test")
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct VerifiedPackage {
    package_id: String,
    files: Vec<VerifiedFile>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct VerifiedFile {
    name: String,
    expected_sha256: String,
    size: u64,
    modified_ns: u128,
}

pub fn package_directory(cache_root: &Path) -> PathBuf {
    cache_root.join("voice-models").join(PACKAGE_ID)
}

fn sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 256 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn verify(directory: &Path, files: &[(&str, &str)]) -> Result<()> {
    for (name, expected) in files {
        let actual = sha256(&directory.join(name))?;
        if actual != *expected {
            return Err(anyhow!("{} checksum mismatch", name));
        }
    }
    Ok(())
}

fn file_stamps(directory: &Path, files: &[(&str, &str)], id: &str) -> Result<VerifiedPackage> {
    let files = files
        .iter()
        .map(|(name, expected_sha256)| {
            let path = directory.join(name);
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("cannot inspect {}", path.display()))?;
            if !metadata.file_type().is_file() {
                return Err(anyhow!("{} is not a regular file", name));
            }
            let modified_ns = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos();
            Ok(VerifiedFile {
                name: (*name).to_string(),
                expected_sha256: (*expected_sha256).to_string(),
                size: metadata.len(),
                modified_ns,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(VerifiedPackage {
        package_id: id.to_string(),
        files,
    })
}

fn write_marker(directory: &Path, marker: &VerifiedPackage) -> Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut temporary, marker)?;
    temporary.flush()?;
    temporary.persist(directory.join(VERIFIED_MARKER))?;
    Ok(())
}

fn verify_cached(directory: &Path, files: &[(&str, &str)], id: &str) -> Result<()> {
    let current = file_stamps(directory, files, id)?;
    let marker = fs::read(directory.join(VERIFIED_MARKER))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<VerifiedPackage>(&bytes).ok());
    if marker.as_ref() == Some(&current) {
        return Ok(());
    }
    verify(directory, files)?;
    if file_stamps(directory, files, id)? != current {
        return Err(anyhow!("model files changed during verification"));
    }
    write_marker(directory, &current)
}

pub fn status(cache_root: &Path) -> ModelPackageStatus {
    let directory = package_directory(cache_root);
    if !directory.exists() {
        return ModelPackageStatus {
            package_id: PACKAGE_ID,
            ready: false,
            detail: "尚未导入本地模型".into(),
        };
    }
    match verify_cached(&directory, &FILES, PACKAGE_ID) {
        Ok(()) => ModelPackageStatus {
            package_id: PACKAGE_ID,
            ready: true,
            detail: "本地模型已就绪，无需再次导入".into(),
        },
        Err(error) => ModelPackageStatus {
            package_id: PACKAGE_ID,
            ready: false,
            detail: format!("模型未就绪：{error}"),
        },
    }
}

fn source_directory(source: &Path, files: &[(&str, &str)]) -> Result<PathBuf> {
    let contains_files =
        |directory: &Path| files.iter().all(|(name, _)| directory.join(name).is_file());
    if contains_files(source) {
        return Ok(source.to_path_buf());
    }
    let extracted = source.join(EXTRACTED_DIR);
    if contains_files(&extracted) {
        return Ok(extracted);
    }
    let required = files
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join("、");
    Err(anyhow!(
        "所选目录 {} 缺少模型文件；请选择包含 {} 的解压文件夹，或其上一级目录",
        source.display(),
        required
    ))
}

fn import_verified(
    source: &Path,
    cache_root: &Path,
    files: &[(&str, &str)],
    id: &str,
) -> Result<()> {
    let source = source_directory(source, files)?;
    let parent = cache_root.join("voice-models");
    fs::create_dir_all(&parent)?;
    let parent = parent.canonicalize()?;
    let final_path = parent.join(id);
    if final_path.exists() {
        let metadata = fs::symlink_metadata(&final_path)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !final_path.canonicalize()?.starts_with(&parent)
        {
            return Err(anyhow!("模型缓存目录不在受管 voice-models 目录内"));
        }
    }
    if final_path.exists() && verify_cached(&final_path, files, id).is_ok() {
        return Ok(());
    }
    let stage = tempfile::Builder::new()
        .prefix("voice-model-stage-")
        .tempdir_in(&parent)?;
    for (name, _) in files {
        let metadata = fs::metadata(source.join(name))
            .with_context(|| format!("无法读取所选模型文件 {}", source.join(name).display()))?;
        if !metadata.is_file() {
            return Err(anyhow!("{} is not a regular file", name));
        }
        fs::copy(source.join(name), stage.path().join(name))
            .with_context(|| format!("复制模型文件 {} 失败", name))?;
    }
    verify(stage.path(), files)?;
    write_marker(stage.path(), &file_stamps(stage.path(), files, id)?)?;
    if final_path.exists() {
        let backup = tempfile::Builder::new()
            .prefix("voice-model-backup-")
            .tempdir_in(&parent)?;
        fs::remove_dir(backup.path())?;
        let backup_path = backup.keep();
        fs::rename(&final_path, &backup_path)?;
        if let Err(error) = fs::rename(stage.path(), &final_path) {
            fs::rename(&backup_path, &final_path).with_context(|| {
                format!(
                    "模型替换失败，原缓存保留在 {}，但无法自动恢复",
                    backup_path.display()
                )
            })?;
            return Err(error).context("模型替换失败，原缓存已恢复");
        }
        // Delete only this fixed package's known files. Unknown files remain visible
        // for recovery instead of silently being removed recursively.
        let cleanup = (|| -> Result<()> {
            let resolved = backup_path.canonicalize()?;
            if resolved.parent() != Some(parent.as_path()) {
                return Err(anyhow!("旧模型缓存路径逃逸"));
            }
            for name in files
                .iter()
                .map(|(name, _)| *name)
                .chain(std::iter::once(VERIFIED_MARKER))
            {
                let file = resolved.join(name);
                match fs::symlink_metadata(&file) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        fs::remove_file(&file)?
                    }
                    Ok(_) => return Err(anyhow!("旧模型缓存包含非普通文件 {}", file.display())),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
            }
            fs::remove_dir(&resolved)?;
            Ok(())
        })();
        cleanup.with_context(|| {
            format!("新模型已激活，但旧缓存无法清理：{}", backup_path.display())
        })?;
        return Ok(());
    }
    // Same-filesystem rename makes the package visible only after all checks pass.
    match fs::rename(stage.path(), &final_path) {
        Ok(()) => Ok(()),
        Err(error) if final_path.exists() => {
            verify_cached(&final_path, files, id).context(error.to_string())
        }
        Err(error) => Err(error.into()),
    }
}

pub fn import(source: &Path, cache_root: &Path) -> Result<ModelPackageStatus> {
    import_verified(source, cache_root, &FILES, PACKAGE_ID)?;
    Ok(status(cache_root))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_selection_names_all_required_files() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        assert!(!status(cache.path()).ready);
        let error = import(source.path(), cache.path()).unwrap_err().to_string();
        for (name, _) in FILES {
            assert!(error.contains(name));
        }
    }
    #[test]
    fn imports_verified_files_and_detects_cache_corruption() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("model.onnx"), b"verified").unwrap();
        let hash = sha256(&source.path().join("model.onnx")).unwrap();
        let files = [("model.onnx", hash.as_str())];
        import_verified(source.path(), cache.path(), &files, "test").unwrap();
        let target = cache.path().join("voice-models/test");
        verify_cached(&target, &files, "test").unwrap();
        fs::write(target.join("model.onnx"), b"corrupt").unwrap();
        assert!(verify_cached(&target, &files, "test").is_err());
        import_verified(source.path(), cache.path(), &files, "test").unwrap();
        verify_cached(&target, &files, "test").unwrap();
    }
    #[test]
    fn corrupt_source_never_activates() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("model.onnx"), b"corrupt").unwrap();
        assert!(import_verified(
            source.path(),
            cache.path(),
            &[("model.onnx", "wrong")],
            "test"
        )
        .is_err());
        assert!(!cache.path().join("voice-models/test").exists());
    }
    #[test]
    fn replacement_preserves_unknown_backup_files_and_reports_cleanup_failure() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("model.onnx"), b"verified").unwrap();
        let hash = sha256(&source.path().join("model.onnx")).unwrap();
        let files = [("model.onnx", hash.as_str())];
        let target = cache.path().join("voice-models/test");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("unrelated.txt"), b"keep").unwrap();
        let error = import_verified(source.path(), cache.path(), &files, "test")
            .unwrap_err()
            .to_string();
        assert!(error.contains("新模型已激活"));
        verify_cached(&target, &files, "test").unwrap();
        assert!(fs::read_dir(cache.path().join("voice-models"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.path().join("unrelated.txt").is_file()));
    }
}
