//! A native-only retained-version read plan. Authorization remains in the store;
//! byte reads, hashing and encoding execute after the shared database lock exits.
use super::*;
use crate::source_file_snapshot::{open_regular, FileStamp};
use std::{fs, io::Read, path::PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OfficeReadPlan {
    pub input: FileBytesInput,
    pub root: PathBuf,
    pub path: PathBuf,
    pub name: String,
}
pub(crate) struct OfficeRead {
    pub bytes: FileBytesResult,
    pub plan: OfficeReadPlan,
    stamp: FileStamp,
}
pub(crate) fn read_preview<S: BoundSourceStore>(store: &S, request: &RequestContext, input: &FileBytesInput) -> AgentResult<OfficeRead> {
    let plan = store.with_current(|binding, db| db.project_file_office_plan(request, binding, input))?;
    let limit = crate::db::project_directory_files::byte_limit(&plan.name) as u64;
    let captured = plan.capture_bounded(limit)?;
    verify(store, request, input, &captured)?;
    Ok(captured)
}
pub(crate) fn read<S: BoundSourceStore>(store: &S, request: &RequestContext, input: &FileBytesInput) -> AgentResult<OfficeRead> {
    let plan = store.with_current(|binding, db| db.project_file_office_plan(request, binding, input))?;
    let captured = plan.capture()?;
    verify(store, request, input, &captured)?;
    Ok(captured)
}
pub(crate) fn verify<S: BoundSourceStore>(store: &S, request: &RequestContext, input: &FileBytesInput, captured: &OfficeRead) -> AgentResult<()> {
    let check = || store.with_current(|binding, db| {
        let current = db.project_file_office_plan(request, binding, input)?;
        if current != captured.plan { return Err(read_error()); }
        Ok(())
    });
    check()?;
    captured.verify()?;
    check()
}
fn read_error() -> AgentError {
    error(ErrorCode::SourceChanged, "Retained Office bytes differ from the requested File Version")
}
impl OfficeReadPlan {
    fn check_path(&self) -> AgentResult<std::fs::Metadata> {
        crate::db::file_versions::relative(&self.root, &self.path)
            .map_err(|_| read_error())?;
        let metadata = fs::symlink_metadata(&self.path)
            .map_err(|_| error(ErrorCode::SourceNotReady, "Retained Office File Version is missing"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(read_error()); }
        if metadata.len() > MAX_CONTENT {
            return Err(error(ErrorCode::BudgetExceeded, "Office File exceeds 100 MiB"));
        }
        Ok(metadata)
    }
    pub fn capture(&self) -> AgentResult<OfficeRead> {
        self.capture_bounded(MAX_CONTENT)
    }
    fn capture_bounded(&self, limit: u64) -> AgentResult<OfficeRead> {
        let metadata = self.check_path()?;
        if metadata.len() > limit {
            return Err(error(ErrorCode::BudgetExceeded, "File exceeds its existing preview byte budget"));
        }
        let stamp = FileStamp::from_metadata(&metadata);
        let mut file = open_regular(&self.path)?;
        if FileStamp::from_metadata(&file.metadata().map_err(|_| read_error())?) != stamp {
            return Err(read_error());
        }
        let mut bytes = Vec::new();
        file.by_ref().take(limit + 1).read_to_end(&mut bytes).map_err(|_| read_error())?;
        if bytes.len() as u64 > limit {
            return Err(error(ErrorCode::BudgetExceeded, "File exceeds its existing preview byte budget"));
        }
        if FileStamp::from_metadata(&file.metadata().map_err(|_| read_error())?) != stamp
            || FileStamp::from_metadata(&self.check_path()?) != stamp
            || format!("sha256:{:x}", Sha256::digest(&bytes)) != self.input.expected_content_hash {
            return Err(read_error());
        }
        Ok(OfficeRead { bytes: FileBytesResult {
            object: self.input.object.clone(), version_number: self.input.version_number,
            content_hash: self.input.expected_content_hash.clone(),
            name: self.name.clone(), byte_length: bytes.len(),
            mime: mime_guess::from_path(&self.name).first_or_octet_stream().essence_str().into(),
            base64: STANDARD.encode(bytes),
        }, plan: self.clone(), stamp })
    }
}
impl OfficeRead {
    pub fn verify(&self) -> AgentResult<()> {
        let current = FileStamp::from_metadata(&self.plan.check_path()?);
        // Unix ctime detects same-size writes with restored mtime. Windows keeps
        // the existing full-content verification requirement at this boundary.
        if current != self.stamp || cfg!(windows) {
            let mut file = open_regular(&self.plan.path)?;
            let mut hash = Sha256::new();
            std::io::copy(&mut file.by_ref().take(MAX_CONTENT + 1), &mut hash)
                .map_err(|_| read_error())?;
            if format!("sha256:{:x}", hash.finalize()) != self.plan.input.expected_content_hash
                || FileStamp::from_metadata(&file.metadata().map_err(|_| read_error())?) != current
                || FileStamp::from_metadata(&self.plan.check_path()?) != current { return Err(read_error()); }
        }
        Ok(())
    }
}
