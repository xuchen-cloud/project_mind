//! Connection secrets live in private files in the current user's application data.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};

fn io_error() -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot access private connection credential storage",
    )
}
fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn missing() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Connection credential not found; create a connection in ProjectMind settings",
    )
}

pub(crate) struct FileCredentialStore {
    directory: PathBuf,
}
impl FileCredentialStore {
    /// The caller supplies the credential directory, without process-global configuration.
    pub(crate) fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }
    pub(crate) fn local() -> AgentResult<Self> {
        Ok(Self::new(
            super::local_data_dir()?.join("connection-credentials"),
        ))
    }
    fn path(&self, grant_id: &str) -> AgentResult<PathBuf> {
        if !valid_hex(grant_id, 32) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid connection ID",
            ));
        }
        Ok(self.directory.join(grant_id))
    }
    fn directory_exists(&self) -> AgentResult<bool> {
        match fs::symlink_metadata(&self.directory) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(io_error());
                }
                check_private(&metadata, 0o700)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(io_error()),
        }
    }
    fn ensure_directory(&self) -> AgentResult<()> {
        if !self.directory_exists()? {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            // A restored workspace may precede the first app-data session write.
            match builder.create(&self.directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(io_error()),
            }
            self.directory_exists()?;
        }
        Ok(())
    }
    fn file_metadata(&self, path: &std::path::Path) -> AgentResult<Option<fs::Metadata>> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => {
                check_private(&metadata, 0o600)?;
                Ok(Some(metadata))
            }
            Ok(_) => Err(io_error()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(io_error()),
        }
    }
    pub(crate) fn save(&self, grant_id: &str, token: &str) -> AgentResult<()> {
        let path = self.path(grant_id)?;
        if !valid_hex(token, 64) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid connection token",
            ));
        }
        self.ensure_directory()?;
        self.file_metadata(&path)?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|_| io_error())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| io_error())?;
        }
        temporary
            .write_all(token.as_bytes())
            .map_err(|_| io_error())?;
        temporary.as_file().sync_all().map_err(|_| io_error())?;
        temporary.persist(path).map_err(|_| io_error())?;
        self.sync_directory()
    }
    pub(crate) fn load_optional(&self, grant_id: &str) -> AgentResult<Option<String>> {
        let path = self.path(grant_id)?;
        if !self.directory_exists()? {
            return Ok(None);
        }
        let Some(expected) = self.file_metadata(&path)? else {
            return Ok(None);
        };
        let file = fs::File::open(path).map_err(|_| io_error())?;
        let actual = file.metadata().map_err(|_| io_error())?;
        if !actual.is_file() {
            return Err(io_error());
        }
        check_private(&actual, 0o600)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
                return Err(io_error());
            }
        }
        #[cfg(not(unix))]
        let _ = expected;
        let mut token = String::new();
        file.take(65)
            .read_to_string(&mut token)
            .map_err(|_| io_error())?;
        if !valid_hex(&token, 64) {
            return Err(io_error());
        }
        Ok(Some(token))
    }
    pub(crate) fn load(&self, grant_id: &str) -> AgentResult<String> {
        self.load_optional(grant_id)?.ok_or_else(missing)
    }
    pub(crate) fn delete(&self, grant_id: &str) -> AgentResult<()> {
        let path = self.path(grant_id)?;
        if !self.directory_exists()? || self.file_metadata(&path)?.is_none() {
            return Ok(());
        }
        fs::remove_file(path).map_err(|_| io_error())?;
        self.sync_directory()
    }
    fn sync_directory(&self) -> AgentResult<()> {
        #[cfg(unix)]
        // Include the path's parent entries when migration creates app data
        // for the first time. Repeat on retry after a partial sync failure.
        for directory in self.directory.ancestors() {
            fs::File::open(directory)
                .and_then(|file| file.sync_all())
                .map_err(|_| io_error())?;
        }
        Ok(())
    }
}
fn check_private(metadata: &fs::Metadata, mode: u32) -> AgentResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != mode {
            return Err(io_error());
        }
    }
    #[cfg(not(unix))]
    let _ = (metadata, mode);
    Ok(())
}
fn store() -> AgentResult<FileCredentialStore> {
    FileCredentialStore::local()
}
pub fn save(grant_id: &str, token: &str) -> AgentResult<()> {
    store()?.save(grant_id, token)
}
pub fn load(grant_id: &str) -> AgentResult<String> {
    store()?.load(grant_id)
}
pub fn load_optional(grant_id: &str) -> AgentResult<Option<String>> {
    store()?.load_optional(grant_id)
}
pub fn delete(grant_id: &str) -> AgentResult<()> {
    store()?.delete(grant_id)
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
