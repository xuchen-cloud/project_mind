//! Small, local-only operation counters. Labels are fixed by callers and never
//! derived from prompts, source names, paths, or provider output.
use crate::agent::errors::{AgentResult, ErrorCode};
use crate::workspace::WorkspacePaths;
use serde_json::json;
use std::{fs::OpenOptions, io::Write, sync::Mutex, time::Instant};

static WRITE_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1024 * 1024;

pub(crate) fn record<T>(
    paths: &WorkspacePaths,
    operation: &'static str,
    started: Instant,
    result: &AgentResult<T>,
    count: usize,
) {
    let outcome = result.as_ref().err().map(|error| error.code);
    record_outcome(paths, operation, started, outcome, count);
}

pub(crate) fn record_outcome(
    paths: &WorkspacePaths,
    operation: &'static str,
    started: Instant,
    error: Option<ErrorCode>,
    count: usize,
) {
    let line = json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "operation": operation,
        "result": error.map_or_else(|| json!("OK"), |code| json!(code)),
        "durationMs": started.elapsed().as_millis(),
        "count": if error.is_some() { 0 } else { count },
    });
    let attempt = || -> std::io::Result<()> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::fs::create_dir_all(&paths.log_dir)?;
        let path = paths.log_dir.join("ai-operations.jsonl");
        if path.metadata().is_ok_and(|metadata| metadata.len() >= MAX_BYTES) {
            let previous = paths.log_dir.join("ai-operations.previous.jsonl");
            if previous.exists() { std::fs::remove_file(&previous)?; }
            std::fs::rename(&path, previous)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{line}")
    };
    if attempt().is_err() {
        eprintln!("AI local diagnostic write failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_log_writes_stable_result_and_rotates_twice() {
        let root = tempfile::tempdir().unwrap();
        let paths = crate::workspace::workspace_paths(root.path());
        let current = paths.log_dir.join("ai-operations.jsonl");
        let previous = paths.log_dir.join("ai-operations.previous.jsonl");
        record_outcome(&paths, "source.read", Instant::now(), Some(ErrorCode::SourceChanged), 17);
        let entry: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&current).unwrap()).unwrap();
        assert_eq!(entry["result"], "SOURCE_CHANGED");
        assert_eq!(entry["count"], 0);
        for _ in 0..2 {
            std::fs::write(&current, vec![b' '; MAX_BYTES as usize]).unwrap();
            record_outcome(&paths, "source.read", Instant::now(), None, 2);
            assert!(previous.exists());
            let entry: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&current).unwrap()).unwrap();
            assert_eq!(entry["result"], "OK");
            assert_eq!(entry["count"], 2);
        }
    }
}
