//! Read-only access to already persisted session checkpoints. No runtime, model,
//! session creation or index discovery is involved.
use super::{
    history_cursor_json, history_cursor_offset, SessionHistoryFragment, SessionHistoryUtility,
};
use crate::{
    agent::{
        access::RequestContext,
        conversation::SessionCheckpoint,
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    db::agent_session_model_search::SourceReadRecord,
    source_file_snapshot::{open_regular, FileStamp},
    source_service::BoundSourceStore,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const CHECKPOINT_BYTES: usize = 64 * 1024 * 1024;
const ENTRY_BYTES: usize = 16 * 1024 * 1024;
const READ_TIME: Duration = Duration::from_secs(30);

fn changed() -> AgentError {
    AgentError::new(ErrorCode::SourceChanged, "Archived session source changed")
}
fn invalid() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "Archived session checkpoint is invalid",
    )
}
fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Archive path is outside its Workspace session directory",
    )
}
fn deadline() -> AgentError {
    AgentError::new(
        ErrorCode::BudgetExceeded,
        "Archived session read exceeded its limit",
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) struct ArchivalHistory<'a, S> {
    store: &'a S,
    request: &'a RequestContext,
    root: PathBuf,
}
impl<'a, S: BoundSourceStore> ArchivalHistory<'a, S> {
    pub(crate) fn new(store: &'a S, request: &'a RequestContext, root: PathBuf) -> Self {
        Self {
            store,
            request,
            root,
        }
    }

    fn checkpoint(
        &self,
        binding: &WorkspaceBinding,
        record: &SourceReadRecord,
    ) -> AgentResult<SessionCheckpoint> {
        self.store.with_current(|current, db| {
            if current != binding {
                return Err(AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Workspace binding changed",
                ));
            }
            self.request
                .authorize(current, &record.scope, "source.read")?;
            let actual = db.agent_model_session_message_record(
                self.request,
                current,
                &record.session_id,
                &record.message_id,
            )?;
            if actual != *record {
                return Err(changed());
            }
            let snapshot =
                db.agent_session_get(self.request, current, &record.session_id, None, 1)?;
            if snapshot.session.runtime_id != "builtin-pi" || snapshot.session.scope != record.scope
            {
                return Err(changed());
            }
            snapshot.checkpoint.ok_or_else(|| {
                AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Archived session checkpoint is missing",
                )
            })
        })
    }
}

impl<S: BoundSourceStore + Sync> SessionHistoryUtility for ArchivalHistory<'_, S> {
    async fn read(
        &self,
        binding: &WorkspaceBinding,
        record: &SourceReadRecord,
        cursor: Option<&str>,
        max_chars: u32,
    ) -> AgentResult<SessionHistoryFragment> {
        if !(1..=12_000).contains(&max_chars) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid archive page budget",
            ));
        }
        let start = history_cursor_offset(cursor, record)?;
        let checkpoint = self.checkpoint(binding, record)?;
        let root = self.root.clone();
        let expected = checkpoint.clone();
        let record_copy = record.clone();
        let fragment = tokio::time::timeout(
            READ_TIME,
            tokio::task::spawn_blocking(move || {
                read_archive(&root, &expected, &record_copy, start, max_chars)
            }),
        )
        .await
        .map_err(|_| deadline())?
        .map_err(|_| invalid())??;
        if self.checkpoint(binding, record)? != checkpoint {
            return Err(changed());
        }
        Ok(fragment)
    }
}

fn archive_directory(root: &Path, session_id: &str) -> AgentResult<PathBuf> {
    if session_id.len() != 32
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(denied());
    }
    let mut directory = root.canonicalize().map_err(|_| denied())?;
    for part in [".project-mind", "agent", "sessions", session_id] {
        directory.push(part);
        let metadata = fs::symlink_metadata(&directory).map_err(|_| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Archived session directory is missing",
            )
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(denied());
        }
    }
    Ok(directory)
}

