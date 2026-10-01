//! Durable indexing work uses agent_jobs and a transactional per-scope log cursor.
//! Internal maintenance only: callers still use the shared source read/index fences.
use super::Database;
use crate::agent::{
    access::{Caller, RequestContext},
    changes::{ChangeInput, ChangeRepository},
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Debug)]
pub(crate) struct SourceQueueProgress {
    pub cursor: i64,
    pub has_more: bool,
    pub needs_backfill: bool,
}
#[derive(Debug, Clone)]
pub(crate) struct SourceIndexLease {
    pub job_id: String,
    pub object: ObjectRef,
    token: String,
    seq: i64,
    generation: String,
}
#[derive(Debug)]
pub(crate) struct SourceBackfillProgress {
    pub queued: usize,
    pub has_more: bool,
}
pub(crate) enum SourceIndexOutcome {
    Completed,
    Retry,
    Failed(ErrorCode),
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobPayload {
    object: ObjectRef,
    first_seq: i64,
    last_seq: i64,
    ready_at: i64,
    lease_token: Option<String>,
    generation: Option<String>,
    claimed_seq: Option<i64>,
}
fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot persist source indexing queue")
}
fn decode(raw: &str) -> AgentResult<JobPayload> {
    serde_json::from_str(raw)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid source indexing job"))
}
fn encode(payload: &JobPayload) -> AgentResult<String> {
    serde_json::to_string(payload)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid source indexing job"))
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn time(millis: i64) -> AgentResult<DateTime<Utc>> {
    DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Invalid source job time"))
}
fn authorize(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    scope: &Scope,
) -> AgentResult<()> {
    request.authorize(binding, scope, "source.read")?;
    if matches!(request.caller, Caller::Connection { .. }) {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Source indexing maintenance requires a trusted local host",
        ));
    }
    Ok(())
}
impl Database {
    pub(crate) fn source_queue_prepare(&self) -> AgentResult<()> {
        self.source_prepare()?;
        self.conn.execute_batch("CREATE TABLE IF NOT EXISTS source_index_queue_cursors(workspace_id TEXT NOT NULL,scope_key TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>=0),needs_backfill INTEGER NOT NULL CHECK(needs_backfill IN (0,1)),PRIMARY KEY(workspace_id,scope_key));
            CREATE TABLE IF NOT EXISTS source_index_backfill_cursors(workspace_id TEXT NOT NULL,scope_key TEXT NOT NULL,kind TEXT NOT NULL,object_id INTEGER NOT NULL CHECK(object_id>=0),watermark INTEGER NOT NULL CHECK(watermark>=0),complete INTEGER NOT NULL CHECK(complete IN(0,1)),PRIMARY KEY(workspace_id,scope_key));").map_err(io_error)?;
        Ok(())
    }
    /// Enumerate metadata only, at most 200 owned non-excluded objects per call.
    /// Directory progress and queued work commit together; late business changes
    /// remain after the initial watermark for the normal log consumer.
    pub(crate) fn source_queue_backfill(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        limit: usize,
        now: DateTime<Utc>,
    ) -> AgentResult<SourceBackfillProgress> {
        authorize(request, binding, scope)?;
        self.source_live_scope(scope)?;
        if !(1..=200).contains(&limit) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Backfill batch must contain 1–200 objects",
            ));
        }
        self.source_queue_prepare()?;
        let reset:bool=self.conn.query_row("SELECT needs_backfill FROM source_index_queue_cursors WHERE workspace_id=?1 AND scope_key=?2",params![binding.workspace_id,scope.key()],|row|row.get(0)).optional().map_err(io_error)?.unwrap_or(false);
        let previous:Option<(String,i64,i64,bool)>=self.conn.query_row("SELECT kind,object_id,watermark,complete FROM source_index_backfill_cursors WHERE workspace_id=?1 AND scope_key=?2",params![binding.workspace_id,scope.key()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(io_error)?;
        if previous
            .as_ref()
            .is_some_and(|(_, _, _, complete)| *complete && !reset)
        {
            return Ok(SourceBackfillProgress {
                queued: 0,
                has_more: false,
            });
        }
        let (kind, id, watermark) = match previous {
            Some((kind, id, watermark, false)) => (kind, id, watermark),
            _ => (String::new(), 0, self.committed_change_watermark()?),
        };
        let project_id = match scope {
            Scope::Project { project_id } => Some(*project_id),
            _ => None,
        };
        let mut statement=self.conn.prepare("WITH catalogue(kind,id) AS (
            SELECT 'record',id FROM workspace_notes WHERE ?1 IS NULL AND note_kind='workspace_note'
            UNION ALL SELECT 'quick_note',id FROM workspace_notes WHERE ?1 IS NULL AND note_kind='today_quick_note'
            UNION ALL SELECT 'todo',id FROM todos WHERE (?1 IS NULL AND scope='workspace' AND project_id IS NULL) OR (scope='project' AND project_id=?1)
            UNION ALL SELECT 'project',id FROM projects WHERE id=?1 AND is_archived=0
            UNION ALL SELECT 'quick_note',id FROM projects WHERE id=?1 AND is_archived=0
            UNION ALL SELECT 'record',id FROM notes WHERE project_id=?1
            UNION ALL SELECT 'file',id FROM documents WHERE project_id=?1 AND storage_mode!='managed_note_image'
            UNION ALL SELECT 'transcript',v.id FROM voice_records v LEFT JOIN notes n ON n.id=v.project_note_id LEFT JOIN workspace_notes w ON w.id=v.workspace_note_id WHERE (?1 IS NULL AND w.id IS NOT NULL) OR n.project_id=?1
            ) SELECT kind,id FROM catalogue WHERE (kind>?2 OR (kind=?2 AND id>?3)) AND NOT EXISTS (SELECT 1 FROM source_access_policies x WHERE x.object_key=?4 || '/' || ?5 || '/' || kind || '/' || CAST(id AS TEXT) AND x.excluded=1) ORDER BY kind,id LIMIT ?6").map_err(io_error)?;
        let mut objects = statement
            .query_map(
                params![
                    project_id,
                    kind,
                    id,
                    binding.workspace_id,
                    scope.key(),
                    (limit + 1) as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let mut has_more = objects.len() > limit;
        objects.truncate(limit);
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        for (kind, id) in &objects {
            let object = ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: scope.clone(),
                kind: serde_json::from_value(serde_json::Value::String(kind.clone())).map_err(
                    |_| AgentError::new(ErrorCode::IoFailed, "Invalid source catalogue kind"),
                )?,
                id: id.to_string(),
            };
            self.source_read_object(request, binding, &object)?;
            let key = format!("source-index:{}", object.key()?);
            let payload = JobPayload {
                object,
                first_seq: watermark,
                last_seq: watermark,
                ready_at: now.timestamp_millis(),
                lease_token: None,
                generation: None,
                claimed_seq: None,
            };
            tx.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,attempt,not_before,payload_json,error) VALUES (?1,'extract',?2,?3,'queued',0,?4,?5,NULL) ON CONFLICT(dedupe_key) DO UPDATE SET state=CASE WHEN agent_jobs.state='running' THEN 'running' ELSE 'queued' END,attempt=CASE WHEN agent_jobs.state IN('queued','running') THEN agent_jobs.attempt ELSE 0 END,not_before=CASE WHEN agent_jobs.state IN('queued','running') THEN agent_jobs.not_before ELSE excluded.not_before END,payload_json=CASE WHEN agent_jobs.state IN('queued','running') THEN json_set(agent_jobs.payload_json,'$.lastSeq',max(json_extract(agent_jobs.payload_json,'$.lastSeq'),?6)) ELSE excluded.payload_json END,error=NULL WHERE agent_jobs.kind='extract'",params![format!("{:032x}",rand::random::<u128>()),scope.key(),key,stamp(now),encode(&payload)?,watermark]).map_err(io_error)?;
        }
        let (mut next_kind, mut next_id) = objects.last().cloned().unwrap_or((kind, id));
        if !has_more {
            let mut grant = request.scope_grant.clone();
            grant.workspace_content = *scope == Scope::Workspace;
            grant.project_ids = match scope {
                Scope::Project { project_id } => vec![*project_id],
                _ => vec![],
            };
            let late = self.agent_changes_list(
                &grant,
                &ChangeInput {
                    after_seq: watermark,
                    limit: 200,
                },
            )?;
            if late.reset_required {
                // A long-paused traversal cannot prove the intervening delta.
                // Restart a bounded directory pass, preserving all queued work.
                has_more = true;
                next_kind = String::new();
                next_id = 0;
            } else {
                tx.execute("INSERT INTO source_index_queue_cursors(workspace_id,scope_key,seq,needs_backfill) VALUES (?1,?2,?3,0) ON CONFLICT(workspace_id,scope_key) DO UPDATE SET seq=max(source_index_queue_cursors.seq,excluded.seq),needs_backfill=0",params![binding.workspace_id,scope.key(),watermark]).map_err(io_error)?;
            }
        }
        let next_watermark = if has_more && next_kind.is_empty() {
            self.committed_change_watermark()?
        } else {
            watermark
        };
        tx.execute("INSERT INTO source_index_backfill_cursors(workspace_id,scope_key,kind,object_id,watermark,complete) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,scope_key) DO UPDATE SET kind=excluded.kind,object_id=excluded.object_id,watermark=excluded.watermark,complete=excluded.complete",params![binding.workspace_id,scope.key(),next_kind,next_id,next_watermark,!has_more]).map_err(io_error)?;
        tx.commit().map_err(io_error)?;
        Ok(SourceBackfillProgress {
            queued: objects.len(),
            has_more,
        })
    }
    pub(crate) fn source_queue_sync(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<SourceQueueProgress> {
        authorize(request, binding, scope)?;
        self.source_queue_prepare()?;
        let (after_seq, previous_reset): (i64,bool) = self.conn.query_row("SELECT seq,needs_backfill FROM source_index_queue_cursors WHERE workspace_id=?1 AND scope_key=?2",params![binding.workspace_id,scope.key()],|row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(io_error)?.unwrap_or((0,false));
        let mut grant = request.scope_grant.clone();
        grant.workspace_content = *scope == Scope::Workspace;
        grant.project_ids = match scope {
            Scope::Project { project_id } => vec![*project_id],
            _ => vec![],
        };
        let page = self.agent_changes_list(
            &grant,
            &ChangeInput {
                after_seq,
                limit: 200,
            },
        )?;
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        for entry in &page.entries {
            let Some(object) =
                super::committed_changes::object_from_key(&entry.object_key, &binding.workspace_id)
            else {
                continue;
            };
            if object.scope != *scope
                || !matches!(
                    object.kind,
                    ObjectKind::Record
                        | ObjectKind::File
                        | ObjectKind::Project
                        | ObjectKind::Todo
                        | ObjectKind::QuickNote
                        | ObjectKind::Transcript
                )
            {
                continue;
            }
            let key = format!("source-index:{}", object.key()?);
            match self.source_read_object(request, binding, &object) {
                Ok(_) => (),
                Err(error)
                    if matches!(error.code, ErrorCode::NotFound | ErrorCode::ScopeDenied) =>
                {
                    tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE dedupe_key=?1 AND kind='extract'",[&key]).map_err(io_error)?;
                    continue;
                }
                Err(error) => return Err(error),
            }
            let created_at = DateTime::parse_from_rfc3339(&entry.created_at)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid source change time"))?
                .with_timezone(&Utc);
            let ready = if matches!(object.kind, ObjectKind::Record | ObjectKind::QuickNote) {
                created_at + Duration::milliseconds(500)
            } else {
                now
            };
            let previous: Option<(String,String)> = tx.query_row("SELECT state,payload_json FROM agent_jobs WHERE dedupe_key=?1 AND kind='extract'",[&key],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(io_error)?;
            if let Some((_, raw)) = &previous {
                if decode(raw)?.last_seq >= entry.seq {
                    continue;
                }
            }
            let running = previous
                .as_ref()
                .is_some_and(|(state, _)| state == "running");
            let mut payload = if let Some((state, raw)) = previous {
                let previous = decode(&raw)?;
                if matches!(state.as_str(), "queued" | "running") {
                    previous
                } else {
                    JobPayload {
                        object: object.clone(),
                        first_seq: entry.seq,
                        last_seq: entry.seq,
                        ready_at: ready.timestamp_millis(),
                        lease_token: None,
                        generation: None,
                        claimed_seq: None,
                    }
                }
            } else {
                JobPayload {
                    object: object.clone(),
                    first_seq: entry.seq,
                    last_seq: entry.seq,
                    ready_at: ready.timestamp_millis(),
                    lease_token: None,
                    generation: None,
                    claimed_seq: None,
                }
            };
            payload.last_seq = entry.seq;
            payload.ready_at = ready.timestamp_millis();
            let raw = encode(&payload)?;
            tx.execute("INSERT INTO agent_jobs(id,kind,scope_key,dedupe_key,state,attempt,not_before,payload_json,error) VALUES (?1,'extract',?2,?3,'queued',0,?4,?5,NULL) ON CONFLICT(dedupe_key) DO UPDATE SET payload_json=excluded.payload_json,state=CASE WHEN ?6 THEN 'running' ELSE 'queued' END,attempt=CASE WHEN ?6 THEN agent_jobs.attempt ELSE 0 END,not_before=CASE WHEN ?6 THEN agent_jobs.not_before ELSE excluded.not_before END,error=NULL",params![format!("{:032x}",rand::random::<u128>()),scope.key(),key,stamp(ready),raw,running]).map_err(io_error)?;
        }
        let needs_backfill = previous_reset || page.reset_required;
        tx.execute("INSERT INTO source_index_queue_cursors(workspace_id,scope_key,seq,needs_backfill) VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id,scope_key) DO UPDATE SET seq=excluded.seq,needs_backfill=excluded.needs_backfill",params![binding.workspace_id,scope.key(),page.cursor,needs_backfill]).map_err(io_error)?;
        tx.commit().map_err(io_error)?;
        Ok(SourceQueueProgress {
            cursor: page.cursor,
            has_more: page.has_more,
            needs_backfill,
        })
    }
    pub(crate) fn source_queue_claim(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
        now: DateTime<Utc>,
    ) -> AgentResult<Option<SourceIndexLease>> {
        authorize(request, binding, scope)?;
        self.source_queue_prepare()?;
        let prefix = format!("source-index:{}/", binding.workspace_id);
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        // The caller owns the one Workspace host. Reopen invalidates old leases;
        // same-generation crashes become retryable only after the bounded lease.
        tx.execute("UPDATE agent_jobs SET state=CASE WHEN attempt<3 THEN 'queued' ELSE 'failed' END,not_before=?1,error=CASE WHEN attempt<3 THEN NULL ELSE 'LEASE_EXPIRED' END WHERE kind='extract' AND state='running' AND substr(dedupe_key,1,length(?2))=?2 AND (not_before<=?1 OR json_extract(payload_json,'$.generation')!=?3)",params![stamp(now),prefix,binding.generation]).map_err(io_error)?;
        let running: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_jobs WHERE kind='extract' AND state='running' AND substr(dedupe_key,1,length(?1))=?1)",[&prefix],|row|row.get(0)).map_err(io_error)?;
        if running {
            tx.commit().map_err(io_error)?;
            return Ok(None);
        }
        for _ in 0..200 {
            let job: Option<(String,String)> = tx.query_row("SELECT id,payload_json FROM agent_jobs WHERE kind='extract' AND state='queued' AND attempt<3 AND scope_key=?1 AND substr(dedupe_key,1,length(?2))=?2 AND not_before<=?3 ORDER BY not_before,id LIMIT 1",params![scope.key(),prefix,stamp(now)],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(io_error)?;
            let Some((id, raw)) = job else {
                break;
            };
            let mut payload = decode(&raw)?;
            if payload.object.workspace_id != binding.workspace_id || payload.object.scope != *scope
            {
                return Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "Invalid source job ownership",
                ));
            }
            match self.source_read_object(request, binding, &payload.object) {
                Ok(_) => (),
                Err(error)
                    if matches!(error.code, ErrorCode::NotFound | ErrorCode::ScopeDenied) =>
                {
                    tx.execute("UPDATE agent_jobs SET state='cancelled' WHERE id=?1", [&id])
                        .map_err(io_error)?;
                    continue;
                }
                Err(error) => return Err(error),
            }
            let token = format!("{:032x}", rand::random::<u128>());
            payload.lease_token = Some(token.clone());
            payload.generation = Some(binding.generation.clone());
            payload.claimed_seq = Some(payload.last_seq);
            tx.execute("UPDATE agent_jobs SET state='running',attempt=attempt+1,not_before=?1,payload_json=?2,error=NULL WHERE id=?3",params![stamp(now+Duration::seconds(90)),encode(&payload)?,id]).map_err(io_error)?;
            let lease = SourceIndexLease {
                job_id: id,
                object: payload.object,
                token,
                seq: payload.last_seq,
                generation: binding.generation.clone(),
            };
            tx.commit().map_err(io_error)?;
            return Ok(Some(lease));
        }
        tx.commit().map_err(io_error)?;
        Ok(None)
    }
    pub(crate) fn source_queue_finish(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        lease: &SourceIndexLease,
        outcome: SourceIndexOutcome,
        now: DateTime<Utc>,
    ) -> AgentResult<bool> {
        authorize(request, binding, &lease.object.scope)?;
        self.source_queue_prepare()?;
        if lease.generation != binding.generation
            || lease.object.workspace_id != binding.workspace_id
        {
            return Ok(false);
        }
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        let current: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT state,payload_json,attempt FROM agent_jobs WHERE id=?1 AND kind='extract'",
                [&lease.job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(io_error)?;
        let Some((state, raw, attempt)) = current else {
            return Ok(false);
        };
        let mut payload = decode(&raw)?;
        if state != "running"
            || payload.lease_token.as_deref() != Some(&lease.token)
            || payload.claimed_seq != Some(lease.seq)
            || payload.object != lease.object
        {
            return Ok(false);
        }
        let changed = payload.last_seq > lease.seq;
        let (next_state, next_attempt, error) = if changed {
            ("queued", 0, None)
        } else {
            match outcome {
                SourceIndexOutcome::Completed => ("completed", attempt, None),
                SourceIndexOutcome::Retry if attempt < 3 => ("queued", attempt, None),
                SourceIndexOutcome::Retry => ("failed", attempt, Some("RETRY_EXHAUSTED".into())),
                SourceIndexOutcome::Failed(code) => (
                    "failed",
                    attempt,
                    Some(
                        serde_json::to_value(code)
                            .map_err(|_| {
                                AgentError::new(ErrorCode::IoFailed, "Invalid queue error")
                            })?
                            .as_str()
                            .unwrap()
                            .to_string(),
                    ),
                ),
            }
        };
        payload.lease_token = None;
        payload.generation = None;
        payload.claimed_seq = None;
        let ready = if changed {
            time(payload.ready_at)?
        } else {
            now + Duration::milliseconds(500)
        };
        tx.execute("UPDATE agent_jobs SET state=?1,attempt=?2,error=?3,not_before=?4,payload_json=?5 WHERE id=?6",params![next_state,next_attempt,error,stamp(ready),encode(&payload)?,lease.job_id]).map_err(io_error)?;
        tx.commit().map_err(io_error)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::ObjectKind,
        },
        models::WorkspaceRecordUpsertInput,
    };
    use chrono::Duration;
    fn setup() -> (
        tempfile::TempDir,
        Database,
        RequestContext,
        ObjectRef,
        DateTime<Utc>,
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        let note = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Queue source".into()),
                html: "<p>Committed</p>".into(),
                markdown: "Committed".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g1".into(),
        };
        let request = RequestContext {
            binding,
            request_id: "queue".into(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into()],
            },
        };
        let object = ObjectRef {
            workspace_id: "w".into(),
            scope: Scope::Workspace,
            kind: ObjectKind::Record,
            id: note.id.to_string(),
        };
        (root, db, request, object, Utc::now())
    }
    fn change(db: &Database, object: &ObjectRef, now: DateTime<Utc>) {
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'record.write','r',?3)", rusqlite::params![object.key().unwrap(),object.scope.key(),now.to_rfc3339()]).unwrap();
    }
    #[test]
    fn source_queue_coalesces_500ms_and_preserves_changes_arriving_during_processing() {
        let (_root, db, request, object, now) = setup();
        change(&db, &object, now);
        change(&db, &object, now + Duration::milliseconds(200));
        let progress = db
            .source_queue_sync(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(200),
            )
            .unwrap();
        assert_eq!(progress.cursor, 2);
        assert!(!progress.has_more);
        assert!(!progress.needs_backfill);
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(699)
            )
            .unwrap()
            .is_none());
        let lease = db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(701),
            )
            .unwrap()
            .unwrap();
        assert_eq!(lease.object, object);
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(702)
            )
            .unwrap()
            .is_none());
        change(&db, &object, now + Duration::milliseconds(800));
        db.source_queue_sync(
            &request,
            &request.binding,
            &Scope::Workspace,
            now + Duration::milliseconds(800),
        )
        .unwrap();
        assert!(db
            .source_queue_finish(
                &request,
                &request.binding,
                &lease,
                SourceIndexOutcome::Completed,
                now + Duration::milliseconds(900)
            )
            .unwrap());
        assert!(!db
            .source_queue_finish(
                &request,
                &request.binding,
                &lease,
                SourceIndexOutcome::Completed,
                now + Duration::milliseconds(901)
            )
            .unwrap());
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(1200)
            )
            .unwrap()
            .is_none());
        let next = db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(1301),
            )
            .unwrap()
            .unwrap();
        assert_eq!(next.seq, 3);
        assert!(db
            .source_queue_finish(
                &request,
                &request.binding,
                &next,
                SourceIndexOutcome::Completed,
                now + Duration::milliseconds(1400)
            )
            .unwrap());
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::milliseconds(1500)
            )
            .unwrap()
            .is_none());
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn source_queue_cursor_and_work_roll_back_together_and_expired_logs_require_backfill() {
        let (_root, db, request, object, now) = setup();
        db.source_queue_prepare().unwrap();
        change(&db, &object, now);
        db.conn.execute_batch("CREATE TRIGGER fail_queue BEFORE INSERT ON agent_jobs BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert_eq!(
            db.source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT COUNT(*) FROM source_index_queue_cursors",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        db.conn.execute_batch("DROP TRIGGER fail_queue;").unwrap();
        let page = db
            .source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        assert_eq!(page.cursor, 1);
        change(&db, &object, now - Duration::days(40));
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        let page = db
            .source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        assert_eq!(page.cursor, 2);
        assert!(page.needs_backfill);
        assert!(
            db.source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
                .unwrap()
                .needs_backfill
        );
    }
    #[test]
    fn source_queue_reopen_recovers_leases_and_rejects_stale_workers_and_connections() {
        let (root, db, request, object, now) = setup();
        change(&db, &object, now);
        db.source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        let lease = db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(1),
            )
            .unwrap()
            .unwrap();
        drop(db);
        let opened = crate::workspace_initialization::open_workspace_database(
            &root.path().join("app.sqlite"),
            root.path(),
            None,
            "w",
        )
        .unwrap();
        let db = opened.db;
        let mut reopened = request.clone();
        reopened.binding.generation = "g2".into();
        let current = db
            .source_queue_claim(
                &reopened,
                &reopened.binding,
                &Scope::Workspace,
                now + Duration::seconds(2),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            db.source_queue_finish(
                &request,
                &reopened.binding,
                &lease,
                SourceIndexOutcome::Completed,
                now
            )
            .unwrap_err()
            .code,
            ErrorCode::WorkspaceChanged
        );
        assert!(!db
            .source_queue_finish(
                &reopened,
                &reopened.binding,
                &lease,
                SourceIndexOutcome::Completed,
                now
            )
            .unwrap());
        assert!(db
            .source_queue_finish(
                &reopened,
                &reopened.binding,
                &current,
                SourceIndexOutcome::Completed,
                now
            )
            .unwrap());
        let mut remote = reopened.clone();
        remote.caller = Caller::Connection {
            grant_id: "remote".into(),
        };
        assert_eq!(
            db.source_queue_sync(&remote, &remote.binding, &Scope::Workspace, now)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn source_queue_retries_at_most_three_times_and_new_changes_reopen_failed_work() {
        let (_root, db, request, object, now) = setup();
        change(&db, &object, now);
        db.source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        for attempt in 1..=3 {
            let current = now + Duration::seconds(attempt);
            let lease = db
                .source_queue_claim(&request, &request.binding, &Scope::Workspace, current)
                .unwrap()
                .unwrap();
            db.source_queue_finish(
                &request,
                &request.binding,
                &lease,
                SourceIndexOutcome::Retry,
                current,
            )
            .unwrap();
        }
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(4)
            )
            .unwrap()
            .is_none());
        let error: String = db
            .conn
            .query_row("SELECT error FROM agent_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(error, "RETRY_EXHAUSTED");
        change(&db, &object, now + Duration::seconds(5));
        db.source_queue_sync(
            &request,
            &request.binding,
            &Scope::Workspace,
            now + Duration::seconds(5),
        )
        .unwrap();
        let lease = db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(6),
            )
            .unwrap()
            .unwrap();
        db.source_queue_finish(
            &request,
            &request.binding,
            &lease,
            SourceIndexOutcome::Failed(ErrorCode::SourceNotReady),
            now + Duration::seconds(6),
        )
        .unwrap();
        let (attempt, error): (i64, String) = db
            .conn
            .query_row("SELECT attempt,error FROM agent_jobs", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(attempt, 1);
        assert_eq!(error, "SOURCE_NOT_READY");
    }
    #[test]
    fn source_queue_exclusion_and_deletion_cancel_pending_and_running_work() {
        let (_root, db, mut request, object, now) = setup();
        change(&db, &object, now);
        db.source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        let lease = db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(1),
            )
            .unwrap()
            .unwrap();
        request.scope_grant.operations.push("settings.write".into());
        db.source_policy_update(
            &request,
            &request.binding,
            &crate::source_service::SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        db.source_queue_sync(
            &request,
            &request.binding,
            &Scope::Workspace,
            now + Duration::seconds(2),
        )
        .unwrap();
        assert!(!db
            .source_queue_finish(
                &request,
                &request.binding,
                &lease,
                SourceIndexOutcome::Completed,
                now + Duration::seconds(2)
            )
            .unwrap());
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(3)
            )
            .unwrap()
            .is_none());
        request.request_id = "unexclude".into();
        db.source_policy_update(
            &request,
            &request.binding,
            &crate::source_service::SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 1,
                excluded: false,
            },
        )
        .unwrap();
        db.source_queue_sync(
            &request,
            &request.binding,
            &Scope::Workspace,
            now + Duration::seconds(4),
        )
        .unwrap();
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(5)
            )
            .unwrap()
            .is_some());
        db.conn
            .execute("DELETE FROM workspace_notes WHERE id=?1", [&object.id])
            .unwrap();
        change(&db, &object, now + Duration::seconds(6));
        db.source_queue_sync(
            &request,
            &request.binding,
            &Scope::Workspace,
            now + Duration::seconds(6),
        )
        .unwrap();
        assert!(db
            .source_queue_claim(
                &request,
                &request.binding,
                &Scope::Workspace,
                now + Duration::seconds(7)
            )
            .unwrap()
            .is_none());
        let state: String = db
            .conn
            .query_row("SELECT state FROM agent_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "cancelled");
    }
    #[test]
    fn source_queue_backfill_is_budgeted_resumable_excludes_sources_and_does_not_duplicate_jobs() {
        let (root, mut db, mut request, object, now) = setup();
        for number in 0..4 {
            db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some(format!("Old {number}")),
                html: "<p>Old body</p>".into(),
                markdown: "Old body".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        }
        request.scope_grant.operations.push("settings.write".into());
        db.source_policy_update(
            &request,
            &request.binding,
            &crate::source_service::SourcePolicyUpdate {
                object: object.clone(),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        let first = db
            .source_queue_backfill(&request, &request.binding, &Scope::Workspace, 2, now)
            .unwrap();
        assert_eq!(first.queued, 2);
        assert!(first.has_more);
        drop(db);
        let db = crate::workspace_initialization::open_workspace_database(
            &root.path().join("app.sqlite"),
            root.path(),
            None,
            "w",
        )
        .unwrap()
        .db;
        let mut queued = first.queued;
        loop {
            let page = db
                .source_queue_backfill(&request, &request.binding, &Scope::Workspace, 2, now)
                .unwrap();
            assert!(page.queued <= 2);
            queued += page.queued;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(queued, 4);
        assert_eq!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 2, now)
                .unwrap()
                .queued,
            0
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_jobs WHERE dedupe_key=?1",
                    [format!("source-index:{}", object.key().unwrap())],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let progress = db
            .source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        assert!(!progress.needs_backfill);
    }
    #[test]
    fn source_queue_backfill_failure_does_not_advance_directory_cursor() {
        let (_root, db, request, _, now) = setup();
        db.source_queue_prepare().unwrap();
        db.conn.execute_batch("CREATE TRIGGER fail_backfill BEFORE INSERT ON agent_jobs BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert_eq!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        db.conn
            .execute_batch("DROP TRIGGER fail_backfill;")
            .unwrap();
        assert_eq!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap()
                .queued,
            1
        );
        assert_eq!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 0, now)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn source_queue_backfill_does_not_skip_changes_committed_after_its_initial_watermark() {
        let (_root, mut db, request, object, now) = setup();
        for number in 0..2 {
            db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some(format!("Old {number}")),
                html: "<p>Old</p>".into(),
                markdown: "Old".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        }
        assert!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap()
                .has_more
        );
        change(&db, &object, now);
        while db
            .source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
            .unwrap()
            .has_more
        {}
        let changes = db
            .source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        assert_eq!(changes.cursor, 1);
        let latest: i64 = db
            .conn
            .query_row(
                "SELECT json_extract(payload_json,'$.lastSeq') FROM agent_jobs WHERE dedupe_key=?1",
                [format!("source-index:{}", object.key().unwrap())],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(latest, 1);
    }
    #[test]
    fn source_queue_backfill_isolates_selected_project_and_denies_ungranted_scope() {
        let (_root, mut db, mut request, _, now) = setup();
        let a = db
            .project_create(crate::models::ProjectCreateInput {
                name: "A".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let b = db
            .project_create(crate::models::ProjectCreateInput {
                name: "B".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        for project in [&a, &b] {
            db.project_record_upsert(crate::models::ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("Scoped".into()),
                html: "<p>Scoped</p>".into(),
                markdown: "Scoped".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        }
        request.scope_grant.project_ids = vec![a.id];
        let scope = Scope::Project { project_id: a.id };
        let page = db
            .source_queue_backfill(&request, &request.binding, &scope, 200, now)
            .unwrap();
        assert_eq!(page.queued, 3);
        assert!(!page.has_more);
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM agent_jobs WHERE json_extract(payload_json,'$.object.scope.projectId')=?1",[a.id],|row|row.get::<_,i64>(0)).unwrap(),3);
        assert_eq!(
            db.source_queue_backfill(
                &request,
                &request.binding,
                &Scope::Project { project_id: b.id },
                200,
                now
            )
            .unwrap_err()
            .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn source_queue_backfill_restarts_if_its_delta_expires_during_a_paused_traversal() {
        let (_root, mut db, request, object, now) = setup();
        for number in 0..2 {
            db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some(format!("Old {number}")),
                html: "<p>Old</p>".into(),
                markdown: "Old".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        }
        assert!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap()
                .has_more
        );
        change(&db, &object, now);
        change(&db, &object, now);
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        assert!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap()
                .has_more
        );
        assert!(
            db.source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap()
                .has_more
        );
        let cursor: (String, i64) = db
            .conn
            .query_row(
                "SELECT kind,object_id FROM source_index_backfill_cursors",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(cursor, (String::new(), 0));
        for index in 0..3 {
            let page = db
                .source_queue_backfill(&request, &request.binding, &Scope::Workspace, 1, now)
                .unwrap();
            assert_eq!(page.has_more, index < 2);
        }
        let page = db
            .source_queue_sync(&request, &request.binding, &Scope::Workspace, now)
            .unwrap();
        assert_eq!(page.cursor, 2);
        assert!(!page.needs_backfill);
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM agent_jobs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
}
