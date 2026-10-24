//! File candidates reuse the native import/version receipts and version IDs.
use super::{
    agent_operations::io_error,
    file_imports::{AgentFileCreateInput, AgentFileCreateResult},
    file_versions::CommittedVersion,
    Database,
};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    output_runtime::FileOutputReceipt,
    outputs::OutputIntent,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
pub(crate) fn file_output_receipt(
    conn: &Connection,
    id: &str,
    run: &str,
    revision: i64,
) -> AgentResult<Option<FileOutputReceipt>> {
    let row:Option<(String,String)>=conn.query_row("SELECT r.operation,r.result_json FROM agent_operation_receipts r JOIN agent_outputs o ON o.id=?1 AND o.state='committed' WHERE r.run_id=?2 AND r.request_id=?3 AND r.operation IN ('file.create','file.version.commit') AND r.state='committed' AND json_extract(r.output_context_json,'$.outputId')=?1",params![id,run,format!("output:{id}:{revision}")],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(io_error)?;
    row.map(|(operation, result)| {
        if operation == "file.create" {
            let value: AgentFileCreateResult = serde_json::from_str(&result)
                .map_err(|_| invalid("Invalid File creation receipt"))?;
            Ok(FileOutputReceipt {
                document_id: value
                    .object
                    .id
                    .parse()
                    .map_err(|_| invalid("Invalid File identity"))?,
                version_number: value.version_number,
                content_hash: value.content_hash,
                no_change: false,
            })
        } else {
            let value: CommittedVersion = serde_json::from_str(&result)
                .map_err(|_| invalid("Invalid File Version receipt"))?;
            Ok(FileOutputReceipt {
                document_id: value.document_id,
                version_number: u32::try_from(value.version_number)
                    .ok()
                    .filter(|v| *v > 0)
                    .ok_or_else(|| invalid("Invalid File Version"))?,
                content_hash: value.content_hash,
                no_change: value.no_change,
            })
        }
    })
    .transpose()
}
pub(super) fn baseline(intent: &OutputIntent) -> AgentResult<(&ObjectRef, u32, &str)> {
    match intent {
        OutputIntent::FileUpdate {
            target,
            expected_version,
            expected_hash,
            ..
        } => Ok((target, *expected_version, expected_hash)),
        OutputIntent::FilePatch { patch } => Ok((
            &patch.object,
            patch.expected_version_number,
            &patch.expected_content_hash,
        )),
        OutputIntent::FileRestore { restore } => Ok((
            &restore.object,
            restore.expected_version_number,
            &restore.expected_content_hash,
        )),
        _ => Err(invalid("Expected a File modification")),
    }
}
impl Database {
    pub(super) fn agent_file_validate_candidate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        captured: &RequestContext,
        intent: &OutputIntent,
    ) -> AgentResult<()> {
        if let OutputIntent::FileCreate {
            project_id,
            safe_name,
            utf8_content,
        } = intent
        {
            let input = AgentFileCreateInput {
                project_id: *project_id,
                safe_name: safe_name.clone(),
                utf8_content: utf8_content.clone(),
            };
            super::file_imports::validate_agent_file_create(&input)?;
            self.agent_file_create_authorize(request, binding, &input)?;
            self.agent_connection_require_live(captured, binding, &super::file_scope::scope(*project_id), "content.create")?;
            return Ok(());
        }
        let (target, version, hash) = baseline(intent)?;
        let actual = self.source_read_object(request, binding, target)?;
        let permission = if matches!(intent, OutputIntent::FileRestore { .. }) {
            "file.restore"
        } else {
            "file.update"
        };
        request.authorize_object(binding, target, &actual, permission)?;
        captured.authorize_object(binding, target, &actual, permission)?;
        captured.authorize_object(binding, target, &actual, "source.read")?;
        self.agent_connection_require_live(request, binding, &actual.scope, permission)?;
        self.agent_connection_require_live(captured, binding, &actual.scope, permission)?;
        let document_id: i64 = actual
            .id
            .parse()
            .map_err(|_| invalid("Invalid File identity"))?;
        let current:Option<(i64,Option<String>)>=self.conn.query_row("SELECT d.current_version_number,h.content_hash FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id AND v.version_number=d.current_version_number LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE d.id=?1",[document_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(io_error)?;
        let (current, registered) =
            current.ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File no longer exists"))?;
        let registered = registered.ok_or_else(|| {
            AgentError::new(
                ErrorCode::FileChangedUnregistered,
                "Register current File bytes before staging a modification",
            )
        })?;
        if current != i64::from(version) || registered != hash {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "File candidate baseline changed",
            ));
        }
        if let OutputIntent::FileRestore { restore } = intent {
            let available:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND CAST(v.id AS TEXT)=?2)",params![document_id,restore.version_id],|r|r.get(0)).map_err(io_error)?;
            if !available {
                return Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Historical File Version is unavailable",
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn agent_output_file_update_owner(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::file_content::FileContentUpdate,
    ) -> AgentResult<RequestContext> {
        let parts: Vec<_> = request.request_id.split(':').collect();
        if parts.len() != 3 || parts[0] != "output" {
            return Err(invalid("Invalid File output commit identity"));
        }
        let revision = parts[2]
            .parse::<u64>()
            .ok()
            .filter(|v| *v > 0 && v.to_string() == parts[2])
            .ok_or_else(|| invalid("Invalid output revision"))?;
        let output = self.agent_output_commit_validate(request, binding, parts[1], revision)?;
        let OutputIntent::FileUpdate {
            target,
            expected_version,
            expected_hash,
            staged_content_id,
        } = &output.staged.intent
        else {
            return Err(invalid("Expected an uploaded File candidate"));
        };
        if target != &input.object
            || *expected_version != input.expected_version_number
            || expected_hash != &input.expected_content_hash
            || staged_content_id != &input.staged_content_id
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Upload does not belong to the approved candidate",
            ));
        }
        self.agent_output_file_upload_owner(
            request,
            binding,
            &output.staged.run_id,
            "output.commit",
        )
    }
}
fn version_ref(conn: &Connection, id: i64, version: i64) -> AgentResult<(String, Option<String>)> {
    conn.query_row("SELECT CAST(v.id AS TEXT),h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",params![id,version],|r|Ok((r.get(0)?,r.get(1)?))).map_err(io_error)
}
/// Called by the existing atomic kernel after its original receipt INSERT.
/// This metadata is part of the same native journal/SQL commit, never a ledger.
pub(crate) fn agent_file_output_receipt_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
    workspace_id: Option<&str>,
) -> AgentResult<()> {
    if !matches!(operation, "file.create" | "file.version.commit")
        || request_id.starts_with("fileundo:")
    {
        return Ok(());
    }
    let bound = if request_id.starts_with("output:") && !caller.starts_with("connection:") {
        Some(super::agent_outputs::agent_output_native_binding(
            tx, caller, request_id, operation,
        )?)
    } else {
        None
    };
    let (object, version, hash, no_change, operation_id) = if operation == "file.create" {
        let result: AgentFileCreateResult = serde_json::from_str(result_json)
            .map_err(|_| invalid("Invalid File creation result"))?;
        (
            result.object,
            i64::from(result.version_number),
            result.content_hash,
            false,
            result.operation_id,
        )
    } else {
        let result: CommittedVersion = serde_json::from_str(result_json)
            .map_err(|_| invalid("Invalid File Version result"))?;
        let project: Option<i64> = tx
            .query_row(
                "SELECT project_id FROM documents WHERE id=?1",
                [result.document_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let workspace = match bound
            .as_ref()
            .map(|v| v.1.workspace_id.as_str())
            .or(workspace_id)
        {
            Some(value) => value.to_owned(),
            None => return Ok(()),
        };
        let object = ObjectRef {
            workspace_id: workspace,
            scope: super::file_scope::scope(project),
            kind: ObjectKind::File,
            id: result.document_id.to_string(),
        };
        (
            object,
            result.version_number,
            result.content_hash,
            result.no_change,
            super::file_versions::token(),
        )
    };
    object.key()?;
    if object.kind != ObjectKind::File {
        return Err(invalid("Expected a native File result"));
    }
    let document_id: i64 = object
        .id
        .parse()
        .map_err(|_| invalid("Invalid File identity"))?;
    let current: i64 = tx
        .query_row(
            "SELECT current_version_number FROM documents WHERE id=?1",
            [document_id],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    let (after, registered) = version_ref(tx, document_id, version)?;
    if current != version || registered.as_deref() != Some(hash.as_str()) {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "File receipt differs from its native version",
        ));
    }
    let before_version = if operation == "file.create" {
        None
    } else {
        Some(if no_change { version } else { version - 1 })
    };
    let before = before_version
        .map(|v| version_ref(tx, document_id, v))
        .transpose()?;
    if let Some((output, grant)) = &bound {
        let (scope, _, _, _, _) = super::agent_outputs::intent_scope(&output.staged.intent)?;
        if object.workspace_id != grant.workspace_id || scope != object.scope {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "File output ownership changed",
            ));
        }
        let project_id = super::file_scope::owner(&scope);
        let live: bool = tx
            .query_row(
                "SELECT ?1 IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=?1 AND is_archived=0)",
                [project_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        if !live {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "File Project was archived before commit",
            ));
        }
        let approved_payload = match &output.staged.intent {
            OutputIntent::FileCreate {
                project_id,
                safe_name,
                utf8_content,
            } => {
                use sha2::{Digest, Sha256};
                let expected_hash = format!("sha256:{:x}", Sha256::digest(utf8_content.as_bytes()));
                let name: String = tx
                    .query_row(
                        "SELECT base_name FROM documents WHERE id=?1",
                        [document_id],
                        |r| r.get(0),
                    )
                    .map_err(io_error)?;
                if expected_hash != hash || name != *safe_name || version != 1 {
                    return Err(AgentError::new(
                        ErrorCode::OutputCommitFailed,
                        "Created File differs from the approved candidate",
                    ));
                }
                serde_json::to_value(AgentFileCreateInput {
                    project_id: *project_id,
                    safe_name: safe_name.clone(),
                    utf8_content: utf8_content.clone(),
                })
                .map_err(|_| invalid("Invalid File candidate"))?
            }
            OutputIntent::FilePatch { patch } => {
                json!({"kind":"registered_text","object":patch.object,"expected_version_number":patch.expected_version_number,"expected_content_hash":patch.expected_content_hash,"patch_hash":patch.validate()?})
            }
            OutputIntent::FileUpdate {
                target,
                expected_version,
                expected_hash,
                staged_content_id,
            } => {
                json!({"kind":"registered_stage","object":target,"expected_version_number":expected_version,"expected_content_hash":expected_hash,"staged_content_id":staged_content_id})
            }
            OutputIntent::FileRestore { restore } => {
                json!({"kind":"registered_restore","object":restore.object,"expected_version_number":restore.expected_version_number,"expected_content_hash":restore.expected_content_hash,"version_id":restore.version_id})
            }
            _ => return Err(invalid("Expected a File candidate")),
        };
        let approved_hash =
            super::agent_operations::operation_hash(caller, request_id, &approved_payload)?;
        let saved_hash:String=tx.query_row("SELECT payload_hash FROM agent_operation_receipts WHERE caller_id=?1 AND request_id=?2",params![caller,request_id],|r|r.get(0)).map_err(io_error)?;
        if saved_hash != approved_hash {
            return Err(AgentError::new(
                ErrorCode::IdempotencyConflict,
                "Native File receipt belongs to a different candidate",
            ));
        }
        if operation != "file.create" {
            let (target, expected, expected_hash) = baseline(&output.staged.intent)?;
            if target != &object
                || before_version != Some(i64::from(expected))
                || before.as_ref().and_then(|v| v.1.as_deref()) != Some(expected_hash)
            {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "File output differs from the approved baseline",
                ));
            }
        }
    }
    let metadata = super::agent_file_undo::agent_file_creation_metadata(tx, document_id)?;
    let mut context = json!({"afterBodyHash":hash,"afterMetadata":metadata,"noChange":no_change});
    if let Some((output, _)) = &bound {
        let map = context.as_object_mut().unwrap();
        map.insert("outputId".into(), json!(output.staged.id));
        map.insert("outputRevision".into(), json!(output.staged.revision));
        map.insert("mode".into(), json!(output.mode));
        map.insert("originalMode".into(), json!(output.mode));
        let grant = &bound.as_ref().unwrap().1;
        map.insert("originalGrant".into(),json!({"workspaceId":grant.workspace_id,"workspaceContent":grant.workspace_content,"projectIds":grant.project_ids,"operations":grant.operations}));
        map.insert("sources".into(), json!(output.staged.sources));
        map.insert("sourceChanged".into(), json!(output.source_changed));
    }
    let context =
        serde_json::to_string(&context).map_err(|_| invalid("Invalid File receipt context"))?;
    if context.len() > 256 * 1024 {
        return Err(invalid("File receipt context exceeds its budget"));
    }
    let undo = if no_change
        || operation != "file.create" && before.as_ref().and_then(|v| v.1.as_ref()).is_none()
    {
        "unavailable"
    } else {
        "available"
    };
    let changed=tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=?2,target_ref_json=?3,before_revision=?4,after_revision=?5,before_snapshot_ref=?6,after_snapshot_ref=?7,output_context_json=?8,undo_state=?9 WHERE caller_id=?10 AND request_id=?11 AND operation=?12 AND state='committed' AND result_json=?13",params![operation_id,bound.as_ref().map(|v|&v.0.staged.run_id),serde_json::to_string(&object).map_err(|_|invalid("Invalid File object"))?,before_version,version,before.as_ref().map(|v|&v.0),after,context,undo,caller,request_id,operation,result_json]).map_err(io_error)?;
    if changed != 1 {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Original File receipt is missing",
        ));
    }
    if let Some((output, _)) = bound {
        let changed=tx.execute("UPDATE agent_outputs SET state='committed',object_ref_json=?1 WHERE id=?2 AND revision=?3 AND state='committing'",params![serde_json::to_string(&object).map_err(|_|invalid("Invalid File object"))?,output.staged.id,output.staged.revision as i64]).map_err(io_error)?;
        if changed != 1 {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "File output changed before settlement",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            conversation::RunPreparation,
            models::ExecutionMode,
            output_runtime::{OutputState, StageRecordInput},
        },
        workspace_commit_fence::WorkspaceCommitFence,
    };
    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        request: RequestContext,
        project: i64,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let (metadata, paths) =
            crate::workspace::create_workspace(root.path(), "password").unwrap();
        let db = Database::open(&paths.db_path, root.path(), None).unwrap();
        let project = db
            .project_create(crate::models::ProjectCreateInput {
                name: "Outputs".into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id;
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "file-outputs".into(),
        };
        let gui = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "fixture".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project],
                operations: [
                    "session.read",
                    "session.write",
                    "run.start",
                    "output.stage",
                    "output.read",
                    "output.update",
                    "output.commit",
                    "content.create",
                    "source.read",
                    "file.update",
                    "file.restore",
                    "operation.read",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            },
        };
        let scope = Scope::Project {
            project_id: project,
        };
        let session = db
            .agent_session_create(&gui, &binding, &scope, "Files", "pi", None)
            .unwrap();
        let run = db
            .agent_run_prepare(
                &gui,
                &binding,
                &session.id,
                "message",
                &RunPreparation {
                    run_id: "e".repeat(32),
                    context_manifest: json!({"scope":scope,"mode":ExecutionMode::Collaborate}),
                },
            )
            .unwrap()
            .run;
        db.agent_run_start(&gui, &binding, &run.id).unwrap();
        Fixture {
            _root: root,
            db,
            project,
            request: RequestContext {
                caller: Caller::BuiltinRun { run_id: run.id },
                request_id: "stage".into(),
                ..gui
            },
        }
    }
    fn candidate(f: &Fixture) -> StageRecordInput {
        StageRecordInput {
            intent: OutputIntent::FileCreate {
                project_id: Some(f.project),
                safe_name: "result.txt".into(),
                utf8_content: "Approved body".into(),
            },
            sources: vec![],
        }
    }
    fn count(db: &Database, table: &str) -> i64 {
        db.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    #[test]
    fn file_output_callback_rejects_another_candidate_body_and_preserves_native_rollback() {
        let mut f = fixture();
        let input = candidate(&f);
        let outbox_before = count(&f.db, "agent_change_log");
        let output =
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &input)
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.request, &f.request.binding, &output.staged.id, 1)
                .unwrap();
        let mut native = f.request.clone();
        native.request_id = prepared.commit_request_id;
        let fence = WorkspaceCommitFence::new();
        let wrong = AgentFileCreateInput {
            project_id: Some(f.project),
            safe_name: "result.txt".into(),
            utf8_content: "Different body".into(),
        };
        assert_eq!(
            f.db.agent_file_create_bound(&native, &native.binding, &wrong, &fence)
                .unwrap_err()
                .code,
            ErrorCode::OutputCommitFailed
        );
        assert_eq!(count(&f.db, "documents"), 0);
        assert_eq!(count(&f.db, "document_versions"), 0);
        assert_eq!(count(&f.db, "agent_change_log"), outbox_before);
        assert_eq!(
            f.db.agent_output_get(&f.request, &f.request.binding, &output.staged.id)
                .unwrap()
                .state,
            OutputState::Committing
        );
        let correct = AgentFileCreateInput {
            utf8_content: "Approved body".into(),
            ..wrong
        };
        let saved =
            f.db.agent_file_create_bound(&native, &native.binding, &correct, &fence)
                .unwrap();
        assert_eq!(saved.version_number, 1);
        let actual =
            f.db.agent_output_get(&f.request, &f.request.binding, &output.staged.id)
                .unwrap();
        let receipt = actual.file_receipt.unwrap();
        assert_eq!(receipt.document_id, saved.object.id.parse::<i64>().unwrap());
        assert_eq!(receipt.content_hash, saved.content_hash);
        assert_eq!(receipt.version_number, 1);
        assert!(!receipt.no_change);
        assert_eq!(count(&f.db, "documents"), 1);
    }
    #[test]
    fn file_output_receipt_keeps_frozen_authority_and_version_identity_after_session_deletion() {
        let mut f = fixture();
        let input = candidate(&f);
        let output =
            f.db.agent_output_stage_record(&f.request, &f.request.binding, &input)
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.request, &f.request.binding, &output.staged.id, 1)
                .unwrap();
        let mut native = f.request.clone();
        native.request_id = prepared.commit_request_id;
        let saved =
            f.db.agent_file_create_bound(
                &native,
                &native.binding,
                &AgentFileCreateInput {
                    project_id: Some(f.project),
                    safe_name: "result.txt".into(),
                    utf8_content: "Approved body".into(),
                },
                &WorkspaceCommitFence::new(),
            )
            .unwrap();
        let (snapshot,context):(String,String)=f.db.conn.query_row("SELECT after_snapshot_ref,output_context_json FROM agent_operation_receipts WHERE operation_id=?1",[&saved.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let context: serde_json::Value = serde_json::from_str(&context).unwrap();
        assert_eq!(context["originalMode"], "collaborate");
        assert_eq!(
            context["originalGrant"]["workspaceId"],
            f.request.binding.workspace_id
        );
        assert_eq!(context["originalGrant"]["projectIds"], json!([f.project]));
        let version: i64 =
            f.db.conn
                .query_row(
                    "SELECT version_number FROM document_versions WHERE CAST(id AS TEXT)=?1",
                    [&snapshot],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(version, 1);
        f.db.conn.execute("DELETE FROM agent_sessions", []).unwrap();
        assert_eq!(count(&f.db, "agent_outputs"), 0);
        assert_eq!(count(&f.db, "agent_runs"), 0);
        let retained:(String,String)=f.db.conn.query_row("SELECT after_snapshot_ref,output_context_json FROM agent_operation_receipts WHERE operation_id=?1",[&saved.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(retained.0, snapshot);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&retained.1).unwrap(),
            context
        );
        assert_eq!(count(&f.db, "documents"), 1);
    }
}
