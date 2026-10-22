//! Short-lived, tool-free DSH generation for native Overview publication.
use crate::dsh_model::ModelRuntime;
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    ai_provider::ResolvedAiProfile,
    AppState,
};
use serde_json::{json, Value};
use std::{future::Future, path::PathBuf, time::Duration};
use tauri::Manager;
use tokio::time::{timeout_at, Instant};

const GENERATION_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const MAX_OVERVIEW_INPUT_BYTES: usize = crate::dsh_model::MAX_REQUEST_BYTES / 8;
const OUTPUT_CHARACTERS: usize = 24_000;

#[derive(Debug, Clone)]
pub(crate) struct GeneratedOverview {
    pub text: String,
    pub model_profile_id: String,
    pub usage: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct OverviewBudget {
    pub input_bytes: usize,
    pub context_window: usize,
    pub max_tokens: usize,
    pub fingerprint: String,
    pub source: String,
}

impl OverviewBudget {
    fn require_profile(&self, fingerprint: &str) -> AgentResult<()> {
        if fingerprint != self.fingerprint {
            return Err(AgentError::new(
                ErrorCode::ProfileUnavailable,
                "Selected model changed after Overview preparation",
            ));
        }
        Ok(())
    }

    pub fn check(&self, prompt: &str) -> AgentResult<()> {
        if prompt.len() > self.input_bytes || prompt.len() > MAX_OVERVIEW_INPUT_BYTES {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Overview prompt exceeds model input budget",
            ));
        }
        Ok(())
    }
}

fn fallback_budget() -> OverviewBudget {
    OverviewBudget {
        input_bytes: 26_000,
        context_window: 32768,
        max_tokens: 4096,
        fingerprint: String::new(),
        source: "fallback".into(),
    }
}

pub(crate) trait OverviewModel: Send + Sync {
    fn prepare(&self) -> impl Future<Output = AgentResult<OverviewBudget>> + Send {
        async { Ok(fallback_budget()) }
    }

    fn generate(
        &self,
        batch_id: &str,
        prompt: &str,
        budget: &OverviewBudget,
    ) -> impl Future<Output = AgentResult<GeneratedOverview>> + Send;
}

pub(crate) struct AppOverviewModel {
    app: tauri::AppHandle,
    binding: WorkspaceBinding,
}

struct ClearProfile(ResolvedAiProfile);
impl Drop for ClearProfile {
    fn drop(&mut self) {
        self.0.api_key.clear();
    }
}

impl AppOverviewModel {
    pub(crate) fn new(app: tauri::AppHandle, binding: WorkspaceBinding) -> Self {
        Self { app, binding }
    }

    fn current_profile(&self) -> AgentResult<(PathBuf, ResolvedAiProfile, String)> {
        let state = self.app.state::<AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let runtime = current.as_ref().ok_or_else(workspace_changed)?;
        if runtime.agent_binding != self.binding {
            return Err(workspace_changed());
        }
        let db = crate::lock_mutex(&runtime.db);
        let selected = db.agent_resolve_profile(None)?;
        Ok((
            runtime.paths.root_path.clone(),
            selected.profile,
            selected.fingerprint,
        ))
    }

    fn require_current(&self, root: &PathBuf, fingerprint: &str) -> AgentResult<()> {
        let (current_root, selected, current_fingerprint) = self.current_profile()?;
        let _profile = ClearProfile(selected);
        require_identity(root, fingerprint, &current_root, &current_fingerprint)
    }
}

fn require_identity(
    root: &PathBuf,
    fingerprint: &str,
    current_root: &PathBuf,
    current_fingerprint: &str,
) -> AgentResult<()> {
    if current_root != root {
        return Err(workspace_changed());
    }
    if current_fingerprint != fingerprint {
        return Err(AgentError::new(
            ErrorCode::ProfileUnavailable,
            "Selected model changed during Overview generation",
        ));
    }
    Ok(())
}

impl OverviewModel for AppOverviewModel {
    async fn prepare(&self) -> AgentResult<OverviewBudget> {
        let deadline = Instant::now() + GENERATION_TIMEOUT;
        let (root, selected, fingerprint) = self.current_profile()?;
        let mut profile = ClearProfile(selected);
        // Capacity does not need a provider credential.
        profile.0.api_key.clear();
        let app = self.app.clone();
        let packaged = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || ModelRuntime::for_app(&app)),
        )
        .await
        .map_err(|_| timed_out())?
        .map_err(|_| incompatible())??;
        self.require_current(&root, &fingerprint)?;
        let result = packaged
            .call("capacity", &mut profile.0, json!({}), deadline, None)
            .await;
        self.require_current(&root, &fingerprint)?;
        capacity_budget(result?, fingerprint)
    }

    async fn generate(
        &self,
        batch_id: &str,
        prompt: &str,
        budget: &OverviewBudget,
    ) -> AgentResult<GeneratedOverview> {
        validate_input(batch_id, prompt, budget)?;
        let (root, selected, fingerprint) = self.current_profile()?;
        let mut initial = ClearProfile(selected);
        initial.0.api_key.clear();
        budget.require_profile(&fingerprint)?;
        let deadline = Instant::now() + GENERATION_TIMEOUT;
        let app = self.app.clone();
        let packaged = timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || ModelRuntime::for_app(&app)),
        )
        .await
        .map_err(|_| timed_out())?
        .map_err(|_| incompatible())??;
        let (current_root, selected, current_fingerprint) = self.current_profile()?;
        let mut profile = ClearProfile(selected);
        require_identity(&root, &fingerprint, &current_root, &current_fingerprint)?;
        let result = packaged.call("generate", &mut profile.0, json!({
            "prompt":prompt,
            "capacity":{"contextWindow":budget.context_window,"maxTokens":budget.max_tokens,"source":budget.source}
        }), deadline, None).await;
        self.require_current(&root, &fingerprint)?;
        let (text, usage) = generation_output(result?)?;
        Ok(GeneratedOverview {
            text,
            model_profile_id: fingerprint,
            usage,
        })
    }
}

