//! Durable, source-independent cycles for organization of existing memory facts.
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
    settings::SettingsRepository,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceRun {
    pub id: String,
    pub scope: Scope,
    pub started_at: DateTime<Utc>,
    pub due_at: DateTime<Utc>,
    pub phase: String,
    pub behavior_revision: String,
    pub facts: Vec<Value>,
    pub suppressed: Vec<Value>,
    pub settings_revision: u64,
    pub response: Option<String>,
    pub usage: Option<Value>,
    pub model_profile_id: Option<String>,
    pub receipt: Option<Value>,
    pub error: Option<String>,
}
fn io(error: impl std::fmt::Display) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        format!("Memory maintenance ledger: {error}"),
    )
}
impl Database {
    pub(crate) fn memory_maintenance_has_receipt(&self, run_id: &str) -> AgentResult<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_fact_receipts WHERE request_id=?1)",
                [format!("memory-organization-{run_id}")],
                |row| row.get(0),
            )
            .map_err(io)
    }

    pub(crate) fn memory_maintenance_status(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<Option<MaintenanceRun>> {
        self.overview_schedule_scope(binding, scope)?;
        let prefix = format!(
            "memory-organization:{}/{}/%",
            binding.workspace_id,
            scope.key()
        );
        let raw: Option<String> = self.conn.query_row("SELECT payload_json FROM agent_jobs WHERE kind='maintenance' AND dedupe_key LIKE ?1 ORDER BY not_before DESC,id DESC LIMIT 1",[prefix],|r|r.get(0)).optional().map_err(io)?;
        let mut run: Option<MaintenanceRun> = raw
            .map(|raw| serde_json::from_str(&raw).map_err(io))
            .transpose()?;
        if let Some(run) = &mut run {
            let settings = self.agent_settings_get(&Scope::Workspace)?;
            if settings.enabled
                && settings.revision != run.settings_revision
                && matches!(run.phase.as_str(), "completed" | "failed")
            {
                run.due_at = self.memory_maintenance_due_at(scope, run.started_at)?;
                run.settings_revision = settings.revision;
                self.memory_maintenance_save(binding, run)?;
            }
        }
        Ok(run)
    }
    pub(crate) fn memory_maintenance_save(
        &self,
        binding: &WorkspaceBinding,
        run: &MaintenanceRun,
    ) -> AgentResult<()> {
        self.overview_schedule_scope(binding, &run.scope)?;
        let key = format!(
            "memory-organization:{}/{}/{}",
            binding.workspace_id,
            run.scope.key(),
            run.id
        );
        let state = match run.phase.as_str() {
            "completed" => "completed",
            "failed" => "failed",
            _ => "running",
        };
        self.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json,error) VALUES (?1,'maintenance',?2,?1,?3,?4,?5,?6) ON CONFLICT(dedupe_key) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,error=excluded.error",params![key,run.scope.key(),state,run.started_at.to_rfc3339(),serde_json::to_string(run).map_err(io)?,run.error]).map_err(io)?;
        Ok(())
    }
    pub(crate) fn memory_maintenance_next(
        &self,
        binding: &WorkspaceBinding,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<Scope>> {
        if !self.agent_settings_get(&Scope::Workspace)?.enabled || self.source_foreground_busy()? {
            return Ok(None);
        }
        let scopes = std::iter::once(Scope::Workspace).chain(
            self.agent_active_project_ids()?
                .into_iter()
                .map(|project_id| Scope::Project { project_id }),
        );
        let mut due = Vec::new();
        for scope in scopes {
            if !self.overview_schedule_scope(binding, &scope)? {
                continue;
            }
            let run = self.memory_maintenance_status(binding, &scope)?;
            if run
                .as_ref()
                .is_none_or(|r| r.phase == "prepared" || r.phase == "generating" || r.due_at <= now)
            {
                due.push((run.as_ref().map(|r| r.started_at), scope));
            }
        }
        due.sort_by_key(|(at, scope)| (*at, scope.key()));
        Ok(due.into_iter().next().map(|(_, scope)| scope))
    }
    pub(crate) fn memory_maintenance_due_at(
        &self,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<DateTime<Utc>> {
        DateTime::from_timestamp(super::overview_schedule::next_slot(self, scope, now)?, 0)
            .ok_or_else(|| io("invalid next slot"))
    }
}
