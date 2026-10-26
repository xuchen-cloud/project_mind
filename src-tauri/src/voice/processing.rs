//! Background cumulative minutes. Audio and final Transcript never wait on the text model.
use crate::{ai_provider, db::Database};
use anyhow::Result;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};

/// Serializes claim/commit against Workspace close, without holding the gate
/// across model I/O. Cancellation is terminal for this Workspace generation.
pub(crate) struct MinutesWorker {
    state: Mutex<WorkerState>,
    cancel: tokio::sync::watch::Sender<bool>,
}

#[derive(Default)]
struct WorkerState {
    running: bool,
    cancelled: bool,
}

impl Default for MinutesWorker {
    fn default() -> Self {
        Self {
            state: Mutex::new(WorkerState::default()),
            cancel: tokio::sync::watch::channel(false).0,
        }
    }
}

impl MinutesWorker {
    pub(crate) fn cancel(&self) {
        let mut state = crate::lock_mutex(&self.state);
        state.cancelled = true;
        self.cancel.send_replace(true);
    }

    fn active<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let state = crate::lock_mutex(&self.state);
        if state.cancelled {
            anyhow::bail!("Workspace 已关闭，会议纪要已暂停");
        }
        action()
    }
}

pub(crate) fn kick(
    db_path: PathBuf,
    workspace_root: PathBuf,
    secret_state: Arc<Mutex<Option<String>>>,
    worker: Arc<MinutesWorker>,
) {
    {
        let mut state = crate::lock_mutex(&worker.state);
        if state.running || state.cancelled {
            return;
        }
        state.running = true;
    }
    thread::spawn(move || {
        let result = (|| -> Result<()> {
            let secret = crate::lock_mutex(&secret_state).clone();
            let mut db = Database::open_runtime_connection(&db_path, &workspace_root, secret)?;
            db.bind_native_workspace(
                &crate::workspace::load_metadata(&workspace_root)?
                    .0
                    .workspace_id,
            )?;
            loop {
                // Claim and the idle transition share the kick/close gate. An
                // enqueue racing with idle either belongs to this loop or starts
                // the next worker; its wake can never be discarded.
                let job = {
                    let mut state = crate::lock_mutex(&worker.state);
                    if state.cancelled {
                        return Ok(());
                    }
                    let job = db.voice_minutes_claim_owned()?;
                    if job.is_none() {
                        state.running = false;
                    }
                    job
                };
                let Some((job_id, session_id, lease)) = job else {
                    return Ok(());
                };
                let result = (|| -> Result<()> {
                    let input = worker.active(|| db.voice_minutes_input(&session_id))?;
                    if input.segments.is_empty() {
                        return Ok(());
                    }
                    let profile = worker.active(|| db.voice_minutes_profile())?;
                    let lines = input
                        .segments
                        .into_iter()
                        .map(|segment| (segment.start_ms, segment.text))
                        .collect::<Vec<_>>();
                    let mut last_preview = std::time::Instant::now();
                    let mut last_preview_content = String::new();
                    let mut preview_error = None;
                    let payload = ai_provider::run_voice_minutes_cancellable(
                        &profile,
                        input.previous_content.as_deref(),
                        &lines,
                        worker.cancel.subscribe(),
                        &mut |preview| {
                            if preview != last_preview_content
                                && (preview.is_empty()
                                    || last_preview_content.is_empty()
                                    || last_preview.elapsed().as_millis() >= 250)
                            {
                                if let Err(error) = worker
                                    .active(|| db.voice_minutes_update_preview(job_id, &preview))
                                {
                                    preview_error = Some(error);
                                }
                                last_preview = std::time::Instant::now();
                                last_preview_content = preview;
                            }
                        },
                    )?;
                    if let Some(error) = preview_error {
                        return Err(error);
                    }
                    worker.active(|| {
                        db.voice_minutes_apply(
                            &session_id,
                            input.expected_version,
                            input.source_max_rowid,
                            &payload.content,
                            &payload.title,
                        )
                    })
                })();
                // A cancelled request retains its job key and Transcript rowid
                // watermark. Reopen may safely resume it, without a partial apply.
                let state = crate::lock_mutex(&worker.state);
                if state.cancelled {
                    db.voice_minutes_release_job(job_id, &lease)?;
                    return Ok(());
                }
                let error = result.as_ref().err().map(minutes_error_message);
                db.voice_minutes_finish_job(job_id, error.as_deref())?;
            }
        })();
        if let Err(error) = result {
            eprintln!("voice minutes worker failed: {error:#}");
            crate::lock_mutex(&worker.state).running = false;
        }
        super::supervision::wake();
    });
}

fn minutes_error_message(error: &anyhow::Error) -> String {
    let detail = format!("{error:#}");
    if let Some(network) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<reqwest::Error>())
    {
        if network.is_timeout() {
            return format!("会议纪要生成请求超时，请稍后重试。{detail}");
        }
        if network.is_connect() {
            return format!("无法连接文本模型服务，请检查网络和服务地址。{detail}");
        }
    }
    detail
}

#[cfg(test)]
mod tests {
    #[test]
    fn closed_workspace_cannot_start_or_commit_minutes() {
        let worker = std::sync::Arc::new(super::MinutesWorker::default());
        worker.cancel();
        let touched = std::sync::atomic::AtomicBool::new(false);
        assert!(worker
            .active(|| {
                touched.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            })
            .is_err());
        assert!(!touched.load(std::sync::atomic::Ordering::Relaxed));
        let root = tempfile::tempdir().unwrap();
        super::kick(
            root.path().join("must-not-open.sqlite"),
            root.path().into(),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            worker.clone(),
        );
        assert!(!crate::lock_mutex(&worker.state).running);
        assert!(!root.path().join("must-not-open.sqlite").exists());
    }

    #[test]
    fn minutes_failure_keeps_the_underlying_cause() {
        let error = anyhow::anyhow!("operation timed out")
            .context("failed to call OpenAI-compatible provider");
        let message = super::minutes_error_message(&error);
        assert!(message.contains("failed to call OpenAI-compatible provider"));
        assert!(message.contains("operation timed out"));
    }
}
