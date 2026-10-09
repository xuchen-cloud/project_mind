//! Project Overview timing and model-call reservations. These small ledgers live
//! in agent_jobs; the Overview worker owns its separate execution job.
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
    settings::SettingsRepository,
};
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

const WINDOW_SECONDS: i64 = 20 * 60;
const WORKSPACE_CALLS: u8 = 20;
const BATCH_CALLS: u8 = 3;
const BATCH_CHARS: u32 = 48_000;
const PROJECT_SESSION_DAILY_CALLS: u8 = 5;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Budget {
    window_start: i64,
    calls: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionDailyBudget {
    date: String,
    calls: u8,
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
fn budget_key(binding: &WorkspaceBinding) -> String {
    format!("overview-budget:{}", binding.workspace_id)
}
fn session_daily_key(binding: &WorkspaceBinding, scope: &Scope) -> String {
    format!("overview-session-daily:{}/{}", binding.workspace_id, scope.key())
}
fn read_session_daily(conn: &rusqlite::Connection, binding: &WorkspaceBinding, scope: &Scope, now: DateTime<Utc>) -> AgentResult<SessionDailyBudget> {
    let raw:Option<String>=conn.query_row("SELECT payload_json FROM agent_jobs WHERE kind='maintenance' AND dedupe_key=?1",[session_daily_key(binding,scope)],|r|r.get(0)).optional().map_err(io)?;
    let date=now.date_naive().to_string();
    let stored=raw.map(|raw|decode::<SessionDailyBudget>(&raw)).transpose()?;
    if stored.as_ref().is_some_and(|budget| budget.calls>PROJECT_SESSION_DAILY_CALLS
        || NaiveDate::parse_from_str(&budget.date,"%Y-%m-%d").ok().is_none_or(|day|day.to_string()!=budget.date)) {return Err(invalid());}
    Ok(stored.filter(|budget|budget.date==date).unwrap_or(SessionDailyBudget {date,calls:0}))
}
pub(super) fn session_daily_available(conn: &rusqlite::Connection,binding:&WorkspaceBinding,scope:&Scope,now:DateTime<Utc>)->AgentResult<bool> {
    Ok(read_session_daily(conn,binding,scope,now)?.calls<PROJECT_SESSION_DAILY_CALLS)
}
fn save_session_daily(conn:&rusqlite::Connection,binding:&WorkspaceBinding,scope:&Scope,budget:&SessionDailyBudget,now:DateTime<Utc>)->AgentResult<()> {
    let key=session_daily_key(binding,scope);
    conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance',?2,?1,'completed',?3,?4) ON CONFLICT(dedupe_key) DO UPDATE SET state='completed',not_before=excluded.not_before,payload_json=excluded.payload_json",params![key,scope.key(),stamp(now),encode(budget)?]).map_err(io)?;
    Ok(())
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
    if value.as_ref().is_some_and(|s| {
        s.calls > BATCH_CALLS || s.input_chars > BATCH_CHARS || s.batch_id.is_none() && s.calls > 0
    }) {
        return Err(invalid());
    }
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
fn read_budget(
    conn: &rusqlite::Connection,
    binding: &WorkspaceBinding,
    now: DateTime<Utc>,
) -> AgentResult<Budget> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM agent_jobs WHERE kind='maintenance' AND dedupe_key=?1",
            [budget_key(binding)],
            |r| r.get(0),
        )
        .optional()
        .map_err(io)?;
    let mut value = raw
        .map(|raw| decode::<Budget>(&raw))
        .transpose()?
        .unwrap_or(Budget {
            window_start: now.timestamp(),
            calls: 0,
        });
    if value.calls > WORKSPACE_CALLS {
        return Err(invalid());
    }
    if now.timestamp() >= value.window_start.saturating_add(WINDOW_SECONDS) {
        value = Budget {
            window_start: now.timestamp(),
            calls: 0,
        };
    }
    Ok(value)
}
fn save_budget(
    conn: &rusqlite::Connection,
    binding: &WorkspaceBinding,
    value: &Budget,
    now: DateTime<Utc>,
) -> AgentResult<()> {
    let key = budget_key(binding);
    conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance','workspace',?1,'completed',?2,?3) ON CONFLICT(dedupe_key) DO UPDATE SET state='completed',not_before=excluded.not_before,payload_json=excluded.payload_json", params![key,stamp(now),encode(value)?]).map_err(io)?;
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
fn next_slot(db: &Database, scope: &Scope, now: DateTime<Utc>) -> AgentResult<i64> {
    let settings = db.agent_settings_get(scope)?;
    let zone: chrono_tz::Tz = settings.overview_timezone.parse().map_err(|_| invalid())?;
    let time =
        NaiveTime::parse_from_str(&settings.overview_local_time, "%H:%M").map_err(|_| invalid())?;
    let date = now.with_timezone(&zone).date_naive()
        + Duration::days(i64::from(settings.overview_interval_hours) / 24);
    Ok(local_slot(date, time, zone)?.timestamp())
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
    fn overview_schedule_scope(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<bool> {
        check_binding(self, binding)?;
        scope.validate()?;
        if !matches!(scope, Scope::Project { .. }) {
            return Ok(false);
        }
        self.source_live_scope(scope)?;
        Ok(self.agent_settings_get(scope)?.enabled)
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
        let mut stmt = self.conn.prepare("SELECT s.scope_key FROM agent_scope_settings s JOIN projects p ON s.scope_key='project:'||p.id WHERE s.enabled=1 AND p.is_archived=0").map_err(io)?;
        let keys = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io)?;
        drop(stmt);
        let mut candidates = Vec::new();
        for key in keys {
            let Some(id) = key
                .strip_prefix("project:")
                .and_then(|id| id.parse::<i64>().ok())
            else {
                continue;
            };
            let scope = Scope::Project { project_id: id };
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
            let budget = read_budget(&self.conn, binding, now)?;
            if budget.calls == WORKSPACE_CALLS {
                continue;
            }
            if ledger.wait_until > now.timestamp() && worker.as_deref() != Some("running") {
                continue;
            }
            candidates.push((ledger.last_attempt_at, scope, ledger, initial));
        }
        candidates.sort_by_key(|item| (item.0, item.1.key()));
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

    /// Charge both ledgers before any model request. A crash leaves the charge.
    pub(crate) fn overview_schedule_reserve(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        input_chars: u32,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        if !self.overview_schedule_scope(binding, scope)? || self.source_foreground_busy()? {
            return Ok(false);
        }
        if batch_id.is_empty()
            || batch_id.len() > 128
            || input_chars == 0
            || input_chars > BATCH_CHARS
        {
            return Ok(false);
        }
        let tx = rusqlite::Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io)?;
        let mut ledger = read_schedule(&tx, binding, scope)?.unwrap_or_default();
        let mut budget = read_budget(&tx, binding, now)?;
        if !ledger.active {
            return Ok(false);
        }
        // A new durable maintenance batch has its own three-call/48k-character
        // allowance, including when an unpublished failed batch is abandoned.
        if ledger.batch_id.as_deref().is_some_and(|id| id != batch_id) {
            ledger.calls = 0;
            ledger.input_chars = 0;
            ledger.wait_until = 0;
        }
        let summary_call=super::overview_maintenance::overview_batch_requires_summary(&tx,scope,batch_id)?;
        let mut session_daily=if summary_call {Some(read_session_daily(&tx,binding,scope,now)?)} else {None};
        if session_daily.as_ref().is_some_and(|daily|daily.calls>=PROJECT_SESSION_DAILY_CALLS) {
            return Ok(false);
        }
        if budget.calls >= WORKSPACE_CALLS
            || ledger.calls >= BATCH_CALLS
            || ledger
                .input_chars
                .checked_add(input_chars)
                .is_none_or(|value| value > BATCH_CHARS)
        {
            ledger.wait_until = budget.window_start.saturating_add(WINDOW_SECONDS);
            save_schedule(&tx, binding, scope, &ledger, now)?;
            tx.commit().map_err(io)?;
            return Ok(false);
        }
        ledger.batch_id = Some(batch_id.to_owned());
        ledger.calls += 1;
        ledger.input_chars += input_chars;
        ledger.wait_until = if ledger.calls == BATCH_CALLS || ledger.input_chars == BATCH_CHARS {
            budget.window_start.saturating_add(WINDOW_SECONDS)
        } else {
            0
        };
        budget.calls += 1;
        if let Some(daily)=session_daily.as_mut() {
            daily.calls+=1;
            save_session_daily(&tx,binding,scope,daily,now)?;
        }
        save_schedule(&tx, binding, scope, &ledger, now)?;
        save_budget(&tx, binding, &budget, now)?;
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
        let budget = read_budget(&self.conn, binding, now)?;
        let quota_until = budget.window_start.saturating_add(WINDOW_SECONDS);
        let daily_blocked=!session_daily_available(&self.conn,binding,scope,now)?
            && super::overview_maintenance::overview_only_summary_quota_blocked(&self.conn,binding,scope)?;
        let next_utc_day=if daily_blocked {
            now.date_naive().succ_opt().and_then(|day|day.and_hms_opt(0,0,0))
                .map(|day|day.and_utc().timestamp()).ok_or_else(invalid)?
        } else {0};
        let blocked_until = ledger.wait_until.max(if budget.calls >= WORKSPACE_CALLS {
            quota_until
        } else {
            0
        }).max(next_utc_day);
        let exhausted = blocked_until > now.timestamp();
        let due = ledger.due_at.max(if exhausted { blocked_until } else { 0 });
        Ok(OverviewScheduleStatus {
            budget_exhausted: exhausted,
            next_run_at: Some(time_at(due.max(now.timestamp()))?),
            foreground_busy: self.source_foreground_busy()?,
        })
    }
}

#[cfg(test)]
#[path = "overview_schedule_tests.rs"]
mod tests;
