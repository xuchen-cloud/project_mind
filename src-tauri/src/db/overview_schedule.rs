//! Project Overview timing and model-call reservations. These small ledgers live
//! in agent_jobs; the Overview worker owns its separate execution job.
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
};
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

const BATCH_BYTES: u32 = crate::overview_model::MAX_OVERVIEW_INPUT_BYTES as u32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Schedule {
    due_at: i64,
    last_attempt_at: i64,
    active: bool,
    batch_id: Option<String>,
    calls: u8,
    input_chars: u32,
    #[serde(default)]
    wait_until: i64,
}
impl Default for Schedule {
    fn default() -> Self {
        Self {
            due_at: 0,
            last_attempt_at: 0,
            active: false,
            batch_id: None,
            calls: 0,
            input_chars: 0,
            wait_until: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewScheduleStatus {
    pub budget_exhausted: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    pub foreground_busy: bool,
}
fn io(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot persist Overview schedule")
}
fn invalid() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Invalid Overview schedule ledger")
}
fn schedule_key(binding: &WorkspaceBinding, scope: &Scope) -> String {
    format!("overview-schedule:{}/{}", binding.workspace_id, scope.key())
}
fn worker_key(scope: &Scope) -> String {
    format!("overview-maintenance:{}", scope.key())
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn encode<T: Serialize>(value: &T) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid())
}
fn decode<T: for<'de> Deserialize<'de>>(raw: &str) -> AgentResult<T> {
    serde_json::from_str(raw).map_err(|_| invalid())
}

fn read_schedule(
    conn: &rusqlite::Connection,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<Option<Schedule>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM agent_jobs WHERE kind='maintenance' AND dedupe_key=?1",
            [schedule_key(binding, scope)],
            |r| r.get(0),
        )
        .optional()
        .map_err(io)?;
    let value = raw.map(|raw| decode::<Schedule>(&raw)).transpose()?;
    Ok(value)
}
fn save_schedule(
    conn: &rusqlite::Connection,
    binding: &WorkspaceBinding,
    scope: &Scope,
    value: &Schedule,
    now: DateTime<Utc>,
) -> AgentResult<()> {
    let key = schedule_key(binding, scope);
    conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance',?2,?1,'completed',?3,?4) ON CONFLICT(dedupe_key) DO UPDATE SET state='completed',not_before=excluded.not_before,payload_json=excluded.payload_json", params![key,scope.key(),stamp(now),encode(value)?]).map_err(io)?;
    Ok(())
}
/// Resolve a local wall-clock slot. In a fold take the earlier instant; in a
/// gap take the first available minute after the requested time.
fn local_slot(date: NaiveDate, time: NaiveTime, zone: chrono_tz::Tz) -> AgentResult<DateTime<Utc>> {
    let mut naive = date.and_time(time);
    for _ in 0..=1440 {
        match zone.from_local_datetime(&naive) {
            LocalResult::Single(value) => return Ok(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(a, b) => return Ok(a.min(b).with_timezone(&Utc)),
            LocalResult::None => naive += Duration::minutes(1),
        }
    }
    Err(invalid())
}
struct ScheduleTime {
    interval_hours: u8,
    local_time: String,
    timezone: String,
}
/// Every scope uses the Workspace's assistant switch and maintenance timing.
fn effective_schedule(conn: &rusqlite::Connection, _scope: &Scope) -> AgentResult<Option<ScheduleTime>> {
    conn.query_row(
        "SELECT overview_interval_hours,overview_local_time,overview_timezone FROM agent_scope_settings WHERE scope_key=?1 AND enabled=1",
        [Scope::Workspace.key()], |row| Ok(ScheduleTime { interval_hours: row.get(0)?, local_time: row.get(1)?, timezone: row.get(2)? }),
    ).optional().map_err(io)
}
fn slot_for_settings(settings: &ScheduleTime, now: DateTime<Utc>) -> AgentResult<i64> {
    let zone: chrono_tz::Tz = settings.timezone.parse().map_err(|_| invalid())?;
    let time =
        NaiveTime::parse_from_str(&settings.local_time, "%H:%M").map_err(|_| invalid())?;
    let date = now.with_timezone(&zone).date_naive()
        + Duration::days(i64::from(settings.interval_hours) / 24);
    Ok(local_slot(date, time, zone)?.timestamp())
}
fn next_slot(db: &Database, scope: &Scope, now: DateTime<Utc>) -> AgentResult<i64> {
    slot_for_settings(&effective_schedule(&db.conn, scope)?.ok_or_else(invalid)?, now)
}

pub(super) fn retime_schedule(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    changed_scope: &Scope,
    now: DateTime<Utc>,
) -> AgentResult<()> {
    let binding = WorkspaceBinding { workspace_id: workspace_id.into(), generation: String::new() };
    let scopes = match changed_scope {
        Scope::Project { .. } => vec![changed_scope.clone()],
        Scope::Workspace => {
            let mut stmt = conn.prepare("SELECT id FROM projects WHERE is_archived=0").map_err(io)?;
            let rows = stmt.query_map([], |row| Ok(Scope::Project { project_id: row.get(0)? }))
                .map_err(io)?;
            let mut scopes=rows.collect::<rusqlite::Result<Vec<_>>>().map_err(io)?;
            scopes.push(Scope::Workspace);scopes
        }
    };
    for scope in scopes {
        let Some(settings) = effective_schedule(conn, &scope)? else { continue; };
        let Some(mut ledger) = read_schedule(conn, &binding, &scope)? else { continue; };
        if ledger.active || ledger.due_at <= now.timestamp() { continue; }
        ledger.due_at = slot_for_settings(&settings, now)?;
        save_schedule(conn, &binding, &scope, &ledger, now)?;
    }
    Ok(())
}
fn dirty(db: &Database, scope: &Scope) -> AgentResult<bool> {
    let overview_dirty:bool=db.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_overview_pending WHERE scope_key=?1) OR EXISTS(SELECT 1 FROM agent_overview_pending_state WHERE scope_key=?1 AND needs_rebuild=1)", [scope.key()], |r| r.get(0)).map_err(io)?;
    Ok(overview_dirty || db.agent_session_maintenance_pending(scope)?)
}
fn time_at(timestamp: i64) -> AgentResult<DateTime<Utc>> {
    DateTime::from_timestamp(timestamp, 0).ok_or_else(invalid)
}

