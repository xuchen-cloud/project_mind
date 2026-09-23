//! Fixed SenseVoice package activation. Only verified files enter the app cache.
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

pub const PACKAGE_ID: &str = "sensevoice-small-int8-2024-07-17";
const FILES: [(&str, &str); 3] = [
    (
        "model.int8.onnx",
        "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    ),
    (
        "tokens.txt",
        "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
    ),
    (
        "LICENSE",
        "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17",
    ),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPackageStatus {
    pub package_id: &'static str,
    pub ready: bool,
    pub detail: String,
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

pub fn status(cache_root: &Path) -> ModelPackageStatus {
    let directory = package_directory(cache_root);
    match verify(&directory, &FILES) {
        Ok(()) => ModelPackageStatus {
            package_id: PACKAGE_ID,
            ready: true,
            detail: "模型文件已校验".into(),
        },
        Err(error) => ModelPackageStatus {
            package_id: PACKAGE_ID,
            ready: false,
            detail: format!("模型未就绪：{error}"),
        },
    }
}

fn import_verified(
    source: &Path,
    cache_root: &Path,
    files: &[(&str, &str)],
    id: &str,
) -> Result<()> {
    let parent = cache_root.join("voice-models");
    fs::create_dir_all(&parent)?;
    let final_path = parent.join(id);
    if final_path.exists() {
        return verify(&final_path, files);
    }
    let stage = tempfile::Builder::new()
        .prefix("voice-model-stage-")
        .tempdir_in(&parent)?;
    for (name, _) in files {
        let metadata = fs::metadata(source.join(name))?;
        if !metadata.is_file() {
            return Err(anyhow!("{} is not a regular file", name));
        }
        fs::copy(source.join(name), stage.path().join(name))?;
    }
    verify(stage.path(), files)?;
    // Same-filesystem rename makes the package visible only after all checks pass.
    match fs::rename(stage.path(), &final_path) {
        Ok(()) => Ok(()),
        Err(error) if final_path.exists() => verify(&final_path, files).context(error.to_string()),
        Err(error) => Err(error.into()),
    }
}

pub fn import_sense_voice(source: &Path, cache_root: &Path) -> Result<ModelPackageStatus> {
    import_verified(source, cache_root, &FILES, PACKAGE_ID)?;
    Ok(status(cache_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_corrupt_package_without_activating_it_then_imports_verified_files() {
        let source = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(source.path().join("model.int8.onnx"), b"model").unwrap();
        fs::write(source.path().join("tokens.txt"), b"bad").unwrap();
        let model_hash = sha256(&source.path().join("model.int8.onnx")).unwrap();
        let token_hash = Sha256::digest(b"tokens");
        let token_hash = format!("{token_hash:x}");
        let files = [
            ("model.int8.onnx", model_hash.as_str()),
            ("tokens.txt", token_hash.as_str()),
        ];
        assert!(import_verified(source.path(), cache.path(), &files, "test").is_err());
        assert!(!cache.path().join("voice-models/test").exists());
        fs::write(source.path().join("tokens.txt"), b"tokens").unwrap();
        import_verified(source.path(), cache.path(), &files, "test").unwrap();
        assert!(verify(&cache.path().join("voice-models/test"), &files).is_ok());
        fs::write(source.path().join("tokens.txt"), b"changed").unwrap();
        import_verified(source.path(), cache.path(), &files, "test").unwrap();
        assert_eq!(
            fs::read(cache.path().join("voice-models/test/tokens.txt")).unwrap(),
            b"tokens"
        );
    }
}
