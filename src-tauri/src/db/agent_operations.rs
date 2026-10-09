//! Receipts and change notifications commit with their business mutation.
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectRef, Scope},
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

pub(crate) struct OperationChange {
    pub object_key: String,
    pub scope: Scope,
    pub revision: String,
}
pub(crate) fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot persist agent operation")
}
pub(crate) fn parse_scope_key(key: &str) -> AgentResult<Scope> {
    if key == "workspace" {
        return Ok(Scope::Workspace);
    }
    let scope = Scope::Project {
        project_id: key
            .strip_prefix("project:")
            .and_then(|id| id.parse().ok())
            .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Invalid stored scope"))?,
    };
    scope.validate()?;
    Ok(scope)
}

pub(super) fn operation_hash(
    caller_id: &str,
    request_id: &str,
    payload: &impl Serialize,
) -> AgentResult<String> {
    if caller_id.is_empty()
        || caller_id.len() > 256
        || request_id.is_empty()
        || request_id.len() > 128
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid operation identity",
        ));
    }
    let value = serde_json::to_value(payload)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid operation payload"))?;
    // serde_json's default map sorts keys, so wire property order cannot break replay.
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid operation payload"))?;
    let hash = format!("sha256:{:x}", Sha256::digest(bytes));
    Ok(hash)
}

fn replay<T: DeserializeOwned>(
    conn: &rusqlite::Connection,
    caller_id: &str,
    request_id: &str,
    operation: &str,
    hash: &str,
) -> AgentResult<Option<T>> {
    let previous = conn.query_row("SELECT payload_hash,operation,state,result_json FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2", params![caller_id,request_id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, Option<String>>(3)?))).optional().map_err(io_error)?;
    if let Some((previous_hash, previous_operation, state, result)) = previous {
        if previous_hash != hash || previous_operation != operation {
            return Err(AgentError::new(
                ErrorCode::IdempotencyConflict,
                "Request ID already belongs to another payload",
            ));
        }
        if state != "committed" {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Operation needs recovery",
            ));
        }
        return serde_json::from_str(&result.unwrap_or_default())
            .map(Some)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored receipt"));
    }
    Ok(None)
}

impl Database {
    /// Preflight avoids unnecessary worker conversion. Atomic commit rechecks this
    /// same receipt with the original intent payload, even after ID allocation.
    pub(crate) fn agent_operation_replay<T: DeserializeOwned>(
        &self,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        payload: &impl Serialize,
    ) -> AgentResult<Option<T>> {
        let hash = operation_hash(caller_id, request_id, payload)?;
        replay(&self.conn, caller_id, request_id, operation, &hash)
    }