fn positive_usize(data: &Value, field: &str) -> AgentResult<usize> {
    data[field]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(incompatible)
}
fn capacity_budget(data: Value, fingerprint: String) -> AgentResult<OverviewBudget> {
    let input_bytes = positive_usize(&data, "inputBytes")?;
    let output_tokens = positive_usize(&data, "outputTokens")?;
    let context_window = positive_usize(&data, "contextWindow")?;
    let max_tokens = positive_usize(&data, "maxTokens")?;
    if input_bytes > MAX_OVERVIEW_INPUT_BYTES
        || output_tokens > 4096
        || output_tokens > max_tokens
        || output_tokens > context_window / 4
        || input_bytes > context_window.saturating_sub(output_tokens)
    {
        return Err(incompatible());
    }
    let source = data["source"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(incompatible)?
        .into();
    Ok(OverviewBudget {
        input_bytes,
        context_window,
        max_tokens,
        fingerprint,
        source,
    })
}
fn generation_output(data: Value) -> AgentResult<(String, Value)> {
    let text = data["text"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(incompatible)?;
    if text.chars().count() > OUTPUT_CHARACTERS {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Overview output exceeds its budget",
        ));
    }
    let usage = data
        .get("usage")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(incompatible)?;
    Ok((text.to_owned(), usage))
}

fn validate_input(batch_id: &str, prompt: &str, budget: &OverviewBudget) -> AgentResult<()> {
    let valid_id = batch_id.len() == 32
        && batch_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !valid_id || prompt.trim().is_empty() {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Overview batch or prompt is invalid",
        ));
    }
    budget.check(prompt)
}

fn workspace_changed() -> AgentError {
    AgentError::new(
        ErrorCode::WorkspaceChanged,
        "Workspace binding is no longer current",
    )
}
fn timed_out() -> AgentError {
    AgentError::new(ErrorCode::TimedOut, "Overview generation timed out")
}
fn incompatible() -> AgentError {
    AgentError::new(
        ErrorCode::RuntimeIncompatible,
        "DSH Overview response is incompatible",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_input_budget_and_batch_identity() {
        let id = "a".repeat(32);
        let budget = fallback_budget();
        assert!(validate_input(&id, &"界".repeat(1000), &budget).is_ok());
        assert_eq!(
            validate_input(&id, &"界".repeat(9000), &budget)
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            validate_input("A", "valid", &budget).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            validate_input(&id, " \n ", &budget).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn overview_rechecks_root_and_profile_after_async_work() {
        let root = PathBuf::from("workspace-a");
        assert!(require_identity(&root, "profile-a", &root, "profile-a").is_ok());
        assert_eq!(
            require_identity(
                &root,
                "profile-a",
                &PathBuf::from("workspace-b"),
                "profile-a"
            )
            .unwrap_err()
            .code,
            ErrorCode::WorkspaceChanged
        );
        assert_eq!(
            require_identity(&root, "profile-a", &root, "profile-b")
                .unwrap_err()
                .code,
            ErrorCode::ProfileUnavailable
        );
        let mut budget = fallback_budget();
        budget.fingerprint = "profile-a".into();
        assert_eq!(
            budget.require_profile("profile-b").unwrap_err().code,
            ErrorCode::ProfileUnavailable
        );
    }

    #[test]
    fn capacity_and_generation_enforce_model_and_output_budgets() {
        let capacity = json!({"inputBytes":26000,"outputTokens":4096,"contextWindow":32768,"maxTokens":4096,"source":"fallback"});
        assert_eq!(
            capacity_budget(capacity.clone(), "profile".into())
                .unwrap()
                .fingerprint,
            "profile"
        );
        for (field, value) in [
            ("inputBytes", MAX_OVERVIEW_INPUT_BYTES + 1),
            ("outputTokens", 4097),
            ("contextWindow", 0),
            ("maxTokens", 1),
        ] {
            let mut invalid = capacity.clone();
            invalid[field] = json!(value);
            assert!(capacity_budget(invalid, "profile".into()).is_err());
        }
        assert!(generation_output(json!({"text":"{}","usage":{}})).is_ok());
        assert!(generation_output(json!({"text":" ","usage":{}})).is_err());
        assert!(generation_output(json!({"text":"{}","usage":null})).is_err());
        assert_eq!(
            generation_output(json!({"text":"界".repeat(OUTPUT_CHARACTERS + 1),"usage":{}}))
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
    }
}
