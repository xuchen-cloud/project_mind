//! Background cumulative minutes. Audio and final Transcript never wait on the text model.
use crate::{ai_provider, db::Database};
use anyhow::Result;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

pub fn kick(
    db_path: PathBuf,
    workspace_root: PathBuf,
    secret_state: Arc<Mutex<Option<String>>>,
    running: Arc<AtomicBool>,
) {
    if running.swap(true, Ordering::AcqRel) {
        return;
    }
    thread::spawn(move || {
        let result = (|| -> Result<()> {
            let secret = secret_state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let mut db = Database::open(&db_path, &workspace_root, secret)?;
            while let Some((job_id, session_id)) = db.voice_minutes_claim_next()? {
                let result = (|| -> Result<()> {
                    let input = db.voice_minutes_input(&session_id)?;
                    if input.segments.is_empty() {
                        return Ok(());
                    }
                    let profile = db.voice_minutes_profile()?;
                    let lines = input
                        .segments
                        .into_iter()
                        .map(|segment| (segment.start_ms, segment.text))
                        .collect::<Vec<_>>();
                    let mut last_preview = std::time::Instant::now();
                    let mut last_preview_content = String::new();
                    let mut preview_error = None;
                    let payload = ai_provider::run_voice_minutes_streaming(
                        &profile,
                        input.previous_content.as_deref(),
                        &lines,
                        &mut |preview| {
                            if preview != last_preview_content
                                && (preview.is_empty()
                                    || last_preview_content.is_empty()
                                    || last_preview.elapsed().as_millis() >= 250)
                            {
                                if let Err(error) =
                                    db.voice_minutes_update_preview(job_id, &preview)
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
                    db.voice_minutes_apply(
                        &session_id,
                        input.expected_version,
                        input.source_max_rowid,
                        &payload.content,
                        &payload.title,
                    )
                })();
                let error = result.as_ref().err().map(minutes_error_message);
                db.voice_minutes_finish_job(job_id, error.as_deref())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("voice minutes worker failed: {error}");
        }
        running.store(false, Ordering::Release);
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
    fn minutes_failure_keeps_the_underlying_cause() {
        let error = anyhow::anyhow!("operation timed out")
            .context("failed to call OpenAI-compatible provider");
        let message = super::minutes_error_message(&error);
        assert!(message.contains("failed to call OpenAI-compatible provider"));
        assert!(message.contains("operation timed out"));
    }
}
