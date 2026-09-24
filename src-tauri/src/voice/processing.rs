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
                    let payload = ai_provider::run_voice_minutes(
                        &profile,
                        input.previous_content.as_deref(),
                        &lines,
                    )?;
                    db.voice_minutes_apply(
                        &session_id,
                        input.expected_version,
                        input.source_max_rowid,
                        &payload.content,
                        &payload.title,
                    )
                })();
                let error = result.as_ref().err().map(ToString::to_string);
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
