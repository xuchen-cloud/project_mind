//! One paid DSH nonce/tool diagnostic. The command owner records the receipt
//! after rechecking the initiating Workspace binding and Profile fingerprint.
use super::errors::{AgentError, AgentResult, ErrorCode};
use crate::{
    ai_provider::ResolvedAiProfile,
    dsh_model::{self, ModelRuntime},
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tokio::{sync::watch, time::Instant};

const PROBE_SECONDS: u64 = 60;

struct ClearProfile(ResolvedAiProfile);
impl Drop for ClearProfile {
    fn drop(&mut self) {
        self.0.api_key.clear();
    }
}

fn cancelled() -> AgentError {
    AgentError::new(ErrorCode::Cancelled, "Profile probe was cancelled")
}
fn timed_out() -> AgentError {
    AgentError::new(ErrorCode::BudgetExceeded, "Profile probe timed out")
}
fn verified(data: Value) -> AgentResult<()> {
    if data["toolCallingVerified"] != true {
        return Err(AgentError::new(
            ErrorCode::ToolCallUnsupported,
            "Profile tool round trip was not verified",
        ));
    }
    Ok(())
}

pub(crate) async fn verify(
    app: &tauri::AppHandle,
    root: &Path,
    profile: ResolvedAiProfile,
    mut cancel: watch::Receiver<bool>,
) -> AgentResult<()> {
    let deadline = Instant::now() + Duration::from_secs(PROBE_SECONDS);
    let mut profile = ClearProfile(profile);
    // The utility receives only the Profile. It has no Workspace/session access.
    if !root.is_dir() {
        return Err(AgentError::new(
            ErrorCode::IoFailed,
            "Profile probe Workspace is unavailable",
        ));
    }
    let app = app.clone();
    let runtime = tokio::select! {
        biased;
        _ = dsh_model::cancelled_watch(&mut cancel) => return Err(cancelled()),
        _ = tokio::time::sleep_until(deadline) => return Err(timed_out()),
        result = tokio::task::spawn_blocking(move || ModelRuntime::for_app(&app)) => {
            result.map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare Profile probe"))??
        }
    };
    let data = runtime
        .call(
            "probe",
            &mut profile.0,
            json!({}),
            deadline,
            Some(&mut cancel),
        )
        .await
        .map_err(|error| {
            if error.code == ErrorCode::TimedOut {
                timed_out()
            } else {
                error
            }
        })?;
    verified(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_probe_requires_explicit_completed_tool_roundtrip() {
        assert!(verified(json!({"toolCallingVerified":true})).is_ok());
        for data in [
            json!({}),
            json!({"toolCallingVerified":false}),
            json!({"toolCallingVerified":"true"}),
            json!({"text":"nonce"}),
        ] {
            assert_eq!(
                verified(data).unwrap_err().code,
                ErrorCode::ToolCallUnsupported
            );
        }
    }

    #[tokio::test]
    async fn profile_probe_cancellation_covers_already_cancelled_and_sender_dropped() {
        let (sender, mut receiver) = watch::channel(true);
        tokio::time::timeout(
            Duration::from_secs(1),
            dsh_model::cancelled_watch(&mut receiver),
        )
        .await
        .unwrap();
        drop(sender);
        let (sender, mut receiver) = watch::channel(false);
        drop(sender);
        tokio::time::timeout(
            Duration::from_secs(1),
            dsh_model::cancelled_watch(&mut receiver),
        )
        .await
        .unwrap();
    }
}
