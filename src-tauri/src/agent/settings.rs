//! Scope configuration belongs to the user, never to a model tool grant.
use super::{
    errors::AgentResult,
    models::{ExecutionMode, ObjectRef, Scope},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummaryPolicy {
    OnSuccess,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentScopeSettings {
    pub scope: Scope,
    pub enabled: bool,
    pub goal_record_id: Option<i64>,
    pub pinned_refs: Vec<ObjectRef>,
    pub summary_policy: SummaryPolicy,
    pub overview_interval_hours: u8,
    pub overview_local_time: String,
    pub overview_timezone: String,
    pub execution_mode: ExecutionMode,
    pub revision: u64,
}
impl AgentScopeSettings {
    pub fn defaults(scope: Scope) -> Self {
        Self {
            scope,
            enabled: false,
            goal_record_id: None,
            pinned_refs: vec![],
            summary_policy: SummaryPolicy::OnSuccess,
            overview_interval_hours: 24,
            overview_local_time: "03:00".into(),
            overview_timezone: "UTC".into(),
            execution_mode: ExecutionMode::Collaborate,
            revision: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdate {
    pub settings: AgentScopeSettings,
    pub expected_revision: u64,
}
pub trait SettingsRepository {
    fn agent_settings_get(&self, scope: &Scope) -> AgentResult<AgentScopeSettings>;
    fn agent_settings_update(
        &self,
        caller_id: &str,
        request_id: &str,
        input: &SettingsUpdate,
    ) -> AgentResult<AgentScopeSettings>;
}

impl SettingsUpdate {
    pub fn validate(&self) -> AgentResult<()> {
        use super::errors::{AgentError, ErrorCode};
        self.settings.scope.validate()?;
        let time = self.settings.overview_local_time.as_bytes();
        let time_valid = time.len() == 5
            && time[2] == b':'
            && time[0..2].iter().all(u8::is_ascii_digit)
            && time[3..5].iter().all(u8::is_ascii_digit)
            && self.settings.overview_local_time[0..2]
                .parse::<u8>()
                .is_ok_and(|hour| hour < 24)
            && self.settings.overview_local_time[3..5]
                .parse::<u8>()
                .is_ok_and(|minute| minute < 60);
        if self.settings.pinned_refs.len() > 5
            || ![24, 48].contains(&self.settings.overview_interval_hours)
            || !time_valid
            || self
                .settings
                .overview_timezone
                .parse::<chrono_tz::Tz>()
                .is_err()
            || self.expected_revision > i64::MAX as u64 - 1
            || self.settings.revision != self.expected_revision
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid assistant settings or baseline",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for pin in &self.settings.pinned_refs {
            if pin.scope != self.settings.scope || !seen.insert(pin.key()?) {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Pins must be distinct objects in this scope",
                ));
            }
        }
        Ok(())
    }
}