fn read_regular(path: &Path, limit: usize, end: Instant) -> AgentResult<(Vec<u8>, FileStamp)> {
    let before = fs::symlink_metadata(path).map_err(|_| changed())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(denied());
    }
    if before.len() > limit as u64 {
        return Err(deadline());
    }
    let stamp = FileStamp::from_metadata(&before);
    let mut file = open_regular(path)?;
    if FileStamp::from_metadata(&file.metadata().map_err(|_| changed())?) != stamp {
        return Err(changed());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        if Instant::now() >= end {
            return Err(deadline());
        }
        let count = file.read(&mut chunk).map_err(|_| changed())?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > limit {
            return Err(deadline());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 != before.len()
        || FileStamp::from_metadata(&file.metadata().map_err(|_| changed())?) != stamp
        || FileStamp::from_metadata(&fs::symlink_metadata(path).map_err(|_| changed())?) != stamp
    {
        return Err(changed());
    }
    Ok((bytes, stamp))
}

fn read_archive(
    root: &Path,
    checkpoint: &SessionCheckpoint,
    record: &SourceReadRecord,
    start: u32,
    max_chars: u32,
) -> AgentResult<SessionHistoryFragment> {
    let end = Instant::now() + READ_TIME;
    if checkpoint.schema_version != 1
        || checkpoint.bytes > CHECKPOINT_BYTES as u64
        || checkpoint.offset != checkpoint.bytes
    {
        return Err(invalid());
    }
    let directory = archive_directory(root, &record.session_id)?;
    let (metadata, _) = read_regular(&directory.join("checkpoint.json"), 16 * 1024, end)?;
    let stored: SessionCheckpoint = serde_json::from_slice(&metadata).map_err(|_| invalid())?;
    if stored != *checkpoint {
        return Err(changed());
    }
    let (bytes, stamp) = read_regular(&directory.join("session.jsonl"), CHECKPOINT_BYTES, end)?;
    if bytes.len() as u64 != checkpoint.bytes || hash(&bytes) != checkpoint.checksum {
        return Err(changed());
    }
    if archive_directory(root, &record.session_id)? != directory {
        return Err(changed());
    }
    let fragment = decode(&bytes, checkpoint, record, start, max_chars, end)?;
    // The receipt and source file must still describe this same read.
    if read_regular(&directory.join("checkpoint.json"), 16 * 1024, end)?.0 != metadata
        || FileStamp::from_metadata(
            &fs::symlink_metadata(directory.join("session.jsonl")).map_err(|_| changed())?,
        ) != stamp
    {
        return Err(changed());
    }
    archive_directory(root, &record.session_id)?;
    #[cfg(windows)]
    if read_regular(&directory.join("session.jsonl"), CHECKPOINT_BYTES, end)?.0 != bytes {
        return Err(changed());
    }
    Ok(fragment)
}

fn entry_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.as_bytes()[id.len() - 1].is_ascii_alphanumeric()
}
fn portable_path(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("workspace:"))
        .is_some_and(|path| {
            !path.contains(['\\', ':', '\0'])
                && (path == "." || !path.split('/').any(|part| matches!(part, "" | "." | "..")))
        })
}
fn timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
}
fn text_of(message: &Value) -> String {
    if message["role"] != "user"
        && (message["role"] != "assistant"
            || !matches!(message["stopReason"].as_str(), Some("stop" | "toolUse")))
    {
        return String::new();
    }
    if let Some(text) = message["content"].as_str() {
        return text.to_owned();
    }
    message["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect()
        })
        .unwrap_or_default()
}