    /// Invoked under the Workspace DB lock. Returning from the closure commits once;
    /// errors (including outbox failure) roll back mutation and receipt together.
    pub(crate) fn agent_atomic_operation<T: Serialize + DeserializeOwned>(
        &self,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        payload: &impl Serialize,
        apply: impl FnOnce(&Transaction<'_>) -> AgentResult<(T, Option<OperationChange>)>,
    ) -> AgentResult<T> {
        let hash = operation_hash(caller_id, request_id, payload)?;
        // Reserve the writer before reading the receipt/CAS. A deferred read
        // transaction cannot safely upgrade while another connection already
        // owns the writer reservation, even with SQLite's busy timeout.
        let tx = Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let (result, applied) = self.agent_atomic_operation_with_hash(
            &tx, caller_id, request_id, operation, &hash, apply,
        )?;
        if applied {
            tx.commit().map_err(io_error)?;
        }
        Ok(result)
    }

    /// Uses the caller's native writer transaction. Mutation, receipt, hooks and
    /// change notifications settle together when the caller commits; errors must
    /// abort that transaction. This helper never commits or opens a transaction.
    pub(super) fn agent_atomic_operation_in_transaction<T: Serialize + DeserializeOwned>(
        &self,
        tx: &Transaction<'_>,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        payload: &impl Serialize,
        apply: impl FnOnce(&Transaction<'_>) -> AgentResult<(T, Option<OperationChange>)>,
    ) -> AgentResult<T> {
        let hash = operation_hash(caller_id, request_id, payload)?;
        self.agent_atomic_operation_with_hash(tx, caller_id, request_id, operation, &hash, apply)
            .map(|(result, _)| result)
    }

    fn agent_atomic_operation_with_hash<T: Serialize + DeserializeOwned>(
        &self,
        tx: &Transaction<'_>,
        caller_id: &str,
        request_id: &str,
        operation: &str,
        hash: &str,
        apply: impl FnOnce(&Transaction<'_>) -> AgentResult<(T, Option<OperationChange>)>,
    ) -> AgentResult<(T, bool)> {
        if let Some(previous) = replay(tx, caller_id, request_id, operation, hash)? {
            return Ok((previous, false));
        }
        let (result, change) = apply(tx)?;
        let now = Utc::now().to_rfc3339();
        let result_json = serde_json::to_string(&result)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid operation result"))?;
        tx.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at) VALUES (?1,?2,?3,?4,'committed',?5,?6)", params![request_id,caller_id,hash,operation,result_json,now]).map_err(io_error)?;
        super::agent_outputs::agent_output_record_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        super::agent_record_withdrawals::agent_record_withdrawal_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        super::agent_record_undo::agent_record_undo_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        super::agent_todo_outputs::agent_todo_output_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        super::agent_todo_undo::agent_todo_recovery_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        super::agent_file_outputs::agent_file_output_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
            self.native_workspace_id.as_deref(),
        )?;
        super::agent_file_undo::agent_file_recovery_receipt_committed(
            tx,
            caller_id,
            request_id,
            operation,
            &result_json,
        )?;
        if let Some(change) = change {
            tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,?5)", params![change.object_key,change.scope.key(),operation,change.revision,now]).map_err(io_error)?;
        }
        Ok((result, true))
    }

    pub(crate) fn agent_resolve_object(
        &self,
        object: &ObjectRef,
        workspace_id: &str,
    ) -> AgentResult<Option<ObjectRef>> {
        use crate::agent::models::ObjectKind;
        object.key()?;
        let numeric_id = || {
            object
                .id
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0 && id.to_string() == object.id)
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::InvalidArgument,
                        "Expected canonical positive object ID",
                    )
                })
        };
        let project_scope = |sql: &str, id: i64| -> AgentResult<Option<Scope>> {
            self.conn
                .query_row(sql, [id], |row| row.get::<_, Option<i64>>(0))
                .optional()
                .map(|owner| {
                    owner.map(|project_id| {
                        project_id
                            .map_or(Scope::Workspace, |project_id| Scope::Project { project_id })
                    })
                })
                .map_err(io_error)
        };
        let scope = match object.kind {
            ObjectKind::Project => project_scope("SELECT id FROM projects WHERE id=?1", numeric_id()?)?,
            ObjectKind::Record => match object.scope {
                Scope::Workspace => project_scope("SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'", numeric_id()?)?,
                Scope::Project { .. } => project_scope("SELECT project_id FROM notes WHERE id=?1", numeric_id()?)?,
            },
            ObjectKind::QuickNote => match object.scope {
                Scope::Workspace => project_scope("SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'", numeric_id()?)?,
                Scope::Project { .. } => project_scope("SELECT id FROM projects WHERE id=?1", numeric_id()?)?,
            },
            ObjectKind::Todo => project_scope("SELECT project_id FROM todos WHERE id=?1", numeric_id()?)?,
            ObjectKind::File => project_scope("SELECT project_id FROM documents WHERE id=?1", numeric_id()?)?,
            ObjectKind::Transcript => project_scope("SELECT notes.project_id FROM voice_records LEFT JOIN notes ON notes.id=voice_records.project_note_id WHERE voice_records.id=?1", numeric_id()?)?,
            ObjectKind::SessionMessage => self.conn.query_row("SELECT s.scope_key FROM agent_sessions s WHERE s.id=COALESCE((SELECT m.session_id FROM agent_messages m WHERE m.id=?1),(SELECT i.session_id FROM agent_session_search_rows i WHERE i.message_id=?1))", [&object.id], |row| row.get::<_, String>(0)).optional().map_err(io_error)?.map(|key| parse_scope_key(&key)).transpose()?,
            ObjectKind::SessionSummary => {
                let current = self.agent_knowledge_get(&object.scope, &object.id, None)?;
                current.filter(|node| node.session_summary.is_some())
                    .map(|node| node.scope)
            },
        };
        Ok(scope.map(|scope| ObjectRef {
            workspace_id: workspace_id.into(),
            scope,
            kind: object.kind,
            id: object.id.clone(),
        }))
    }
}

