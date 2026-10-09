//! Durable Project Overview maintenance. Jobs hold control and source cursors;
//! Overview versions remain the sole publication record.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    context::SourceCoverage,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    overview::{OverviewPendingItem, OverviewPublishInput},
    settings::SettingsRepository,
};
use crate::source_service::SourceReadTarget;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OverviewSourceState {
    Processed,
    Partial,
    Excluded,
    Unsupported,
    Deleted,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewSourceProgress {
    pub object: ObjectRef,
    /// Exact source.read target, including a pinned File or Record version.
    pub read_target: Option<SourceReadTarget>,
    pub read_cursor: Option<String>,
    pub state: OverviewSourceState,
    pub handled_seq: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewMaintenanceBatch {
    pub scope: Scope,
    pub batch_id: String,
    pub target_seq: u64,
    pub expected_revision: u64,
    pub policy_revision: u64,
    pub correction_revision: u64,
    pub source: OverviewPendingItem,
    pub source_object: ObjectRef,
    pub source_cursor: Option<String>,
    pub source_read_target: Option<SourceReadTarget>,
    /// Native source.read page size used by the saved draft's evidence.
    #[serde(default)]
    pub source_page_budget_chars: Option<usize>,
    /// Frozen, contiguous current-branch messages following the primary source.
    #[serde(default)]
    pub source_items: Vec<OverviewPendingItem>,
    #[serde(default)]
    pub sources_frozen: bool,
    pub draft: Option<OverviewPublishInput>,
    pub next_progress: Option<OverviewSourceProgress>,
    #[serde(default)]
    pub next_progresses: Vec<OverviewSourceProgress>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    cancelled: bool,
    error_code: Option<ErrorCode>,
    #[serde(default)]
    continuation_target_seq: Option<u64>,
    batch: Option<OverviewMaintenanceBatch>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            cancelled: false,
            error_code: None,
            continuation_target_seq: None,
            batch: None,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewMaintenanceStatus {
    pub scope: Scope,
    pub cancelled: bool,
    pub error_code: Option<ErrorCode>,
    pub batch_id: Option<String>,
    pub pending_count: u64,
    pub coverage: SourceCoverage,
    pub deleted_count: u64,
    /// A completed metadata directory is not evidence that bodies were read.
    pub directory_complete: bool,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn conflict(message: &str) -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, message)
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid Overview maintenance state"))
}
fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> AgentResult<T> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Damaged Overview maintenance state"))
}
fn control_key(scope: &Scope) -> String {
    format!("overview-maintenance:{}", scope.key())
}
fn source_key(object: &ObjectRef) -> AgentResult<String> {
    Ok(format!("overview-source:{}", object.key()?))
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn object_from_key(binding: &WorkspaceBinding, scope: &Scope, key: &str) -> AgentResult<ObjectRef> {
    crate::agent::overview::validate_pending_key(key, scope)?;
    let parts: Vec<_> = key.split('/').collect();
    if parts[0] != binding.workspace_id {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Overview source belongs to another Workspace",
        ));
    }
    let kind: ObjectKind = serde_json::from_value(serde_json::Value::String(parts[2].into()))
        .map_err(|_| invalid("Invalid Overview source kind"))?;
    Ok(ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: scope.clone(),
        kind,
        id: parts[3].into(),
    })
}
fn read_ledger(conn: &rusqlite::Connection, scope: &Scope) -> AgentResult<Ledger> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM agent_jobs WHERE kind='overview' AND dedupe_key=?1",
            [control_key(scope)],
            |row| row.get(0),
        )
        .optional()
        .map_err(io_error)?;
    raw.map(|value| decode(&value))
        .transpose()
        .map(|v| v.unwrap_or_default())
}
fn write_ledger(
    tx: &Transaction<'_>,
    scope: &Scope,
    ledger: &Ledger,
    now: DateTime<Utc>,
) -> AgentResult<()> {
    let key = control_key(scope);
    let state = if ledger.cancelled {
        "cancelled"
    } else if ledger.error_code.is_some() {
        "failed"
    } else if ledger.batch.is_some() {
        "running"
    } else {
        "completed"
    };
    tx.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,attempt,not_before,payload_json,error)
        VALUES (?1,'overview',?2,?3,?4,0,?5,?6,?7)
        ON CONFLICT(dedupe_key) DO UPDATE SET state=excluded.state,not_before=excluded.not_before,
        payload_json=excluded.payload_json,error=excluded.error",
        params![key, scope.key(), key, state, stamp(now), encode(ledger)?, ledger.error_code.map(|code| format!("{code:?}"))]).map_err(io_error)?;
    Ok(())
}
fn check_scope(db: &Database, binding: &WorkspaceBinding, scope: &Scope) -> AgentResult<()> {
    if db.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Overview Workspace is no longer current",
        ));
    }
    if !matches!(scope, Scope::Project { .. }) {
        return Err(invalid("Overview maintenance requires a Project"));
    }
    db.source_live_scope(scope)?;
    db.agent_overview_pending_status(scope)?;
    Ok(())
}
fn read_progress(
    conn: &rusqlite::Connection,
    object: &ObjectRef,
) -> AgentResult<Option<OverviewSourceProgress>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM agent_jobs WHERE kind='overview' AND dedupe_key=?1",
            [source_key(object)?],
            |row| row.get(0),
        )
        .optional()
        .map_err(io_error)?;
    raw.map(|raw| decode(&raw)).transpose()
}
fn write_progress(
    tx: &Transaction<'_>,
    scope: &Scope,
    progress: &OverviewSourceProgress,
    now: DateTime<Utc>,
) -> AgentResult<()> {
    let key = source_key(&progress.object)?;
    tx.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,attempt,not_before,payload_json,error)
        VALUES (?1,'overview',?2,?3,'completed',0,?4,?5,NULL)
        ON CONFLICT(dedupe_key) DO UPDATE SET state='completed',not_before=excluded.not_before,payload_json=excluded.payload_json,error=NULL",
        params![key, scope.key(), key, stamp(now), encode(progress)?]).map_err(io_error)?;
    Ok(())
}
fn id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