fn decode(
    bytes: &[u8],
    checkpoint: &SessionCheckpoint,
    record: &SourceReadRecord,
    start: u32,
    max_chars: u32,
    end: Instant,
) -> AgentResult<SessionHistoryFragment> {
    if bytes.last() != Some(&b'\n') {
        return Err(invalid());
    }
    let mut lines = bytes[..bytes.len() - 1].split(|b| *b == b'\n');
    let parse = |line: &[u8]| -> AgentResult<Value> {
        if line.is_empty() || line.len() > ENTRY_BYTES {
            return Err(invalid());
        }
        serde_json::from_slice(line).map_err(|_| invalid())
    };
    let header = parse(lines.next().ok_or_else(invalid)?)?;
    if header["type"] != "session"
        || header["version"] != 3
        || header["id"] != record.session_id
        || !timestamp(&header["timestamp"])
        || !portable_path(&header["cwd"])
        || header
            .get("parentSession")
            .is_some_and(|value| !portable_path(value))
    {
        return Err(invalid());
    }
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut found = None;
    for line in lines {
        if Instant::now() >= end {
            return Err(deadline());
        }
        let entry = parse(line)?;
        let id = entry["id"]
            .as_str()
            .filter(|id| entry_id(id))
            .ok_or_else(invalid)?;
        if counts.contains_key(id) || !timestamp(&entry["timestamp"]) {
            return Err(invalid());
        }
        let parent_count = match entry.get("parentId") {
            Some(Value::Null) => 0,
            Some(Value::String(parent)) => *counts.get(parent).ok_or_else(invalid)?,
            _ => return Err(invalid()),
        };
        for key in ["targetId", "firstKeptEntryId"] {
            if let Some(value) = entry.get(key).filter(|v| !v.is_null()) {
                if !value.as_str().is_some_and(|id| counts.contains_key(id)) {
                    return Err(invalid());
                }
            }
        }
        let kind = entry["type"].as_str().ok_or_else(invalid)?;
        if !matches!(
            kind,
            "message"
                | "thinking_level_change"
                | "model_change"
                | "usage"
                | "compaction"
                | "branch_summary"
                | "custom"
                | "custom_message"
                | "context_edit"
                | "label"
                | "session_info"
        ) {
            return Err(invalid());
        }
        let message = &entry["message"];
        let projected = kind == "message"
            && matches!(
                message["role"].as_str(),
                Some("user" | "assistant" | "toolResult")
            );
        if id == record.runtime_entry_id {
            let identity = format!(
                "{:x}",
                Sha256::digest(format!("{}:{id}", record.session_id).as_bytes())
            );
            let text = text_of(message);
            if !projected
                || message["role"] != record.role
                || identity[..32] != record.message_id
                || parent_count != record.ordinal
                || text.is_empty()
                || hash(text.as_bytes()) != record.text_hash
                || text.chars().count() as u64 != u64::from(record.total_chars)
            {
                return Err(changed());
            }
            found = Some(text);
        }
        counts.insert(id.to_owned(), parent_count + u64::from(projected));
    }
    let leaf_count = match &checkpoint.leaf_id {
        Some(id) => *counts.get(id).ok_or_else(invalid)?,
        None => 0,
    };
    if checkpoint.entry_count != counts.len() as u64 || checkpoint.message_count != leaf_count {
        return Err(invalid());
    }
    let text = found.ok_or_else(changed)?;
    if start >= record.total_chars || !(1..=12_000).contains(&max_chars) {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Archived history range is invalid",
        ));
    }
    let stop = start.saturating_add(max_chars).min(record.total_chars);
    Ok(SessionHistoryFragment {
        session_id: record.session_id.clone(),
        message_id: record.message_id.clone(),
        runtime_entry_id: record.runtime_entry_id.clone(),
        ordinal: record.ordinal,
        content_hash: record.text_hash.clone(),
        text: text
            .chars()
            .skip(start as usize)
            .take((stop - start) as usize)
            .collect(),
        char_start: start,
        char_end: stop,
        total_chars: record.total_chars,
        next_cursor: if stop < record.total_chars {
            Some(history_cursor_json(
                &record.runtime_entry_id,
                &record.message_id,
                stop,
            )?)
        } else {
            None
        },
    })
}

#[cfg(test)]
#[path = "source_session_archive_tests.rs"]
mod tests;