fn check_binding(db: &Database, binding: &WorkspaceBinding) -> AgentResult<()> {
    if db.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Overview Workspace is no longer current",
        ));
    }
    Ok(())
}

impl Database {
    pub(crate) fn overview_schedule_scope(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<bool> {
        check_binding(self, binding)?;
        scope.validate()?;
        self.source_live_scope(scope)?;
        Ok(effective_schedule(&self.conn, scope)?.is_some())
    }

    /// One fair due Project per tick. Selecting records its turn before the
    /// worker takes over, so an unready scope cannot starve the others.
    pub(crate) fn overview_schedule_next(
        &self,
        binding: &WorkspaceBinding,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<Scope>> {
        check_binding(self, binding)?;
        if self.source_foreground_busy()? {
            return Ok(None);
        }
        self.agent_overviews_prepare()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare Overview storage"))?;
        let mut stmt = self.conn.prepare("SELECT id FROM projects WHERE is_archived=0").map_err(io)?;
        let ids = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io)?;
        drop(stmt);
        let mut candidates = Vec::new();
        let scopes=ids.into_iter().map(|project_id|Scope::Project{project_id}).chain(std::iter::once(Scope::Workspace));
        for scope in scopes {
            if !self.overview_schedule_scope(binding, &scope)? { continue; }
            let stored = read_schedule(&self.conn, binding, &scope)?;
            let initial = stored.is_none();
            let ledger = stored.unwrap_or_default();
            if !ledger.active && ledger.due_at > now.timestamp() {
                continue;
            }
            let worker: Option<String> = self
                .conn
                .query_row(
                    "SELECT state FROM agent_jobs WHERE dedupe_key=?1",
                    [worker_key(&scope)],
                    |r| r.get(0),
                )
                .optional()
                .map_err(io)?;
            if worker
                .as_deref()
                .is_some_and(|state| matches!(state, "queued" | "failed" | "cancelled"))
            {
                continue;
            }
            candidates.push((ledger.last_attempt_at, scope, ledger, initial));
        }
        candidates.sort_by_key(|item| (item.0, matches!(item.1,Scope::Workspace), item.1.key()));
        for (_, scope, mut ledger, initial) in candidates {
            if !initial && !ledger.active && !dirty(self, &scope)? {
                ledger.due_at = next_slot(self, &scope, now)?;
                save_schedule(&self.conn, binding, &scope, &ledger, now)?;
                continue;
            }
            ledger.active = true;
            ledger.last_attempt_at = now.timestamp();
            save_schedule(&self.conn, binding, &scope, &ledger, now)?;
            return Ok(Some(scope));
        }
        Ok(None)
    }

    /// Manual refresh and crash continuation use the same persistent queue.
    pub(crate) fn overview_schedule_request(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        if !self.overview_schedule_scope(binding, scope)? {
            return Ok(false);
        }
        let mut ledger = read_schedule(&self.conn, binding, scope)?.unwrap_or_default();
        ledger.active = true;
        ledger.due_at = now.timestamp();
        save_schedule(&self.conn, binding, scope, &ledger, now)?;
        Ok(true)
    }

    /// Check one model request's input boundary before dispatch.
    pub(crate) fn overview_schedule_reserve(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        input_bytes: u32,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        if !self.overview_schedule_scope(binding, scope)? || self.source_foreground_busy()? {
            return Ok(false);
        }
        if batch_id.is_empty() || batch_id.len() > 128 || input_bytes == 0 {
            return Ok(false);
        }
        if input_bytes > BATCH_BYTES {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Overview model input exceeds one request's transport boundary",
            ));
        }
        let tx = rusqlite::Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io)?;
        let mut ledger = read_schedule(&tx, binding, scope)?.unwrap_or_default();
        if !ledger.active {
            return Ok(false);
        }
        // Keep the old ledger readable, but batch totals are no longer quotas.
        if ledger.batch_id.as_deref().is_some_and(|id| id != batch_id) {
            ledger.calls = 0;
            ledger.input_chars = 0;
            ledger.wait_until = 0;
        }
        ledger.batch_id = Some(batch_id.to_owned());
        save_schedule(&tx, binding, scope, &ledger, now)?;
        tx.commit().map_err(io)?;
        Ok(true)
    }

    /// One page batch is complete. Further pages get a fresh batch identity;
    /// finishing a cycle advances straight to the next local calendar slot.
    pub(crate) fn overview_schedule_finished(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        has_more: bool,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        if !self.overview_schedule_scope(binding, scope)? {
            return Ok(());
        }
        let mut ledger = read_schedule(&self.conn, binding, scope)?.unwrap_or_default();
        ledger.batch_id = None;
        ledger.calls = 0;
        ledger.input_chars = 0;
        ledger.wait_until = 0;
        ledger.active = has_more;
        ledger.due_at = if has_more {
            now.timestamp()
        } else {
            next_slot(self, scope, now)?
        };
        save_schedule(&self.conn, binding, scope, &ledger, now)
    }


    pub(crate) fn overview_schedule_status(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<OverviewScheduleStatus> {
        if !self.overview_schedule_scope(binding, scope)? {
            return Ok(OverviewScheduleStatus {
                budget_exhausted: false,
                next_run_at: None,
                foreground_busy: self.source_foreground_busy()?,
            });
        }
        let ledger = read_schedule(&self.conn, binding, scope)?.unwrap_or_default();
        let due = ledger.due_at;
        Ok(OverviewScheduleStatus {
            budget_exhausted: false,
            next_run_at: Some(time_at(due.max(now.timestamp()))?),
            foreground_busy: self.source_foreground_busy()?,
        })
    }
}

#[cfg(test)]
#[path = "overview_schedule_tests.rs"]
mod tests;
