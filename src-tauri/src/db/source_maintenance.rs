//! Internal extraction scheduling ledger. Reuses agent_jobs; stores neither
//! content nor model usage. Reservations survive crashes and Workspace reopen.
use super::Database;
use crate::agent::{
    access::{Caller, RequestContext},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{Scope, WorkspaceBinding},
    settings::SettingsRepository,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

const BATCH_CHARS: usize = 8 * 1024 * 1024;
const BATCH_CHUNKS: usize = 40000;
const BATCH_JOBS: usize = 100;
const PERIOD_SECONDS: i64 = 1200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    scope: Scope,
    batch_id: String,
    started_at: i64,
    chars: usize,
    chunks: usize,
    jobs: usize,
    cancelled: bool,
    #[serde(default)]
    paused_scopes: Vec<Scope>,
    reservation: Option<Reservation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reservation {
    token: String,
    generation: String,
    expires_at: i64,
    pub scope: Scope,
    pub chars: usize,
    pub chunks: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceProgress {
    pub scope: Scope,
    pub batch_id: String,
    pub charged_chars: usize,
    pub charged_chunks: usize,
    pub attempted_jobs: usize,
    pub cancelled: bool,
    pub budget_exhausted: bool,
    pub foreground_busy: bool,
    pub pending_jobs: usize,
    pub failed_jobs: usize,
    pub partial_sources: usize,
    pub backfill_complete: bool,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MaintenanceAction {
    Activate,
    Cancel,
    Resume,
}

fn io(_: rusqlite::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot access extraction scheduling ledger",
    )
}
fn invalid() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Invalid extraction scheduling ledger")
}
fn encode(ledger: &Ledger) -> AgentResult<String> {
    serde_json::to_string(ledger).map_err(|_| invalid())
}
fn key(binding: &WorkspaceBinding) -> String {
    format!("source-maintenance:{}", binding.workspace_id)
}
fn fresh(scope: &Scope, now: DateTime<Utc>) -> Ledger {
    Ledger {
        scope: scope.clone(),
        batch_id: format!("{:032x}", rand::random::<u128>()),
        started_at: now.timestamp(),
        chars: 0,
        chunks: 0,
        jobs: 0,
        cancelled: false,
        paused_scopes: Vec::new(),
        reservation: None,
    }
}
fn authorize(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<()> {
    // This is a trusted desktop maintenance control, never a model tool.
    if !matches!(request.caller, Caller::Gui) {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Extraction control is a GUI operation",
        ));
    }
    request.authorize(binding, scope, "settings.write")?;
    request.authorize(binding, scope, "source.read")
}
impl Database {
    fn maintenance_load(&self, binding: &WorkspaceBinding) -> AgentResult<Option<Ledger>> {
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Extraction Workspace is no longer current",
            ));
        }
        self.source_queue_prepare()?;
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT payload_json FROM agent_jobs WHERE dedupe_key=?1 AND kind='maintenance'",
                [key(binding)],
                |row| row.get(0),
            )
            .optional()
            .map_err(io)?;
        raw.map(|raw| {
            let mut ledger: Ledger = serde_json::from_str(&raw).map_err(|_| invalid())?;
            // Old ledgers had a single cancellation bit for their selected scope.
            if ledger.cancelled && !ledger.paused_scopes.contains(&ledger.scope) {
                ledger.paused_scopes.push(ledger.scope.clone());
            }
            ledger.cancelled = false;
            ledger.scope.validate()?;
            if ledger.chars > BATCH_CHARS
                || ledger.chunks > BATCH_CHUNKS
                || ledger.jobs > BATCH_JOBS
                || !(0..=i64::MAX - PERIOD_SECONDS).contains(&ledger.started_at)
                || ledger.reservation.as_ref().is_some_and(|item| {
                    item.chars == 0
                        || item.chars > ledger.chars
                        || item.chunks == 0
                        || item.chunks > ledger.chunks
                        || item.scope.validate().is_err()
                        || ledger.jobs == 0
                })
                || ledger.paused_scopes.iter().any(|scope| scope.validate().is_err())
            {
                return Err(invalid());
            }
            Ok(ledger)
        })
        .transpose()
    }
    fn maintenance_save(&self, binding: &WorkspaceBinding, ledger: &Ledger) -> AgentResult<()> {
        // This row is a quota ledger, not a pending maintenance execution.
        // Merely selecting a disabled scope must not create queued jobs.
        self.conn.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,not_before,payload_json) VALUES (?1,'maintenance','workspace',?1,?2,?3,?4) ON CONFLICT(dedupe_key) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json", params![key(binding), if ledger.paused_scopes.contains(&ledger.scope) {"cancelled"} else {"completed"}, Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true), encode(ledger)?]).map_err(io)?;
        Ok(())
    }
    pub(crate) fn source_maintenance_select(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        action: MaintenanceAction,
        now: DateTime<Utc>,
    ) -> AgentResult<MaintenanceProgress> {
        authorize(request, binding, scope)?;
        self.source_live_scope(scope)?;
        if matches!(action, MaintenanceAction::Resume) && !self.source_maintenance_enabled(binding, scope)? {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Enable the assistant in this scope first",
            ));
        }
        let old = self.maintenance_load(binding)?;
        let tx = self.conn.unchecked_transaction().map_err(io)?;
        let mut ledger = old.unwrap_or_else(|| fresh(scope, now));
        if matches!(action, MaintenanceAction::Resume)
            && now.timestamp() >= ledger.started_at + PERIOD_SECONDS
            && ledger.reservation.is_none()
        {
            let paused = ledger.paused_scopes;
            ledger = fresh(scope, now);
            ledger.paused_scopes = paused;
        }
        if ledger.reservation.is_none() && matches!(action, MaintenanceAction::Activate) {
            // Explicit activation is compatible with old callers; the driver
            // subsequently chooses the next eligible scope itself.
            ledger.scope = scope.clone();
        }
        match action {
            MaintenanceAction::Cancel => {
                if !ledger.paused_scopes.contains(scope) { ledger.paused_scopes.push(scope.clone()); }
            }
            MaintenanceAction::Resume => ledger.paused_scopes.retain(|paused| paused != scope),
            MaintenanceAction::Activate => (), // Opening a page cannot undo cancellation.
        }
        self.maintenance_save(binding, &ledger)?;
        tx.commit().map_err(io)?;
        self.source_maintenance_progress(request, binding, scope, now)?
            .ok_or_else(invalid)
    }
    pub(crate) fn source_foreground_busy(&self) -> AgentResult<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE state IN ('preparing','running','cancelling')) OR EXISTS(SELECT 1 FROM recording_sessions WHERE lifecycle!='ended')", [], |row| row.get(0)).map_err(io)
    }
    pub(crate) fn source_maintenance_selected(
        &self,
        binding: &WorkspaceBinding,
    ) -> AgentResult<Option<Scope>> {
        Ok(self.maintenance_load(binding)?.map(|ledger| ledger.scope))
    }
    fn source_maintenance_enabled(&self, binding: &WorkspaceBinding, scope: &Scope) -> AgentResult<bool> {
        match scope {
            Scope::Workspace => {
                self.source_live_scope(scope)?;
                Ok(self.agent_settings_get(scope)?.enabled)
            }
            Scope::Project { .. } => self.overview_schedule_scope(binding, scope),
        }
    }
    /// Select one eligible scope using the existing ledger as a fair cursor.
    /// The global reservation and quota remain untouched across scope changes.
    pub(crate) fn source_maintenance_next(
        &self, binding: &WorkspaceBinding, now: DateTime<Utc>,
    ) -> AgentResult<Option<Scope>> {
        let mut ledger = self.maintenance_load(binding)?;
        if let Some(item) = ledger.as_mut() {
            if let Some(reservation) = &item.reservation {
                if reservation.generation == binding.generation && reservation.expires_at > now.timestamp() {
                    return Ok(None);
                }
                // An expired or previous-generation lease keeps its charge,
                // but must not pin the rotation after a crash or reopen.
                item.reservation = None;
                self.maintenance_save(binding, item)?;
            }
        }
        let mut scopes = vec![Scope::Workspace];
        let mut stmt = self.conn.prepare("SELECT id FROM projects WHERE is_archived=0 ORDER BY id").map_err(io)?;
        let ids = stmt.query_map([], |row| row.get::<_, i64>(0)).map_err(io)?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(io)?;
        scopes.extend(ids.into_iter().map(|project_id| Scope::Project { project_id }));
        let start = ledger.as_ref().and_then(|item| scopes.iter().position(|scope| *scope == item.scope))
            .map_or(0, |index| (index + 1) % scopes.len());
        for offset in 0..scopes.len() {
            let scope = &scopes[(start + offset) % scopes.len()];
            if ledger.as_ref().is_some_and(|item| item.paused_scopes.contains(scope))
                || !self.source_maintenance_enabled(binding, scope)?
                || !self.source_maintenance_has_work(binding, scope, now)? { continue; }
            let mut item = ledger.take().unwrap_or_else(|| fresh(scope, now));
            item.scope = scope.clone();
            self.maintenance_save(binding, &item)?;
            return Ok(Some(scope.clone()));
        }
        Ok(None)
    }
    pub(crate) fn source_maintenance_has_work(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        self.source_queue_prepare()?;
        let prefix = format!("source-index:{}/", binding.workspace_id);
        self.conn.query_row("SELECT
            EXISTS(SELECT 1 FROM agent_jobs WHERE kind='extract' AND scope_key=?1 AND substr(dedupe_key,1,length(?2))=?2 AND ((state='queued' AND not_before<=?3) OR (state='running' AND (not_before<=?3 OR json_extract(payload_json,'$.generation')!=?4))))
            OR NOT EXISTS(SELECT 1 FROM source_index_backfill_cursors WHERE workspace_id=?5 AND scope_key=?1 AND complete=1)
            OR EXISTS(SELECT 1 FROM source_index_queue_cursors WHERE workspace_id=?5 AND scope_key=?1 AND needs_backfill=1)
            OR coalesce((SELECT seq FROM source_index_queue_cursors WHERE workspace_id=?5 AND scope_key=?1),0) < coalesce((SELECT max(seq) FROM agent_change_log),(SELECT seq FROM sqlite_sequence WHERE name='agent_change_log'),0)",params![scope.key(),prefix,now.to_rfc3339_opts(SecondsFormat::Millis,true),binding.generation,binding.workspace_id],|row|row.get(0)).map_err(io)
    }
    pub(crate) fn source_maintenance_progress(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<MaintenanceProgress>> {
        authorize(request, binding, scope)?;
        let Some(ledger) = self.maintenance_load(binding)? else {
            return Ok(None);
        };
        let prefix = format!("source-index:{}/", binding.workspace_id);
        let (pending,failed): (i64,i64) = self.conn.query_row("SELECT coalesce(sum(state IN ('queued','running')),0),coalesce(sum(state='failed'),0) FROM agent_jobs WHERE kind='extract' AND scope_key=?1 AND substr(dedupe_key,1,length(?2))=?2", params![scope.key(),prefix],|row|Ok((row.get(0)?,row.get(1)?))).map_err(io)?;
        // Cache tables are prepared lazily by the shared index service.
        let has_cache: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_index_snapshots')",[],|row|row.get(0)).map_err(io)?;
        let partial: i64 = if has_cache {
            self.conn.query_row("SELECT count(*) FROM source_index_snapshots WHERE workspace_id=?1 AND scope_key=?2 AND is_current=1 AND json_extract(coverage_json,'$.complete')=0",params![binding.workspace_id,scope.key()],|row|row.get(0)).map_err(io)?
        } else {
            0
        };
        let backfill: bool = self.conn.query_row("SELECT complete FROM source_index_backfill_cursors WHERE workspace_id=?1 AND scope_key=?2",params![binding.workspace_id,scope.key()],|row|row.get(0)).optional().map_err(io)?.unwrap_or(false);
        Ok(Some(MaintenanceProgress {
            scope: scope.clone(),
            batch_id: ledger.batch_id,
            charged_chars: ledger.chars,
            charged_chunks: ledger.chunks,
            attempted_jobs: ledger.jobs,
            cancelled: ledger.paused_scopes.contains(scope),
            budget_exhausted: ledger.chars == BATCH_CHARS
                || ledger.chunks == BATCH_CHUNKS
                || ledger.jobs == BATCH_JOBS
                || now.timestamp() >= ledger.started_at + PERIOD_SECONDS,
            foreground_busy: self.source_foreground_busy()?,
            pending_jobs: pending as usize,
            failed_jobs: failed as usize,
            partial_sources: partial as usize,
            backfill_complete: backfill,
        }))
    }
    /// Reserve before any asynchronous conversion. Crashes conservatively keep
    /// the reservation charged; reclaiming a lease never resets batch usage.
    pub(crate) fn source_maintenance_reserve(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<Reservation>> {
        authorize(request, binding, scope)?;
        self.source_live_scope(scope)?;
        if !self.source_maintenance_enabled(binding, scope)? || self.source_foreground_busy()? {
            return Ok(None);
        }
        let Some(mut ledger) = self.maintenance_load(binding)? else {
            return Ok(None);
        };
        let tx = self.conn.unchecked_transaction().map_err(io)?;
        if ledger.scope != *scope || ledger.paused_scopes.contains(scope) {
            return Ok(None);
        }
        if let Some(previous) = &ledger.reservation {
            if previous.generation == binding.generation && previous.expires_at > now.timestamp() {
                return Ok(None);
            }
            ledger.reservation = None; // Charged usage remains, including after reopen.
        }
        if now.timestamp() >= ledger.started_at + PERIOD_SECONDS {
            let paused = ledger.paused_scopes;
            ledger = fresh(scope, now); // One new bounded period; no missed-period replay.
            ledger.paused_scopes = paused;
        }
        let chars = (BATCH_CHARS - ledger.chars).min(2 * 1024 * 1024);
        let chunks = (BATCH_CHUNKS - ledger.chunks).min(10000);
        if chars == 0 || chunks == 0 || ledger.jobs == BATCH_JOBS {
            self.maintenance_save(binding, &ledger)?;
            tx.commit().map_err(io)?;
            return Ok(None);
        }
        let reservation = Reservation {
            token: format!("{:032x}", rand::random::<u128>()),
            generation: binding.generation.clone(),
            expires_at: now.timestamp() + 90,
            scope: scope.clone(),
            chars,
            chunks,
        };
        ledger.chars += chars;
        ledger.chunks += chunks;
        ledger.jobs += 1;
        ledger.reservation = Some(reservation.clone());
        self.maintenance_save(binding, &ledger)?;
        tx.commit().map_err(io)?;
        Ok(Some(reservation))
    }
    pub(crate) fn source_maintenance_settle(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        reservation: &Reservation,
        usage: Option<(usize, usize)>,
        empty: bool,
    ) -> AgentResult<bool> {
        authorize(request, binding, &reservation.scope)?;
        let Some(mut ledger) = self.maintenance_load(binding)? else {
            return Ok(false);
        };
        if reservation.generation != binding.generation
            || ledger.reservation.as_ref().map(|item| &item.token) != Some(&reservation.token)
        {
            return Ok(false);
        }
        if let Some((chars, chunks)) = usage {
            if chars > reservation.chars || chunks > reservation.chunks {
                return Err(invalid());
            }
            ledger.chars -= reservation.chars - chars;
            ledger.chunks -= reservation.chunks - chunks;
        }
        if empty {
            ledger.jobs = ledger.jobs.saturating_sub(1);
        }
        ledger.reservation = None;
        self.maintenance_save(binding, &ledger)?;
        Ok(true)
    }
    pub(crate) fn source_maintenance_continue(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        reservation: &Reservation,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        authorize(request, binding, &reservation.scope)?;
        self.source_live_scope(&reservation.scope)?;
        let Some(ledger) = self.maintenance_load(binding)? else {
            return Ok(false);
        };
        Ok(reservation.generation == binding.generation
            && reservation.expires_at > now.timestamp()
            && ledger.started_at + PERIOD_SECONDS > now.timestamp()
            && ledger.scope == reservation.scope
            && !ledger.paused_scopes.contains(&reservation.scope)
            && ledger.reservation.as_ref().map(|item| &item.token) == Some(&reservation.token)
            && self.source_maintenance_enabled(binding, &reservation.scope)?
            && !self.source_foreground_busy()?)
    }
    pub(crate) fn source_maintenance_index_usage(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &crate::agent::models::ObjectRef,
    ) -> AgentResult<(usize, usize)> {
        authorize(request, binding, &object.scope)?;
        self.source_read_object(request, binding, object)?;
        self.conn.query_row("SELECT json_extract(s.coverage_json,'$.chars'),(SELECT count(*) FROM source_index_chunks c WHERE c.snapshot_id=s.id) FROM source_index_snapshots s WHERE s.object_key=?1 AND s.is_current=1 ORDER BY s.id DESC LIMIT 1", [object.key()?], |row| Ok((row.get::<_,i64>(0)? as usize,row.get::<_,i64>(1)? as usize))).map_err(io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        access::ScopeGrant,
        settings::{AgentScopeSettings, SettingsUpdate},
    };
    use crate::models::ProjectCreateInput;
    fn setup() -> (tempfile::TempDir, Database, RequestContext, DateTime<Utc>) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let request = RequestContext {
            binding: WorkspaceBinding {
                workspace_id: "w".into(),
                generation: "g1".into(),
            },
            caller: Caller::Gui,
            request_id: "maintenance".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into(), "settings.write".into()],
            },
        };
        (root, db, request, Utc::now())
    }
    fn enable(db: &Database) {
        let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
        settings.enabled = true;
        db.agent_settings_update(
            "gui",
            "enable",
            &SettingsUpdate {
                settings,
                expected_revision: 0,
            },
        )
        .unwrap();
    }
    #[test]
    fn source_maintenance_selection_waits_for_enable_and_enforces_grants() {
        let (_root, db, request, now) = setup();
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            now,
        )
        .unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_none());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM agent_jobs WHERE state IN ('queued','running')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        enable(&db);
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_some());
        let mut connection = request.clone();
        connection.caller = Caller::Connection {
            grant_id: "external".into(),
        };
        assert_eq!(
            db.source_maintenance_progress(&connection, &request.binding, &Scope::Workspace, now)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let other = WorkspaceBinding {
            workspace_id: "foreign".into(),
            generation: "g1".into(),
        };
        assert_eq!(
            db.source_maintenance_selected(&other).unwrap_err().code,
            ErrorCode::WorkspaceChanged
        );
        let mut stale = request.clone();
        stale.binding.generation = "old".into();
        assert_eq!(
            db.source_maintenance_reserve(&stale, &request.binding, &Scope::Workspace, now)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[test]
    fn source_maintenance_crash_and_reopen_keep_cumulative_budget_and_reject_old_tokens() {
        let (_root, db, mut request, now) = setup();
        enable(&db);
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            now,
        )
        .unwrap();
        let old = db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_none());
        request.binding.generation = "g2".into();
        let next = db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert!(!db
            .source_maintenance_settle(&request, &request.binding, &old, Some((0, 0)), true)
            .unwrap());
        assert!(db
            .source_maintenance_settle(&request, &request.binding, &next, Some((17, 1)), false)
            .unwrap());
        let progress = db
            .source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert_eq!(progress.charged_chars, old.chars + 17);
        assert_eq!(progress.charged_chunks, old.chunks + 1);
        assert_eq!(progress.attempted_jobs, 2);
        for _ in 0..3 {
            let reserve = db
                .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
                .unwrap()
                .unwrap();
            db.source_maintenance_settle(&request, &request.binding, &reserve, None, false)
                .unwrap();
        }
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_none());
        let progress = db
            .source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert_eq!(progress.charged_chars, BATCH_CHARS);
        assert!(progress.budget_exhausted);
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Resume,
            now,
        )
        .unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_none());
        let later = now + Duration::days(4);
        let reserve = db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, later)
            .unwrap()
            .unwrap();
        let progress = db
            .source_maintenance_progress(&request, &request.binding, &Scope::Workspace, later)
            .unwrap()
            .unwrap();
        assert_eq!(progress.charged_chars, reserve.chars);
        assert_eq!(progress.attempted_jobs, 1);
    }
    #[test]
    fn source_maintenance_cancel_survives_navigation_and_resume_never_erases_usage() {
        let (_root, db, request, now) = setup();
        enable(&db);
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            now,
        )
        .unwrap();
        let reserve = db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Cancel,
            now,
        )
        .unwrap();
        assert!(!db
            .source_maintenance_continue(&request, &request.binding, &reserve, now)
            .unwrap());
        db.source_maintenance_settle(&request, &request.binding, &reserve, None, false)
            .unwrap();
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            now,
        )
        .unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_none());
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Resume,
            now,
        )
        .unwrap();
        let progress = db
            .source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert_eq!(progress.charged_chars, reserve.chars);
        assert!(!progress.cancelled);
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_some());
    }
    #[test]
    fn legacy_cancel_only_pauses_its_selected_scope() {
        let (_root, db, mut request, now) = setup();
        let project_id = db.project_create(ProjectCreateInput { name: "Project".into(), summary: None, status: None }).unwrap().id;
        let project = Scope::Project { project_id };
        request.scope_grant.project_ids.push(project_id);
        enable(&db);
        db.source_maintenance_select(&request, &request.binding, &Scope::Workspace, MaintenanceAction::Activate, now).unwrap();
        let mut legacy: serde_json::Value = serde_json::from_str(&encode(&db.maintenance_load(&request.binding).unwrap().unwrap()).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("pausedScopes");
        legacy["cancelled"] = true.into();
        db.conn.execute("UPDATE agent_jobs SET payload_json=?1 WHERE dedupe_key=?2", params![legacy.to_string(), key(&request.binding)]).unwrap();
        assert!(db.source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now).unwrap().unwrap().cancelled);
        assert!(!db.source_maintenance_progress(&request, &request.binding, &project, now).unwrap().unwrap().cancelled);
        assert_eq!(db.source_maintenance_next(&request.binding, now).unwrap(), Some(project));
        assert!(db.source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now).unwrap().unwrap().cancelled);
    }
    #[test]
    fn independently_enabled_project_is_selected_without_workspace_enable() {
        let (_root, db, _request, now) = setup();
        let project_id = db.project_create(ProjectCreateInput { name: "Project".into(), summary: None, status: None }).unwrap().id;
        let project = Scope::Project { project_id };
        let mut settings = AgentScopeSettings::defaults(project.clone());
        settings.enabled = true;
        db.agent_settings_update("gui", "enable-project", &SettingsUpdate { settings, expected_revision: 0 }).unwrap();
        let binding = WorkspaceBinding { workspace_id: "w".into(), generation: "g1".into() };
        assert_eq!(db.source_maintenance_next(&binding, now).unwrap(), Some(project));
        assert!(!db.agent_settings_get(&Scope::Workspace).unwrap().enabled);
    }
    #[test]
    fn switching_scopes_preserves_global_charge_and_inflight_reservation() {
        let (_root, db, mut request, now) = setup();
        let project_id = db.project_create(ProjectCreateInput { name: "Project".into(), summary: None, status: None }).unwrap().id;
        let project = Scope::Project { project_id };
        request.scope_grant.project_ids.push(project_id);
        enable(&db);
        db.source_maintenance_select(&request, &request.binding, &Scope::Workspace, MaintenanceAction::Activate, now).unwrap();
        let first = db.source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now).unwrap().unwrap();
        assert!(db.source_maintenance_next(&request.binding, now).unwrap().is_none());
        assert_eq!(db.source_maintenance_selected(&request.binding).unwrap(), Some(Scope::Workspace));
        db.source_maintenance_settle(&request, &request.binding, &first, Some((37, 2)), false).unwrap();
        assert_eq!(db.source_maintenance_next(&request.binding, now).unwrap(), Some(project.clone()));
        let project_progress = db.source_maintenance_progress(&request, &request.binding, &project, now).unwrap().unwrap();
        assert_eq!(project_progress.charged_chars, 37);
        assert_eq!(project_progress.charged_chunks, 2);
        assert_eq!(project_progress.attempted_jobs, 1);
        let second = db.source_maintenance_reserve(&request, &request.binding, &project, now).unwrap().unwrap();
        assert!(db.source_maintenance_next(&request.binding, now).unwrap().is_none());
        db.source_maintenance_settle(&request, &request.binding, &second, Some((11, 1)), false).unwrap();
        assert_eq!(db.source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now).unwrap().unwrap().charged_chars, 48);
    }
    #[test]
    fn source_maintenance_reservations_rollback_on_ledger_write_failure() {
        let (_root, db, request, now) = setup();
        enable(&db);
        db.source_maintenance_select(
            &request,
            &request.binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            now,
        )
        .unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_maintenance BEFORE UPDATE ON agent_jobs WHEN OLD.kind='maintenance' BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .is_err());
        let progress = db
            .source_maintenance_progress(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .unwrap();
        assert_eq!(progress.charged_chars, 0);
        assert_eq!(progress.attempted_jobs, 0);
        db.conn
            .execute_batch("DROP TRIGGER fail_maintenance;")
            .unwrap();
        assert!(db
            .source_maintenance_reserve(&request, &request.binding, &Scope::Workspace, now)
            .unwrap()
            .is_some());
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;
    use crate::source_maintenance::{request, step};
    use crate::source_service::{BoundSourceStore, SourceService, SourceUtility};
    use crate::{
        agent::{
            models::{ObjectKind, ObjectRef},
            settings::{AgentScopeSettings, SettingsRepository, SettingsUpdate},
        },
        db::Database,
        models::{TodoCreateInput, TodoScope, WorkspaceRecordUpsertInput},
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    struct Store {
        db: Mutex<Database>,
        binding: Mutex<WorkspaceBinding>,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _: crate::committed_changes::CommittedChanges) {
            assert!(self.db.try_lock().is_ok());
        }
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
        }
    }
    struct NoUtility;
    impl crate::record_document_service::DocumentUtility for NoUtility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> AgentResult<serde_json::Value> {
            panic!("native source must not use a converter")
        }
    }
    impl SourceUtility for NoUtility {
        async fn request(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> AgentResult<serde_json::Value> {
            panic!("non-File source must not use File extraction")
        }
    }
    fn setup(record: bool) -> (tempfile::TempDir, Store, RequestContext, ObjectRef) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("w").unwrap();
        let id = if record {
            db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("原始材料".into()),
                html: "<p>真实证据🙂</p>".into(),
                markdown: "真实证据🙂".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap()
            .id
        } else {
            db.todo_create(TodoCreateInput {
                scope: TodoScope::Workspace,
                project_id: None,
                content: "真实行动🙂".into(),
                priority: "not_urgent_important".into(),
                due_date: None,
                tag_ids: vec![],
            })
            .unwrap()
            .id
        };
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g1".into(),
        };
        let request = request(binding.clone(), &Scope::Workspace, "test".into());
        let mut settings = AgentScopeSettings::defaults(Scope::Workspace);
        settings.enabled = true;
        db.agent_settings_update(
            "gui",
            "enable",
            &SettingsUpdate {
                settings,
                expected_revision: 0,
            },
        )
        .unwrap();
        db.source_maintenance_select(
            &request,
            &binding,
            &Scope::Workspace,
            MaintenanceAction::Activate,
            chrono::Utc::now(),
        )
        .unwrap();
        db.source_queue_backfill(
            &request,
            &binding,
            &Scope::Workspace,
            200,
            chrono::Utc::now() - chrono::Duration::seconds(1),
        )
        .unwrap();
        let object = ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Workspace,
            kind: if record {
                ObjectKind::Record
            } else {
                ObjectKind::Todo
            },
            id: id.to_string(),
        };
        (
            root,
            Store {
                db: Mutex::new(db),
                binding: Mutex::new(binding),
            },
            request,
            object,
        )
    }
    fn progress(store: &Store, request: &RequestContext) -> MaintenanceProgress {
        store
            .with_current(|binding, db| {
                db.source_maintenance_progress(
                    request,
                    binding,
                    &Scope::Workspace,
                    chrono::Utc::now(),
                )
            })
            .unwrap()
            .unwrap()
    }
    fn foreground(db: &Database) {
        // A real persisted run fixture, using the registered session schema.
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','Foreground','runtime','active',?2,'now','now')",rusqlite::params!["1234567890abcdef1234567890abcdef",".project-mind/agent/sessions/1234567890abcdef1234567890abcdef/session.jsonl"]).unwrap();
        db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES ('foreground',?1,'request','running','{}','{}','now')",["1234567890abcdef1234567890abcdef"]).unwrap();
    }
    #[tokio::test]
    async fn source_maintenance_driver_indexes_real_todo_and_refunds_unused_reservation() {
        let (_root, store, request, object) = setup(false);
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        let result = progress(&store, &request);
        let usage = store
            .with_current(|binding, db| {
                db.source_maintenance_index_usage(&request, binding, &object)
            })
            .unwrap();
        assert_eq!(result.charged_chars, usage.0);
        assert_eq!(result.charged_chunks, usage.1);
        assert!(usage.0 > 0 && usage.0 < 1000);
        assert_eq!(result.attempted_jobs, 1);
        assert_eq!(result.pending_jobs, 0);
        assert_eq!(result.partial_sources, 0);
        assert!(result.backfill_complete);
        let before = result.charged_chars;
        let writes = store.db.lock().unwrap().conn.total_changes();
        assert!(!step(&store, &NoUtility, &NoUtility).await.unwrap());
        assert_eq!(store.db.lock().unwrap().conn.total_changes(), writes);
        assert_eq!(progress(&store, &request).charged_chars, before);
        assert_eq!(progress(&store, &request).attempted_jobs, 1);
    }
    #[tokio::test]
    async fn source_maintenance_completed_job_keeps_partial_coverage_visible() {
        let (_root, store, request, _) = setup(false);
        {
            let db = store.db.lock().unwrap();
            let mut ledger = db.maintenance_load(&request.binding).unwrap().unwrap();
            ledger.chars = BATCH_CHARS - 10;
            db.maintenance_save(&request.binding, &ledger).unwrap();
        }
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
        let result = progress(&store, &request);
        assert_eq!(result.pending_jobs, 0);
        assert_eq!(result.partial_sources, 1);
        assert_eq!(result.charged_chars, BATCH_CHARS);
        assert!(result.budget_exhausted);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .conn
                .query_row(
                    "SELECT state FROM agent_jobs WHERE kind='extract'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "completed"
        );
    }
    #[tokio::test]
    async fn source_maintenance_foreground_run_prevents_claiming_background_work() {
        let (_root, store, request, _) = setup(false);
        foreground(&store.db.lock().unwrap());
        assert!(!step(&store, &NoUtility, &NoUtility).await.unwrap());
        let result = progress(&store, &request);
        assert!(result.foreground_busy);
        assert_eq!(result.pending_jobs, 1);
        assert_eq!(result.attempted_jobs, 0);
        store
            .db
            .lock()
            .unwrap()
            .conn
            .execute(
                "UPDATE agent_runs SET state='completed' WHERE id='foreground'",
                [],
            )
            .unwrap();
        assert!(step(&store, &NoUtility, &NoUtility).await.unwrap());
    }
    struct PendingConverter {
        entered: tokio::sync::Notify,
        dropped: AtomicBool,
    }
    struct Dropped<'a>(&'a AtomicBool);
    impl Drop for Dropped<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    impl crate::record_document_service::DocumentUtility for PendingConverter {
        async fn request(
            &self,
            _: &str,
            method: &str,
            _: serde_json::Value,
        ) -> AgentResult<serde_json::Value> {
            assert_eq!(method, "record.initialize");
            let _drop = Dropped(&self.dropped);
            self.entered.notify_one();
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn source_maintenance_cancel_and_foreground_preempt_drop_conversion_and_yield_without_retry(
    ) {
        for cancel in [true, false] {
            let (_root, store, request, _) = setup(true);
            let converter = PendingConverter {
                entered: tokio::sync::Notify::new(),
                dropped: AtomicBool::new(false),
            };
            let interruption = async {
                converter.entered.notified().await;
                let db = store.db.lock().unwrap();
                if cancel {
                    db.source_maintenance_select(
                        &request,
                        &request.binding,
                        &Scope::Workspace,
                        MaintenanceAction::Cancel,
                        chrono::Utc::now(),
                    )
                    .unwrap();
                } else {
                    foreground(&db);
                }
            };
            let (result, ()) = tokio::join!(step(&store, &converter, &NoUtility), interruption);
            assert!(result.unwrap());
            assert!(converter.dropped.load(Ordering::Acquire));
            let db = store.db.lock().unwrap();
            let (state, attempt): (String, i64) = db
                .conn
                .query_row(
                    "SELECT state,attempt FROM agent_jobs WHERE kind='extract'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(state, "queued");
            assert_eq!(attempt, 0);
            assert_eq!(
                db.conn
                    .query_row("SELECT count(*) FROM record_document_heads", [], |row| row
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                0
            );
            drop(db);
            let result = progress(&store, &request);
            assert_eq!(result.pending_jobs, 1);
            assert_eq!(result.failed_jobs, 0);
            assert_eq!(result.cancelled, cancel);
            assert_eq!(result.charged_chars, 2 * 1024 * 1024);
        }
    }
    #[tokio::test]
    #[ignore = "requires prepared fixed Node document converter"]
    async fn source_maintenance_driver_runs_real_legacy_conversion_and_persists_searchable_index() {
        let (_root, store, request, object) = setup(true);
        let converter = crate::record_document_worker::RecordDocumentWorker::development().unwrap();
        assert!(step(&store, &converter, &NoUtility).await.unwrap());
        let page = SourceService::new(&store)
            .search(
                &request,
                &crate::source_service::SourceSearchInput {
                    scope: Scope::Workspace,
                    query: "真实证据".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: None,
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].source_ref.object, object);
        assert!(page.items[0].coverage.complete);
        let result = progress(&store, &request);
        assert!(result.charged_chars < 1000);
        assert_eq!(result.pending_jobs, 0);
        assert_eq!(
            store
                .db
                .lock()
                .unwrap()
                .conn
                .query_row("SELECT count(*) FROM record_versions", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }
}