impl Database {
    pub(crate) fn agent_overview_maintenance_status(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<OverviewMaintenanceStatus> {
        check_scope(self, binding, scope)?;
        let ledger = read_ledger(&self.conn, scope)?;
        let (pending, needs_rebuild): (i64, bool) = self
            .conn
            .query_row(
                "SELECT
            (SELECT count(*) FROM agent_overview_pending WHERE scope_key=?1),needs_rebuild
            FROM agent_overview_pending_state WHERE scope_key=?1",
                [scope.key()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(io_error)?;
        let (coverage, deleted_count) = self.maintenance_coverage_read(binding, scope, &[])?;
        Ok(OverviewMaintenanceStatus {
            scope: scope.clone(),
            cancelled: ledger.cancelled,
            error_code: ledger.error_code,
            batch_id: ledger.batch.map(|v| v.batch_id),
            pending_count: pending as u64,
            coverage,
            deleted_count,
            directory_complete: !needs_rebuild,
        })
    }
    pub(crate) fn agent_overview_maintenance_coverage(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        next_progress: Option<&OverviewSourceProgress>,
    ) -> AgentResult<SourceCoverage> {
        check_scope(self, binding, scope)?;
        self.maintenance_coverage_read(binding, scope, next_progress.map(std::slice::from_ref).unwrap_or(&[]))
            .map(|v| v.0)
    }
    pub(crate) fn agent_overview_maintenance_coverage_many(&self, binding: &WorkspaceBinding, scope: &Scope, progresses: &[OverviewSourceProgress]) -> AgentResult<SourceCoverage> {
        check_scope(self,binding,scope)?;
        self.maintenance_coverage_read(binding,scope,progresses).map(|v|v.0)
    }
    fn maintenance_coverage_read(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        next_progress: &[OverviewSourceProgress],
    ) -> AgentResult<(SourceCoverage, u64)> {
        for progress in next_progress {
            if progress.object.workspace_id != binding.workspace_id
                || progress.object.scope != *scope
            {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Overview progress belongs to another scope",
                ));
            }
        }
        let mut coverage = SourceCoverage {
            processed: 0,
            partial: 0,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        };
        let mut deleted_count = 0;
        let mut stmt = self.conn.prepare("WITH objects AS (
              SELECT object_key,last_change_seq AS seq FROM source_registry WHERE scope_key=?1 AND object_key LIKE ?2
              UNION ALL SELECT object_key,last_seq FROM agent_overview_pending WHERE scope_key=?1 AND object_key LIKE ?2
              UNION ALL SELECT substr(dedupe_key,length('overview-source:')+1),0 FROM agent_jobs
                WHERE kind='overview' AND scope_key=?1 AND dedupe_key LIKE ?3
            ), distinct_objects AS (SELECT object_key,MAX(seq) AS seq FROM objects GROUP BY object_key)
            SELECT o.object_key,o.seq,j.payload_json FROM distinct_objects o
            LEFT JOIN agent_jobs j ON j.kind='overview' AND j.dedupe_key='overview-source:'||o.object_key").map_err(io_error)?;
        let rows = stmt
            .query_map(
                params![
                    scope.key(),
                    format!("{}/{}/%", binding.workspace_id, scope.key()),
                    format!("overview-source:{}/{}/%", binding.workspace_id, scope.key())
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(io_error)?;
        for row in rows {
            let (key, seq, raw) = row.map_err(io_error)?;
            let progress = if let Some(progress) = next_progress.iter().find(|p| p.object.key().ok().as_deref() == Some(key.as_str()))
            {
                Some(progress.clone())
            } else {
                raw.map(|raw| decode(&raw)).transpose()?
            };
            let Some(progress) = progress else {
                coverage.pending += 1;
                continue;
            };
            if progress.object.key()? != key || progress.handled_seq < seq as u64 {
                coverage.pending += 1;
                continue;
            }
            match progress.state {
                OverviewSourceState::Processed => coverage.processed += 1,
                OverviewSourceState::Partial => {
                    coverage.partial += 1;
                    coverage.pending += 1;
                }
                OverviewSourceState::Excluded => coverage.excluded += 1,
                OverviewSourceState::Unsupported => coverage.unsupported += 1,
                OverviewSourceState::Deleted => deleted_count += 1,
            }
        }
        let mut pending_stmt = self
            .conn
            .prepare(
                "SELECT object_key,last_seq FROM agent_overview_pending
            WHERE scope_key=?1 AND object_key LIKE ?2",
            )
            .map_err(io_error)?;
        let native_pending = pending_stmt
            .query_map(
                params![
                    scope.key(),
                    format!("{}/{}/%", binding.workspace_id, scope.key())
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(io_error)?;
        let mut native_count = 0u64;
        for row in native_pending {
            let (key, seq) = row.map_err(io_error)?;
            let settled = next_progress.iter().any(|p| {
                p.state != OverviewSourceState::Partial
                    && p.object.key().ok().as_deref() == Some(key.as_str())
                    && p.handled_seq >= seq as u64
            });
            if !settled {
                native_count += 1;
            }
        }
        coverage.pending = coverage.pending.max(native_count);
        Ok((coverage, deleted_count))
    }
    pub(crate) fn agent_overview_maintenance_prepare(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<OverviewMaintenanceBatch>> {
        check_scope(self, binding, scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        if ledger.cancelled || ledger.error_code.is_some() {
            return Ok(None);
        }
        if let Some(batch) = ledger.batch {
            return Ok(Some(batch));
        }
        let fresh_target: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq),0) FROM agent_change_log",
                [],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        let continued = if let Some(seq) = ledger
            .continuation_target_seq
            .and_then(|seq| i64::try_from(seq).ok())
        {
            let remains: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_overview_pending
                WHERE scope_key=?1 AND last_seq<=?2 AND object_key LIKE ?3)",
                    params![
                        scope.key(),
                        seq,
                        format!("{}/{}/%", binding.workspace_id, scope.key())
                    ],
                    |row| row.get(0),
                )
                .map_err(io_error)?;
            remains.then_some(seq)
        } else {
            None
        };
        let target_seq = continued.unwrap_or(fresh_target);
        let settings = self.agent_settings_get(scope)?;
        let goal_key = settings
            .goal_record_id
            .map(|id| {
                ObjectRef {
                    workspace_id: binding.workspace_id.clone(),
                    scope: scope.clone(),
                    kind: ObjectKind::Record,
                    id: id.to_string(),
                }
                .key()
            })
            .transpose()?;
        let pin_keys = settings
            .pinned_refs
            .iter()
            .map(ObjectRef::key)
            .collect::<AgentResult<Vec<_>>>()?;
        let pin_keys_json = encode(&pin_keys)?;
        let project_id = match scope {
            Scope::Project { project_id } => *project_id,
            Scope::Workspace => unreachable!(),
        };
        let selected: Option<(String,i64,i64,String,String,bool,bool)> = tx.query_row(
            "SELECT p.object_key,p.first_seq,p.last_seq,p.operation,p.latest_revision,p.deleted,p.excluded
             FROM agent_overview_pending p LEFT JOIN agent_jobs j ON j.kind='overview' AND j.dedupe_key='overview-source:'||p.object_key
             WHERE p.scope_key=?1 AND p.last_seq<=?2 AND p.object_key LIKE ?3
             ORDER BY CASE
                 WHEN json_extract(j.payload_json,'$.state')='partial'
                   AND CAST(json_extract(j.payload_json,'$.handledSeq') AS INTEGER)=p.last_seq THEN 0
                 WHEN p.object_key=?4 THEN 1
                 WHEN p.object_key IN (SELECT value FROM json_each(?5)) THEN 2
                 WHEN EXISTS (SELECT 1 FROM todos t WHERE t.scope='project' AND t.project_id=?6
                   AND t.status='unfinished' AND p.object_key=?7||t.id) THEN 3
                 ELSE 4 END,
                 CASE WHEN p.object_key LIKE ?8 THEN COALESCE((SELECT m.ordinal FROM agent_messages m WHERE m.id=substr(p.object_key,length(?9)+1)),9223372036854775807) ELSE 0 END,
                 p.object_key LIMIT 1",
            params![scope.key(),target_seq,format!("{}/{}/%",binding.workspace_id,scope.key()),goal_key,pin_keys_json,project_id,format!("{}/{}/todo/",binding.workspace_id,scope.key()),format!("{}/{}/session_message/%",binding.workspace_id,scope.key()),format!("{}/{}/session_message/",binding.workspace_id,scope.key())],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))
        ).optional().map_err(io_error)?;
        let Some((object_key, first_seq, last_seq, operation, latest_revision, deleted, excluded)) =
            selected
        else {
            return Ok(None);
        };
        let object = object_from_key(binding, scope, &object_key)?;
        let previous = read_progress(&tx, &object)?;
        let current_partial = previous.filter(|p| {
            p.state == OverviewSourceState::Partial && p.handled_seq == last_seq as u64
        });
        let expected_revision: i64 = tx
            .query_row(
                "SELECT current_revision FROM agent_overviews WHERE scope_key=?1",
                [scope.key()],
                |r| r.get(0),
            )
            .optional()
            .map_err(io_error)?
            .unwrap_or(0);
        let policy_revision: i64 = tx
            .query_row(
                "SELECT revision FROM agent_scope_settings WHERE scope_key=?1",
                [scope.key()],
                |r| r.get(0),
            )
            .optional()
            .map_err(io_error)?
            .unwrap_or(0);
        let correction_revision: i64 = tx
            .query_row(
                "SELECT revision FROM agent_overview_correction_heads WHERE scope_key=?1",
                [scope.key()],
                |r| r.get(0),
            )
            .optional()
            .map_err(io_error)?
            .unwrap_or(0);
        let batch = OverviewMaintenanceBatch {
            scope: scope.clone(),
            batch_id: id(),
            target_seq: target_seq as u64,
            expected_revision: expected_revision as u64,
            policy_revision: policy_revision as u64,
            correction_revision: correction_revision as u64,
            source: OverviewPendingItem {
                object_key,
                first_seq: first_seq as u64,
                last_seq: last_seq as u64,
                operation,
                latest_revision,
                deleted,
                excluded,
            },
            source_object: object,
            source_cursor: current_partial.as_ref().and_then(|p| p.read_cursor.clone()),
            source_page_budget_chars: None,
            source_read_target: current_partial.as_ref().and_then(|p| p.read_target.clone()),
            source_items: vec![],
            sources_frozen: false,
            draft: None,
            next_progress: None,
            next_progresses: vec![],
        };
        ledger.batch = Some(batch.clone());
        ledger.continuation_target_seq = Some(target_seq as u64);
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)?;
        Ok(Some(batch))
    }
    /// Candidate succession is determined by current Pi branch ordinal. A
    /// historical message has no current row, so it remains a single source.
    pub(crate) fn agent_overview_message_successors(
        &self,
        binding: &WorkspaceBinding,
        batch: &OverviewMaintenanceBatch,
    ) -> AgentResult<Vec<OverviewPendingItem>> {
        check_scope(self, binding, &batch.scope)?;
        if batch.source_object.kind != ObjectKind::SessionMessage || batch.source.deleted || batch.source.excluded || batch.source_cursor.is_some() {
            return Ok(vec![]);
        }
        let mut stmt = self.conn.prepare("SELECT p.object_key,p.first_seq,p.last_seq,p.operation,p.latest_revision,p.deleted,p.excluded,COALESCE(i.total_chars,12000)
            FROM agent_messages first JOIN agent_messages next ON next.session_id=first.session_id AND next.ordinal>first.ordinal
            JOIN agent_overview_pending p ON p.object_key=?1||next.id AND p.scope_key=?2
            LEFT JOIN agent_session_search_rows i ON i.message_id=next.id
            WHERE first.id=?3 AND p.last_seq<=?4
            ORDER BY next.ordinal").map_err(io_error)?;
        let rows = stmt.query_map(params![format!("{}/{}/session_message/",binding.workspace_id,batch.scope.key()),batch.scope.key(),batch.source_object.id,batch.target_seq as i64],|row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,bool>(5)?,row.get::<_,bool>(6)?,row.get::<_,i64>(7)?))).map_err(io_error)?;
        let mut result = Vec::new();
        let mut previous = batch.source_object.id.clone();
        let mut chars=0usize;
        for row in rows {
            let (object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded,total_chars)=row.map_err(io_error)?;
            if deleted || excluded { break; }
            let object = object_from_key(binding,&batch.scope,&object_key)?;
            if !self.agent_session_message_precedes_adjacent(&previous,&object.id)? { break; }
            result.push(OverviewPendingItem { object_key,first_seq:first_seq as u64,last_seq:last_seq as u64,operation,latest_revision,deleted,excluded });
            previous = object.id;
            chars=chars.saturating_add(total_chars.max(0) as usize);
            if chars>=48000 { break; }
        }
        Ok(result)
    }
    fn agent_session_message_precedes_adjacent(&self, older: &str, newer: &str) -> AgentResult<bool> {
        self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_messages a JOIN agent_messages b ON b.session_id=a.session_id AND b.ordinal=a.ordinal+1 WHERE a.id=?1 AND b.id=?2)",params![older,newer],|row|row.get(0)).map_err(io_error)
    }
    pub(crate) fn agent_overview_maintenance_validate_sources(&self, request:&RequestContext, binding:&WorkspaceBinding, scope:&Scope, batch_id:&str) -> AgentResult<()> {
        check_scope(self,binding,scope)?;
        let ledger=read_ledger(&self.conn,scope)?;
        let batch=ledger.batch.ok_or_else(||conflict("Overview batch is unavailable"))?;
        if batch.batch_id!=batch_id || (!batch.sources_frozen && !(batch.draft.is_some() && batch.source_items.is_empty())) { return Err(conflict("Overview batch sources are not frozen")); }
        let mut predecessor=batch.source_object.id.clone();
        for source in std::iter::once(&batch.source).chain(&batch.source_items) {
            let current:Option<(i64,String,bool,bool)>=self.conn.query_row("SELECT last_seq,latest_revision,deleted,excluded FROM agent_overview_pending WHERE scope_key=?1 AND object_key=?2",params![scope.key(),source.object_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(io_error)?;
            if current!=Some((source.last_seq as i64,source.latest_revision.clone(),source.deleted,source.excluded)) { return Err(AgentError::new(ErrorCode::SourceChanged,"Overview batch source changed")); }
            if !source.deleted && !source.excluded {
                let object=object_from_key(binding,scope,&source.object_key)?;
                if object.kind==ObjectKind::SessionMessage {
                    self.source_session_record(request,binding,&SourceReadTarget { object,revision:None,record_version:None,file_version:None })
                        .map_err(|error| if matches!(error.code,ErrorCode::NotFound|ErrorCode::ObjectWithdrawn|ErrorCode::ScopeDenied) { AgentError::new(ErrorCode::SourceChanged,"Session batch provenance is no longer visible") } else { error })?;
                }
            }
        }
        for source in &batch.source_items {
            let object=object_from_key(binding,scope,&source.object_key)?;
            if !self.agent_session_message_precedes_adjacent(&predecessor,&object.id)? { return Err(AgentError::new(ErrorCode::SourceChanged,"Session batch branch changed")); }
            predecessor=object.id;
        }
        Ok(())
    }
    pub(crate) fn agent_overview_maintenance_freeze_sources(&self, binding: &WorkspaceBinding, scope: &Scope, batch_id: &str, sources: Vec<OverviewPendingItem>, now: DateTime<Utc>) -> AgentResult<()> {
        check_scope(self,binding,scope)?;
        let tx=Transaction::new_unchecked(&self.conn,TransactionBehavior::Immediate).map_err(io_error)?;
        let mut ledger=read_ledger(&tx,scope)?;
        let batch=ledger.batch.as_mut().ok_or_else(||conflict("Overview batch is unavailable"))?;
        if batch.batch_id!=batch_id || batch.draft.is_some() { return Err(conflict("Overview batch changed")); }
        if batch.sources_frozen && encode(&batch.source_items)? != encode(&sources)? { return Err(conflict("Overview batch sources already frozen")); }
        for source in &sources {
            let current: Option<(i64,String,bool,bool)> = tx.query_row("SELECT last_seq,latest_revision,deleted,excluded FROM agent_overview_pending WHERE object_key=?1 AND scope_key=?2",params![source.object_key,scope.key()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(io_error)?;
            if current != Some((source.last_seq as i64,source.latest_revision.clone(),false,false)) { return Err(AgentError::new(ErrorCode::SourceChanged,"Overview source changed before batch freeze")); }
        }
        batch.source_items=sources;
        batch.sources_frozen=true;
        write_ledger(&tx,scope,&ledger,now)?;
        tx.commit().map_err(io_error)
    }
    pub(crate) fn agent_overview_maintenance_save_draft(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        publish: &OverviewPublishInput,
        progress: &OverviewSourceProgress,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        self.agent_overview_maintenance_save_draft_many(binding,scope,batch_id,publish,std::slice::from_ref(progress),None,now)
    }
    pub(crate) fn agent_overview_maintenance_save_draft_many(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        publish: &OverviewPublishInput,
        progresses: &[OverviewSourceProgress],
        source_page_budget_chars: Option<usize>,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        check_scope(self, binding, scope)?;
        publish.validate()?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        if ledger.cancelled || ledger.error_code.is_some() {
            return Err(conflict("Overview maintenance is paused"));
        }
        let batch = ledger
            .batch
            .as_mut()
            .ok_or_else(|| conflict("Overview maintenance batch is unavailable"))?;
        if progresses.len() != batch.source_items.len()+1 { return Err(conflict("Overview progress count differs from frozen sources")); }
        for (source,progress) in std::iter::once(&batch.source).chain(&batch.source_items).zip(progresses) {
            let object=object_from_key(binding,scope,&source.object_key)?;
            if progress.object!=object || progress.handled_seq!=source.last_seq ||
                progress.read_target.as_ref().is_some_and(|target| target.object!=object || target.revision.as_ref().is_some_and(|v|v.len()>128)) ||
                (progress.read_cursor.is_some() && progress.read_target.is_none()) ||
                (progress.state==OverviewSourceState::Partial && progress.read_cursor.is_none()) ||
                progress.read_cursor.as_ref().is_some_and(|v|v.len()>4096) {
                return Err(conflict("Overview batch progress changed"));
            }
            let current: Option<(i64,String,bool,bool)> = tx.query_row("SELECT last_seq,latest_revision,deleted,excluded FROM agent_overview_pending WHERE scope_key=?1 AND object_key=?2",params![scope.key(),source.object_key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(io_error)?;
            if current != Some((source.last_seq as i64,source.latest_revision.clone(),source.deleted,source.excluded)) {
                return Err(AgentError::new(ErrorCode::SourceChanged,"Overview source changed during batch"));
            }
        }
        let mut predecessor=batch.source_object.id.clone();
        for source in &batch.source_items {
            let object=object_from_key(binding,scope,&source.object_key)?;
            if !self.agent_session_message_precedes_adjacent(&predecessor,&object.id)? {
                return Err(AgentError::new(ErrorCode::SourceChanged,"Session batch branch changed"));
            }
            predecessor=object.id;
        }
        let progress=&progresses[0];
        if batch.batch_id != batch_id
            || publish.batch_id != batch_id
            || publish.scope != *scope
            || batch.scope != *scope
            || publish.expected_revision != batch.expected_revision
            || publish.target_seq != batch.target_seq
            || publish.policy_revision != batch.policy_revision
            || publish.correction_revision != batch.correction_revision
            || progress.object != batch.source_object
            || progress.handled_seq != batch.source.last_seq
            || progress.read_target.as_ref().is_some_and(|target| {
                target.object != progress.object
                    || target.revision.as_ref().is_some_and(|v| v.len() > 128)
            })
            || (progress.read_cursor.is_some() && progress.read_target.is_none())
            || (progress.state == OverviewSourceState::Partial
                && (progress.read_cursor.is_none() || progress.read_cursor == batch.source_cursor))
            || progress
                .read_cursor
                .as_ref()
                .is_some_and(|v| v.len() > 4096)
        {
            return Err(conflict("Overview maintenance batch or source changed"));
        }
        let expected_settled: Vec<_> = progresses.iter().filter(|p|p.state!=OverviewSourceState::Partial).map(|p|p.object.key()).collect::<AgentResult<_>>()?;
        let mut actual=publish.settled_object_keys.clone(); actual.sort();
        let mut expected=expected_settled; expected.sort();
        if actual != expected {
            return Err(invalid(
                "Overview draft settlement differs from source progress",
            ));
        }
        let preview = self
            .maintenance_coverage_read(binding, scope, progresses)?
            .0;
        if serde_json::to_value(&preview).map_err(|_| invalid("Invalid Overview coverage"))?
            != serde_json::to_value(&publish.coverage)
                .map_err(|_| invalid("Invalid Overview coverage"))?
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Source coverage changed during knowledge maintenance",
            ));
        }
        if let Some(previous) = &batch.draft {
            let prior_progress = batch.next_progress.as_ref().ok_or_else(|| {
                AgentError::new(ErrorCode::IoFailed, "Overview draft progress is missing")
            })?;
            if encode(previous)? == encode(publish)? && encode(prior_progress)? == encode(progress)? && encode(&batch.next_progresses)? == encode(&progresses[1..].to_vec())?
            {
                return Ok(());
            }
            return Err(AgentError::new(
                ErrorCode::IdempotencyConflict,
                "Overview batch already has another draft",
            ));
        }
        batch.source_page_budget_chars = source_page_budget_chars;
        batch.draft = Some(publish.clone());
        batch.next_progress = Some(progress.clone());
        batch.next_progresses = progresses[1..].to_vec();
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)?;
        Ok(())
    }
    pub(crate) fn agent_overview_maintenance_complete(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        now: DateTime<Utc>,
    ) -> AgentResult<OverviewMaintenanceStatus> {
        check_scope(self, binding, scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        let batch = ledger
            .batch
            .as_ref()
            .ok_or_else(|| conflict("Overview maintenance batch is unavailable"))?;
        if batch.batch_id != batch_id {
            return Err(conflict("Overview maintenance batch changed"));
        }
        let draft = batch
            .draft
            .as_ref()
            .ok_or_else(|| conflict("Overview maintenance draft is unavailable"))?;
        let progress = batch
            .next_progress
            .as_ref()
            .ok_or_else(|| conflict("Overview maintenance progress is unavailable"))?;
        let published: Option<String> = tx.query_row("SELECT payload_json FROM agent_overview_versions WHERE scope_key=?1 AND batch_id=?2",
            params![scope.key(),batch_id], |row| row.get(0)).optional().map_err(io_error)?;
        let Some(published) = published else {
            return Err(conflict("Overview batch has not been published"));
        };
        if serde_json::from_str::<serde_json::Value>(&published)
            .map_err(|_| invalid("Damaged Overview publication"))?
            != serde_json::to_value(draft).map_err(|_| invalid("Invalid Overview draft"))?
        {
            return Err(AgentError::new(
                ErrorCode::IdempotencyConflict,
                "Published Overview batch differs from saved draft",
            ));
        }
        write_progress(&tx, scope, progress, now)?;
        for progress in &batch.next_progresses { write_progress(&tx,scope,progress,now)?; }
        ledger.batch = None;
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)?;
        self.agent_overview_maintenance_status(binding, scope)
    }
    pub(crate) fn agent_overview_maintenance_cancel(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        check_scope(self, binding, scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        ledger.cancelled = true;
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)
    }
    pub(crate) fn agent_overview_maintenance_resume(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        check_scope(self, binding, scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        if matches!(
            ledger.error_code,
            Some(ErrorCode::SourceChanged | ErrorCode::RevisionConflict | ErrorCode::RateLimited | ErrorCode::BudgetExceeded)
        ) {
            if let Some(batch) = &ledger.batch {
                let published: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_overview_versions WHERE scope_key=?1 AND batch_id=?2)",
                    params![scope.key(),batch.batch_id], |row| row.get(0)).map_err(io_error)?;
                if !published {
                    ledger.batch = None;
                }
            }
        }
        ledger.cancelled = false;
        ledger.error_code = None;
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)
    }
    pub(crate) fn agent_overview_maintenance_fail(
        &self,
        binding: &WorkspaceBinding,
        scope: &Scope,
        batch_id: &str,
        code: ErrorCode,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        check_scope(self, binding, scope)?;
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut ledger = read_ledger(&tx, scope)?;
        if ledger
            .batch
            .as_ref()
            .is_none_or(|batch| batch.batch_id != batch_id)
        {
            return Err(conflict("Overview maintenance batch changed"));
        }
        ledger.error_code = Some(code);
        write_ledger(&tx, scope, &ledger, now)?;
        tx.commit().map_err(io_error)
    }

    /// Re-arm only recoverable profile and quota waits. No paused controllers
    /// means no profile resolution or budget read on the normal tick.
    pub(crate) fn agent_overview_maintenance_resume_waiting(
        &self,
        binding: &WorkspaceBinding,
        now: DateTime<Utc>,
    ) -> AgentResult<()> {
        if self.native_workspace_id.as_deref() != Some(binding.workspace_id.as_str()) {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Overview Workspace is no longer current",
            ));
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT j.scope_key,json_extract(j.payload_json,'$.errorCode') FROM agent_jobs j
            JOIN projects p ON j.scope_key='project:'||p.id AND p.is_archived=0
            WHERE j.kind='overview' AND j.state='failed'
              AND j.dedupe_key='overview-maintenance:'||j.scope_key
              AND json_extract(j.payload_json,'$.errorCode') IN
                ('PROFILE_UNAVAILABLE','SECRETS_LOCKED','TOOL_CALL_UNSUPPORTED','RATE_LIMITED')
            ORDER BY p.id",
            )
            .map_err(io_error)?;
        let scopes = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        drop(stmt);
        if scopes.is_empty() {
            return Ok(());
        }
        let profile_ready = if scopes.iter().any(|(_, code)| code != "RATE_LIMITED") {
            match self.agent_resolve_profile(None) {
                Ok(mut resolved) => {
                    let verification = self.agent_profile_verified(&resolved.fingerprint);
                    resolved.profile.api_key.clear();
                    drop(resolved); // Clear secrets before any job write or error return.
                    verification?
                }
                Err(error)
                    if matches!(
                        error.code,
                        ErrorCode::ProfileUnavailable
                            | ErrorCode::SecretsLocked
                            | ErrorCode::ToolCallUnsupported
                    ) =>
                {
                    false
                }
                Err(error) => return Err(error),
            }
        } else {
            false
        };
        for (key, code) in scopes {
            let Some(project_id) = key
                .strip_prefix("project:")
                .and_then(|id| id.parse::<i64>().ok())
            else {
                continue;
            };
            let scope = Scope::Project { project_id };
            if !self.overview_schedule_scope(binding, &scope)? {
                continue;
            }
            if code == "RATE_LIMITED" {
                if self
                    .overview_schedule_status(binding, &scope, now)?
                    .budget_exhausted
                {
                    continue;
                }
            } else if !profile_ready {
                continue;
            }
            if self.overview_schedule_request(binding, &scope, now)? {
                self.agent_overview_maintenance_resume(binding, &scope, now)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "overview_maintenance_tests.rs"]
mod tests;