#[cfg(test)]
#[path = "agent_operations_session_message_tests.rs"]
mod session_message_tests;

impl crate::agent::changes::ChangeRepository for Database {
    fn agent_changes_list(
        &self,
        grant: &crate::agent::access::ScopeGrant,
        input: &crate::agent::changes::ChangeInput,
    ) -> AgentResult<crate::agent::changes::ChangePage> {
        use crate::agent::changes::{ChangeEntry, ChangePage};
        if input.after_seq < 0 || !(1..=200).contains(&input.limit) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid changes cursor or limit",
            ));
        }
        let cutoff = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let (first, max): (Option<i64>, Option<i64>) = self
            .conn
            .query_row(
                "SELECT MIN(CASE WHEN created_at>=?1 THEN seq END),COALESCE(MAX(seq),(SELECT seq FROM sqlite_sequence WHERE name='agent_change_log')) FROM agent_change_log",
                [&cutoff],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(io_error)?;
        let reset_required = first.is_some_and(|first| input.after_seq < first - 1)
            || (first.is_none() && max.is_some_and(|max| input.after_seq < max));
        let projects = serde_json::to_string(&grant.project_ids)
            .map_err(|_| AgentError::new(ErrorCode::InvalidArgument, "Invalid grant"))?;
        let mut stmt = self.conn.prepare("SELECT seq,object_key,scope_key,operation,revision,created_at FROM agent_change_log WHERE seq>?1 AND created_at>=?2 AND ((?3 AND scope_key='workspace') OR scope_key IN (SELECT 'project:' || value FROM json_each(?4))) ORDER BY seq LIMIT ?5").map_err(io_error)?;
        let mut entries = stmt
            .query_map(
                params![
                    input.after_seq,
                    cutoff,
                    grant.workspace_content,
                    projects,
                    input.limit + 1
                ],
                |row| {
                    let key: String = row.get(2)?;
                    let scope = parse_scope_key(&key).map_err(|_| rusqlite::Error::InvalidQuery)?;
                    Ok(ChangeEntry {
                        seq: row.get(0)?,
                        object_key: row.get(1)?,
                        scope,
                        operation: row.get(3)?,
                        revision: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let has_more = entries.len() > usize::from(input.limit);
        entries.truncate(usize::from(input.limit));
        let cursor = if has_more {
            entries.last().map_or(input.after_seq, |entry| entry.seq)
        } else {
            max.unwrap_or(input.after_seq).max(input.after_seq)
        };
        Ok(ChangePage {
            entries,
            cursor,
            has_more,
            reset_required,
        })
    }
}
impl crate::agent::changes::ChangeRepository for super::agent::WorkspaceContextRepository<'_> {
    fn agent_changes_list(
        &self,
        grant: &crate::agent::access::ScopeGrant,
        input: &crate::agent::changes::ChangeInput,
    ) -> AgentResult<crate::agent::changes::ChangePage> {
        self.db.agent_changes_list(grant, input)
    }
}

#[cfg(test)]
mod tests {
    use super::{io_error, Database, OperationChange};
    use crate::agent::{errors::ErrorCode, models::Scope};
    #[test]
    fn atomic_operation_in_transaction_settles_with_outer_commit_and_replays() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let db = Database::open(&path, root.path(), None).unwrap();
        let observer = Database::open(&path, root.path(), None).unwrap();
        let tx = rusqlite::Transaction::new_unchecked(
            &db.conn,
            rusqlite::TransactionBehavior::Immediate,
        )
        .unwrap();
        assert!(db.agent_atomic_operation_in_transaction(
            &tx, "gui", "outer-commit", "test.outer", &"intent", |tx| {
                tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES ('outer','true','now')", []).map_err(io_error)?;
                Ok((true, Some(OperationChange {
                    object_key: "test-object".into(), scope: Scope::Workspace, revision: "1".into(),
                })))
            },
        ).unwrap());
        assert_eq!(
            observer
                .conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE request_id='outer-commit'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(db
            .agent_atomic_operation_in_transaction::<bool>(
                &tx,
                "gui",
                "outer-commit",
                "test.outer",
                &"intent",
                |_| panic!("replay must not apply"),
            )
            .unwrap());
        assert_eq!(
            db.agent_atomic_operation_in_transaction::<bool>(
                &tx,
                "gui",
                "outer-commit",
                "test.outer",
                &"changed",
                |_| panic!("conflict must not apply"),
            )
            .unwrap_err()
            .code,
            ErrorCode::IdempotencyConflict
        );
        tx.commit().unwrap();
        assert_eq!(
            observer
                .conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE request_id='outer-commit'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            observer
                .conn
                .query_row(
                    "SELECT count(*) FROM agent_change_log WHERE operation='test.outer'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert!(db
            .agent_atomic_operation::<bool>(
                "gui",
                "outer-commit",
                "test.outer",
                &"intent",
                |_| panic!("wrapper shares replay"),
            )
            .unwrap());
    }

    #[test]
    fn atomic_operation_in_transaction_rolls_back_outer_mutation_receipt_and_outbox_failure() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        {
            let tx = rusqlite::Transaction::new_unchecked(
                &db.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            db.agent_atomic_operation_in_transaction(&tx, "gui", "outer-rollback", "test.rollback", &"intent", |tx| {
                tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES ('rolled-back','true','now')", []).map_err(io_error)?;
                Ok((true, None))
            }).unwrap();
            // A surrounding native operation can still fail after the helper returns.
        }
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM app_settings WHERE key='rolled-back'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(db.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE request_id='outer-rollback'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        db.conn.execute_batch("CREATE TRIGGER reject_test_outbox BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(ABORT,'test outbox failure'); END;").unwrap();
        {
            let tx = rusqlite::Transaction::new_unchecked(
                &db.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .unwrap();
            let error = db.agent_atomic_operation_in_transaction(&tx, "gui", "outer-outbox", "test.outbox", &"intent", |tx| {
                tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES ('outbox-rolled-back','true','now')", []).map_err(io_error)?;
                Ok((true, Some(OperationChange {
                    object_key: "test-object".into(), scope: Scope::Workspace, revision: "1".into(),
                })))
            }).unwrap_err();
            assert_eq!(error.code, ErrorCode::IoFailed);
        }
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM app_settings WHERE key='outbox-rolled-back'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM agent_operation_receipts WHERE request_id='outer-outbox'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM agent_change_log WHERE operation='test.outbox'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn atomic_operation_waits_for_writer_before_reading_receipt_or_applying() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("app.sqlite");
        let mut writer = Database::open(&path, root.path(), None).unwrap();
        let waiting = Database::open(&path, root.path(), None).unwrap();
        let tx = writer
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES ('held-writer','first','now')",[]).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (applied_tx, applied_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            waiting.agent_atomic_operation("gui","writer-wait","test.writer",&"intent",|tx| {
                applied_tx.send(()).unwrap();
                tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES ('waiting-writer','second','now')",[]).map_err(io_error)?;
                Ok((true,None))
            })
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            applied_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        tx.commit().unwrap();
        applied_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(handle.join().unwrap().unwrap());
        let receipts: i64 = writer
            .conn
            .query_row(
                "SELECT count(*) FROM agent_operation_receipts WHERE request_id='writer-wait'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(receipts, 1);
    }
}
