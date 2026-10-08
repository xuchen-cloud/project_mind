//! Deterministic Record and Todo candidates, backed by schema26 staging and the original
//! atomic receipt. Native Record transactions alone mark an output committed.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ExecutionMode, ObjectKind, ObjectRef, Scope, SourceRef, WorkspaceBinding},
        output_runtime::*,
        outputs::{OutputIntent, StagedOutput},
        runtime::RunState,
    },
    record_documents::{
        record_patch_target, validate_record_patch, RecordCommittedHead, RecordPatchResult,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Output is outside the authorized run or execution mode",
    )
}
fn damaged() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Invalid stored Record output")
}
fn conflict() -> AgentError {
    AgentError::new(
        ErrorCode::RevisionConflict,
        "Staged output changed; reload before continuing",
    )
}
fn id_check(id: &str) -> AgentResult<()> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid output identity"));
    }
    Ok(())
}
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid output payload"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> AgentResult<T> {
    serde_json::from_str(value).map_err(|_| damaged())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenGrant {
    workspace_id: String,
    workspace_content: bool,
    project_ids: Vec<i64>,
    operations: Vec<String>,
}
struct OutputRun {
    scope: Scope,
    mode: ExecutionMode,
    state: RunState,
    session_state: String,
    grant: ScopeGrant,
}
fn read_run(conn: &Connection, id: &str) -> AgentResult<OutputRun> {
    id_check(id)?;
    let row=conn.query_row("SELECT s.scope_key,s.state,r.state,r.context_manifest_json,r.grant_json FROM agent_runs r JOIN agent_sessions s ON s.id=r.session_id WHERE r.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Output run not found"))?;
    let scope = parse_scope_key(&row.0)?;
    let manifest: Value = decode(&row.3)?;
    if manifest["scope"] != serde_json::to_value(&scope).map_err(|_| damaged())? {
        return Err(damaged());
    }
    let grant: FrozenGrant = decode(&row.4)?;
    Ok(OutputRun {
        scope,
        mode: serde_json::from_value(manifest["mode"].clone()).map_err(|_| damaged())?,
        state: decode(&encode(&row.2)?)?,
        session_state: row.1,
        grant: ScopeGrant {
            workspace_id: grant.workspace_id,
            workspace_content: grant.workspace_content,
            project_ids: grant.project_ids,
            operations: grant.operations,
        },
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    intent: OutputIntent,
    source_changed: Vec<bool>,
    #[serde(default)]
    error_code: Option<ErrorCode>,
    #[serde(default)]
    dismissed: bool,
}
pub(super) fn read_output(conn: &Connection, id: &str) -> AgentResult<RuntimeOutput> {
    id_check(id)?;
    let row=conn.query_row("SELECT o.run_id,o.ordinal,o.revision,o.payload_json,o.sources_json,o.state,o.object_ref_json,json_extract(r.context_manifest_json,'$.mode') FROM agent_outputs o JOIN agent_runs r ON r.id=o.run_id WHERE o.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,String>(7)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Output not found"))?;
    let payload: Payload = decode(&row.3)?;
    let sources: Vec<SourceRef> = decode(&row.4)?;
    if payload.source_changed.len() != sources.len() {
        return Err(damaged());
    }
    let file_receipt = super::agent_file_outputs::file_output_receipt(conn, id, &row.0, row.2)?;
    Ok(RuntimeOutput {
        staged: StagedOutput {
            id: id.into(),
            run_id: row.0,
            ordinal: row.1,
            revision: u64::try_from(row.2)
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(damaged)?,
            intent: payload.intent,
            sources,
        },
        state: decode(&encode(&row.5)?)?,
        object: row.6.as_deref().map(decode).transpose()?,
        source_changed: payload.source_changed,
        mode: decode(&encode(&row.7)?)?,
        error_code: payload.error_code,
        dismissed: payload.dismissed,
        file_receipt,
    })
}
pub(super) fn intent_scope(
    intent: &OutputIntent,
) -> AgentResult<(
    Scope,
    &'static str,
    &'static str,
    Option<&ObjectRef>,
    Option<u64>,
)> {
    match intent {
        OutputIntent::RecordCreate { scope, .. } => {
            Ok((scope.clone(), "content.create", "create", None, None))
        }
        OutputIntent::RecordPatch { patch } => {
            record_patch_target(patch)?;
            Ok((
                patch.record.scope.clone(),
                "record.patch",
                "record_patch",
                Some(&patch.record),
                Some(patch.base_revision),
            ))
        }
        OutputIntent::TodoCreate { scope, .. } => {
            Ok((scope.clone(), "content.create", "create", None, None))
        }
        OutputIntent::TodoUpdate {
            target,
            expected_revision,
            ..
        } => {
            if target.kind != ObjectKind::Todo
                || *expected_revision == 0
                || *expected_revision > i64::MAX as u64
            {
                return Err(invalid("Invalid Todo update target or revision"));
            }
            target.key()?;
            Ok((
                target.scope.clone(),
                "todo.update",
                "todo_update",
                Some(target),
                Some(*expected_revision),
            ))
        }
        OutputIntent::FileCreate { project_id, .. } if *project_id > 0 => Ok((
            Scope::Project {
                project_id: *project_id,
            },
            "content.create",
            "create",
            None,
            None,
        )),
        OutputIntent::FileUpdate {
            target,
            expected_version,
            expected_hash,
            staged_content_id,
        } => {
            target.key()?;
            if target.kind != ObjectKind::File
                || *expected_version == 0
                || !super::file_versions::valid_hash(expected_hash)
                || !crate::file_content::valid_stage_id(staged_content_id)
            {
                return Err(invalid("Invalid staged File update"));
            }
            Ok((
                target.scope.clone(),
                "file.update",
                "file_update",
                Some(target),
                Some(u64::from(*expected_version)),
            ))
        }
        OutputIntent::FilePatch { patch } => {
            patch.validate()?;
            Ok((
                patch.object.scope.clone(),
                "file.update",
                "file_update",
                Some(&patch.object),
                Some(u64::from(patch.expected_version_number)),
            ))
        }
        OutputIntent::FileRestore { restore } => {
            restore.validate()?;
            Ok((
                restore.object.scope.clone(),
                "file.restore",
                "file_update",
                Some(&restore.object),
                Some(u64::from(restore.expected_version_number)),
            ))
        }
        _ => Err(invalid("File creation requires a real Project")),
    }
}
fn output_kind(intent: &OutputIntent) -> AgentResult<&'static str> {
    match intent {
        OutputIntent::RecordCreate { .. } | OutputIntent::RecordPatch { .. } => Ok("record"),
        OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. } => Ok("todo"),
        OutputIntent::FileCreate { .. }
        | OutputIntent::FileUpdate { .. }
        | OutputIntent::FilePatch { .. }
        | OutputIntent::FileRestore { .. } => Ok("file"),
    }
}
fn dedupe_key(intent: &OutputIntent) -> Option<&str> {
    match intent {
        OutputIntent::TodoCreate { dedupe_key, .. } => Some(dedupe_key),
        _ => None,
    }
}
fn dedupe_output(
    conn: &Connection,
    run_id: &str,
    input: &StageRecordInput,
) -> AgentResult<Option<RuntimeOutput>> {
    let Some(key) = dedupe_key(&input.intent) else {
        return Ok(None);
    };
    if key.is_empty() || key.len() > 128 {
        return Err(invalid("Todo action key must contain 1 to 128 bytes"));
    }
    let id: Option<String> = conn.query_row("SELECT id FROM agent_outputs WHERE run_id=?1 AND kind='todo' AND intent='create' AND dedupe_key=?2", params![run_id,key], |r|r.get(0)).optional().map_err(io_error)?;
    let Some(id) = id else {
        return Ok(None);
    };
    let output = read_output(conn, &id)?;
    let saved = StageRecordInput {
        intent: output.staged.intent.clone(),
        sources: output.staged.sources.clone(),
    };
    if encode(&saved)? != encode(input)? {
        return Err(AgentError::new(
            ErrorCode::IdempotencyConflict,
            "Todo action already has a different candidate; read or update the existing output",
        ));
    }
    Ok(Some(output))
}
fn active(run: &OutputRun) -> AgentResult<()> {
    if run.state != RunState::Running || run.session_state != "active" {
        return Err(AgentError::new(
            ErrorCode::InvalidRunTransition,
            "Run cannot stage or prepare a new output",
        ));
    }
    Ok(())
}
fn writable(run: &OutputRun) -> AgentResult<()> {
    if run.mode == ExecutionMode::ReadOnly {
        Err(denied())
    } else {
        Ok(())
    }
}
fn frozen(request: &RequestContext, run: &OutputRun) -> RequestContext {
    RequestContext {
        binding: request.binding.clone(),
        scope_grant: run.grant.clone(),
        caller: request.caller.clone(),
        request_id: request.request_id.clone(),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    query_hash: String,
    after_ordinal: u32,
    snapshot_ordinal: u32,
}

impl Database {
    pub(crate) fn agent_output_scope(&self, id: &str) -> AgentResult<Scope> {
        let output = read_output(&self.conn, id)?;
        Ok(read_run(&self.conn, &output.staged.run_id)?.scope)
    }
    pub(crate) fn agent_output_run_scope(&self, run_id: &str) -> AgentResult<Scope> {
        Ok(read_run(&self.conn, run_id)?.scope)
    }
    pub(crate) fn agent_output_gui_grant_for_run(
        &self,
        binding: &WorkspaceBinding,
        run_id: &str,
        operations: &[&str],
    ) -> AgentResult<ScopeGrant> {
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Output database belongs to another Workspace",
            ));
        }
        let run = read_run(&self.conn, run_id)?;
        if run.grant.workspace_id != binding.workspace_id {
            return Err(denied());
        }
        Ok(ScopeGrant {
            operations: operations.iter().map(|s| (*s).to_owned()).collect(),
            ..run.grant
        })
    }
    pub(crate) fn agent_output_gui_grant(
        &self,
        binding: &WorkspaceBinding,
        id: &str,
        operations: &[&str],
    ) -> AgentResult<ScopeGrant> {
        let output = read_output(&self.conn, id)?;
        self.agent_output_gui_grant_for_run(binding, &output.staged.run_id, operations)
    }
    pub(crate) fn agent_output_validate_document(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
        document: &Value,
        operation: &str,
    ) -> AgentResult<()> {
        if !matches!(operation, "content.create" | "record.patch") {
            return Err(denied());
        }
        let run = self.output_authorize(request, binding, run_id, operation)?;
        writable(&run)?;
        let captured = frozen(request, &run);
        captured.authorize(binding, &run.scope, operation)?;
        for scope in self.record_reference_scopes(document)? {
            request.authorize(binding, &scope, operation)?;
            captured.authorize(binding, &scope, operation)?;
        }
        Ok(())
    }
    pub(crate) fn agent_output_stage_validate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &StageRecordInput,
    ) -> AgentResult<Option<RuntimeOutput>> {
        let Caller::BuiltinRun { run_id } = &request.caller else {
            return Err(denied());
        };
        let run = self.output_authorize(request, binding, run_id, "output.stage")?;
        writable(&run)?;
        if let Some(previous) = self.agent_operation_replay::<RuntimeOutput>(
            &request.caller.key(),
            &request.request_id,
            "output.stage",
            input,
        )? {
            return Ok(Some(self.agent_output_get(
                request,
                binding,
                &previous.staged.id,
            )?));
        }
        if let Some(output) = dedupe_output(&self.conn, run_id, input)? {
            return Ok(Some(output));
        }
        active(&run)?;
        self.output_validate_candidate(request, binding, &run, input)?;
        Ok(None)
    }
    fn output_authorize(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
        operation: &str,
    ) -> AgentResult<OutputRun> {
        if self
            .native_workspace_id
            .as_ref()
            .is_some_and(|id| id != &binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Output database belongs to another Workspace",
            ));
        }
        let run = read_run(&self.conn, run_id)?;
        request.authorize(binding, &run.scope, operation)?;
        match &request.caller {
            Caller::Gui => {}
            Caller::BuiltinRun { run_id: bound } if bound == run_id => {
                frozen(request, &run).authorize(binding, &run.scope, operation)?
            }
            _ => return Err(denied()),
        }
        Ok(run)
    }
    fn output_validate_candidate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run: &OutputRun,
        input: &StageRecordInput,
    ) -> AgentResult<Payload> {
        let (scope, operation, _, target, _) = intent_scope(&input.intent)?;
        if scope != run.scope {
            return Err(denied());
        }
        request.authorize(binding, &scope, operation)?;
        frozen(request, run).authorize(binding, &scope, operation)?;
        self.source_live_scope(&scope)?;
        let max_payload = if output_kind(&input.intent)? == "file" {
            16 * 1024 * 1024
        } else {
            1024 * 1024
        };
        if encode(input)?.len() > max_payload || input.sources.len() > 20 {
            return Err(invalid("Output candidate exceeds staging budget"));
        }
        match &input.intent {
            OutputIntent::RecordCreate {
                title, markdown, ..
            } => {
                if title.trim().is_empty()
                    || title.chars().count() > 1000
                    || markdown.trim().is_empty()
                {
                    return Err(invalid(
                        "Record candidate requires a bounded title and complete body",
                    ));
                }
            }
            OutputIntent::RecordPatch { patch } => {
                let object = target.unwrap();
                let resolved = self
                    .agent_resolve_object(object, &binding.workspace_id)?
                    .ok_or_else(|| {
                        AgentError::new(ErrorCode::NotFound, "Record target not found")
                    })?;
                request.authorize_object(binding, object, &resolved, operation)?;
                let head = self
                    .record_document_head(&record_patch_target(patch)?)?
                    .ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::SourceNotReady,
                            "Initialize the Record document before staging a patch",
                        )
                    })?;
                if head.head_revision != patch.base_revision {
                    return Err(AgentError::new(
                        ErrorCode::RevisionConflict,
                        "Record changed since the candidate's base revision",
                    ));
                }
                validate_record_patch(patch, &head)?;
            }
            OutputIntent::TodoCreate { .. } | OutputIntent::TodoUpdate { .. } => {
                self.agent_todo_validate_candidate(
                    request,
                    binding,
                    &run.scope,
                    &frozen(request, run),
                    &input.intent,
                )?;
            }
            OutputIntent::FileCreate { .. }
            | OutputIntent::FileUpdate { .. }
            | OutputIntent::FilePatch { .. }
            | OutputIntent::FileRestore { .. } => {
                self.agent_file_validate_candidate(
                    request,
                    binding,
                    &frozen(request, run),
                    &input.intent,
                )?;
            }
        }
        let mut changed = Vec::with_capacity(input.sources.len());
        for source in &input.sources {
            source.object.key()?;
            if source.revision.is_empty()
                || source.revision.len() > 128
                || source.title.chars().count() > 1000
                || source.excerpt.chars().count() > 2000
                || encode(source)?.len() > 20_000
            {
                return Err(invalid("Source reference exceeds staging metadata budget"));
            }
            request.authorize(binding, &source.object.scope, "source.read")?;
            frozen(request, run).authorize(binding, &source.object.scope, "source.read")?;
            // Shared source/version checks preserve legitimate historical refs.
            changed.push(crate::overview_evidence::reference_state(
                self, request, binding, source,
            )?);
        }
        Ok(Payload {
            intent: input.intent.clone(),
            source_changed: changed,
            error_code: None,
            dismissed: false,
        })
    }
    pub(crate) fn agent_output_stage_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &StageRecordInput,
    ) -> AgentResult<RuntimeOutput> {
        let Caller::BuiltinRun { run_id } = &request.caller else {
            return Err(denied());
        };
        let run = self.output_authorize(request, binding, run_id, "output.stage")?;
        writable(&run)?;
        // Replay remains a read of the original successful stage, including
        // after a terminal run. An expired run can never allocate a new stage.
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,"output.stage",input,|tx| {
            let run=read_run(tx,run_id)?;writable(&run)?;
            if let Some(output) = dedupe_output(tx,run_id,input)? { return Ok((output,None)); }
            active(&run)?;
            let payload=self.output_validate_candidate(request,binding,&run,input)?;
            let (_,_,kind,target,base)=intent_scope(&input.intent)?;
            let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal)+1,0) FROM agent_outputs WHERE run_id=?1",[run_id],|r|r.get(0)).map_err(io_error)?;
            let ordinal=u32::try_from(ordinal).map_err(|_|invalid("Output ordinal exceeds storage budget"))?;
            let id=random_id();
            tx.execute("INSERT INTO agent_outputs(id,run_id,ordinal,kind,intent,target_ref_json,base_revision,payload_json,sources_json,state,dedupe_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'staged',?10)",params![id,run_id,ordinal,output_kind(&input.intent)?,kind,target.map(encode).transpose()?,base.map(|v|v as i64),encode(&payload)?,encode(&input.sources)?,dedupe_key(&input.intent)]).map_err(io_error)?;
            Ok((read_output(tx,&id)?,None))
        })
    }
    pub(crate) fn agent_output_get(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
    ) -> AgentResult<RuntimeOutput> {
        let output = read_output(&self.conn, id)?;
        self.output_authorize(request, binding, &output.staged.run_id, "output.read")?;
        Ok(output)
    }
    pub(crate) fn agent_output_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
        cursor: Option<&str>,
        limit: u16,
    ) -> AgentResult<OutputPage> {
        if limit == 0 || limit > OUTPUT_PAGE_MAX {
            return Err(invalid("Output page exceeds its bound"));
        }
        let run = self.output_authorize(request, binding, run_id, "output.read")?;
        let query_hash = format!(
            "{:x}",
            Sha256::digest(encode(
                &json!({"runId":run_id,"scope":run.scope,"limit":limit})
            )?)
        );
        let max: Option<u32> = self
            .conn
            .query_row(
                "SELECT MAX(ordinal) FROM agent_outputs WHERE run_id=?1",
                [run_id],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let Some(max) = max else {
            return Ok(OutputPage {
                outputs: vec![],
                next_cursor: None,
            });
        };
        let cursor: Option<Cursor> = cursor
            .map(|raw| {
                if raw.len() > 1024 {
                    return Err(invalid("Invalid output cursor"));
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(raw)
                    .map_err(|_| invalid("Invalid output cursor"))?;
                let cursor: Cursor =
                    serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid output cursor"))?;
                if cursor.query_hash != query_hash
                    || cursor.after_ordinal > cursor.snapshot_ordinal
                    || cursor.snapshot_ordinal > max
                {
                    return Err(invalid("Output cursor no longer matches its query"));
                }
                Ok(cursor)
            })
            .transpose()?;
        let snapshot = cursor.as_ref().map_or(max, |c| c.snapshot_ordinal);
        let after = cursor.as_ref().map_or(-1, |c| c.after_ordinal as i64);
        let mut statement=self.conn.prepare("SELECT id FROM agent_outputs WHERE run_id=?1 AND ordinal>?2 AND ordinal<=?3 ORDER BY ordinal,id LIMIT ?4").map_err(io_error)?;
        let ids = statement
            .query_map(params![run_id, after, snapshot, limit as i64 + 1], |r| {
                r.get::<_, String>(0)
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let has_more = ids.len() > limit as usize;
        let outputs = ids
            .iter()
            .take(limit as usize)
            .map(|id| read_output(&self.conn, id))
            .collect::<AgentResult<Vec<_>>>()?;
        let next_cursor = if has_more {
            Some(URL_SAFE_NO_PAD.encode(encode(&Cursor {
                query_hash,
                after_ordinal: outputs.last().unwrap().staged.ordinal,
                snapshot_ordinal: snapshot,
            })?))
        } else {
            None
        };
        Ok(OutputPage {
            outputs,
            next_cursor,
        })
    }
    /// Validate a GUI patch preview without reserving or mutating the output.
    /// The caller repeats this check after asynchronous document comparison.
    pub(crate) fn agent_output_preview_validate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<RuntimeOutput> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied());
        }
        let output = read_output(&self.conn, id)?;
        let run = self.output_authorize(request, binding, &output.staged.run_id, "output.read")?;
        frozen(request, &run).authorize(binding, &run.scope, "output.read")?;
        if output.staged.revision != expected_revision {
            return Err(conflict());
        }
        if !matches!(output.state, OutputState::Staged | OutputState::Failed) {
            return Err(AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Only an uncommitted candidate can be previewed",
            ));
        }
        if !matches!(output.staged.intent, OutputIntent::RecordPatch { .. }) {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "Only Record patch candidates support a difference preview",
            ));
        }
        self.output_validate_candidate(
            request,
            binding,
            &run,
            &StageRecordInput {
                intent: output.staged.intent.clone(),
                sources: output.staged.sources.clone(),
            },
        )?;
        Ok(output)
    }
    pub(crate) fn agent_output_update_validate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OutputUpdateInput,
    ) -> AgentResult<RuntimeOutput> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied());
        }
        let previous = read_output(&self.conn, &input.output_id)?;
        let run =
            self.output_authorize(request, binding, &previous.staged.run_id, "output.update")?;
        writable(&run)?;
        if input.expected_revision == 0 || input.expected_revision >= i64::MAX as u64 {
            return Err(invalid("Invalid output revision"));
        }
        if self
            .agent_operation_replay::<RuntimeOutput>(
                &request.caller.key(),
                &request.request_id,
                "output.update",
                input,
            )?
            .is_some()
        {
            return Ok(previous);
        }
        if previous.state != OutputState::Staged
            && !(previous.state == OutputState::Failed && previous.dismissed)
        {
            return Err(AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Only an uncommitted candidate can be edited",
            ));
        }
        if previous.staged.revision != input.expected_revision {
            return Err(conflict());
        }
        let before = intent_scope(&previous.staged.intent)?;
        let after = intent_scope(&input.candidate.intent)?;
        if before.2 != after.2
            || before.3 != after.3
            || output_kind(&previous.staged.intent)? != output_kind(&input.candidate.intent)?
            || dedupe_key(&previous.staged.intent) != dedupe_key(&input.candidate.intent)
        {
            return Err(invalid("Output candidate cannot change kind or target"));
        }
        self.output_validate_candidate(request, binding, &run, &input.candidate)?;
        Ok(previous)
    }
    pub(crate) fn agent_output_update(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &OutputUpdateInput,
    ) -> AgentResult<RuntimeOutput> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied());
        }
        let previous = read_output(&self.conn, &input.output_id)?;
        let run =
            self.output_authorize(request, binding, &previous.staged.run_id, "output.update")?;
        writable(&run)?;
        if input.expected_revision == 0 || input.expected_revision >= i64::MAX as u64 {
            return Err(invalid("Invalid staged output revision"));
        }
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,"output.update",input,|tx| {
            let previous=read_output(tx,&input.output_id)?;
            if previous.state != OutputState::Staged && !(previous.state == OutputState::Failed && previous.dismissed) {return Err(AgentError::new(ErrorCode::OutputCommitFailed,"Only uncommitted candidates can be edited"));}
            if previous.staged.revision!=input.expected_revision {return Err(conflict());}
            let (_,_,old_kind,old_target,_)=intent_scope(&previous.staged.intent)?;
            let (_,_,kind,target,base)=intent_scope(&input.candidate.intent)?;
            if old_kind!=kind || old_target!=target || output_kind(&previous.staged.intent)? != output_kind(&input.candidate.intent)? || dedupe_key(&previous.staged.intent) != dedupe_key(&input.candidate.intent) {return Err(denied());}
            let run=read_run(tx,&previous.staged.run_id)?;writable(&run)?;
            let payload=self.output_validate_candidate(request,binding,&run,&input.candidate)?;
            let changed=tx.execute("UPDATE agent_outputs SET revision=revision+1,payload_json=?1,sources_json=?2,base_revision=?3 WHERE id=?4 AND revision=?5 AND state IN ('staged','failed')",params![encode(&payload)?,encode(&input.candidate.sources)?,base.map(|v|v as i64),input.output_id,input.expected_revision as i64]).map_err(io_error)?;
            if changed!=1 {return Err(conflict());}
            Ok((read_output(tx,&input.output_id)?,None))
        })
    }
    /// Dismiss is a durable GUI decision, without a business mutation or a
    /// change to the native commit state. Its revision invalidates old approvals.
    pub(crate) fn agent_output_dismiss(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<RuntimeOutput> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(denied());
        }
        if expected_revision == 0 || expected_revision >= i64::MAX as u64 {
            return Err(invalid("Invalid output revision"));
        }
        let current = read_output(&self.conn, id)?;
        let run =
            self.output_authorize(request, binding, &current.staged.run_id, "output.update")?;
        writable(&run)?;
        frozen(request, &run).authorize(binding, &run.scope, "output.update")?;
        if !(run.mode == ExecutionMode::Review
            || run.mode == ExecutionMode::Collaborate && run.state.is_terminal())
        {
            return Err(denied());
        }
        let payload = json!({"outputId":id,"expectedRevision":expected_revision});
        self.agent_atomic_operation::<RuntimeOutput>(
            &request.caller.key(), &request.request_id, "output.dismiss", &payload, |tx| {
                let current = read_output(tx, id)?;
                let run = self.output_authorize(request, binding, &current.staged.run_id, "output.update")?;
                writable(&run)?;
                frozen(request, &run).authorize(binding, &run.scope, "output.update")?;
                if !(run.mode == ExecutionMode::Review
                    || run.mode == ExecutionMode::Collaborate && run.state.is_terminal())
                { return Err(denied()); }
                if current.staged.revision != expected_revision { return Err(conflict()); }
                if current.dismissed || !matches!(current.state, OutputState::Staged | OutputState::Failed) {
                    return Err(AgentError::new(ErrorCode::OutputCommitFailed,"Only an uncommitted candidate can be dismissed"));
                }
                let changed = tx.execute("UPDATE agent_outputs SET revision=revision+1,payload_json=json_set(payload_json,'$.dismissed',json('true')) WHERE id=?1 AND revision=?2 AND state IN ('staged','failed')",params![id,expected_revision as i64]).map_err(io_error)?;
                if changed != 1 { return Err(conflict()); }
                Ok((read_output(tx,id)?,None))
            },
        )?;
        // Original request replays must return the current decision and revision,
        // including any later explicit edit, rather than their old receipt value.
        read_output(&self.conn, id)
    }
    pub(crate) fn agent_output_commit_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<PreparedOutputCommit> {
        let tx = Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let mut output = read_output(&tx, id)?;
        let run =
            self.output_authorize(request, binding, &output.staged.run_id, "output.commit")?;
        writable(&run)?;
        match &request.caller {
            Caller::Gui if run.mode == ExecutionMode::Review => {}
            Caller::Gui if run.mode == ExecutionMode::Collaborate && run.state.is_terminal() => {}
            Caller::BuiltinRun { .. } if run.mode == ExecutionMode::Collaborate => active(&run)?,
            _ => return Err(denied()),
        }
        if output.dismissed
            || matches!(output.state, OutputState::Committed)
            || matches!(output.state, OutputState::Failed) && !matches!(request.caller, Caller::Gui)
        {
            return Err(AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Output requires an explicit retry or is already committed",
            ));
        }
        if output.staged.revision != expected_revision {
            return Err(conflict());
        }
        let input = StageRecordInput {
            intent: output.staged.intent.clone(),
            sources: output.staged.sources.clone(),
        };
        let payload = self.output_validate_candidate(request, binding, &run, &input)?;
        let changed=tx.execute("UPDATE agent_outputs SET state='committing',payload_json=?1 WHERE id=?2 AND revision=?3 AND state IN ('staged','committing','failed')",params![encode(&payload)?,id,expected_revision as i64]).map_err(io_error)?;
        if changed != 1 {
            return Err(conflict());
        }
        output = read_output(&tx, id)?;
        let commit_request_id = format!("output:{}:{}", id, expected_revision);
        if let OutputIntent::RecordPatch { patch } = &mut output.staged.intent {
            patch.request_id = commit_request_id.clone();
        }
        tx.commit().map_err(io_error)?;
        Ok(PreparedOutputCommit {
            output,
            commit_request_id,
            mode: run.mode,
        })
    }
    pub(super) fn agent_output_commit_validate(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<RuntimeOutput> {
        let output = read_output(&self.conn, id)?;
        let run =
            self.output_authorize(request, binding, &output.staged.run_id, "output.commit")?;
        writable(&run)?;
        match &request.caller {
            Caller::Gui if run.mode == ExecutionMode::Review => {}
            Caller::Gui if run.mode == ExecutionMode::Collaborate && run.state.is_terminal() => {}
            Caller::BuiltinRun { .. } if run.mode == ExecutionMode::Collaborate => active(&run)?,
            _ => return Err(denied()),
        }
        if output.staged.revision != expected_revision {
            return Err(conflict());
        }
        if output.dismissed || output.state != OutputState::Committing {
            return Err(AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Output is not reserved for a native commit",
            ));
        }
        self.output_validate_candidate(
            request,
            binding,
            &run,
            &StageRecordInput {
                intent: output.staged.intent.clone(),
                sources: output.staged.sources.clone(),
            },
        )?;
        Ok(output)
    }
    pub(crate) fn agent_output_mark_failed(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
        error_code: ErrorCode,
    ) -> AgentResult<RuntimeOutput> {
        let tx = Transaction::new_unchecked(&self.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let output = read_output(&tx, id)?;
        let run =
            self.output_authorize(request, binding, &output.staged.run_id, "output.commit")?;
        writable(&run)?;
        match &request.caller {
            Caller::Gui if run.mode == ExecutionMode::Review => {}
            Caller::Gui if run.mode == ExecutionMode::Collaborate && run.state.is_terminal() => {}
            Caller::BuiltinRun { .. } if run.mode == ExecutionMode::Collaborate => {}
            _ => return Err(denied()),
        }
        if output.staged.revision != expected_revision {
            return Err(conflict());
        }
        if !matches!(output.state, OutputState::Committing | OutputState::Failed) {
            return Err(AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Only an uncommitted attempt can fail",
            ));
        }
        let mut payload: Payload = decode(
            &tx.query_row(
                "SELECT payload_json FROM agent_outputs WHERE id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .map_err(io_error)?,
        )?;
        payload.error_code = Some(error_code);
        tx.execute("UPDATE agent_outputs SET state='failed',payload_json=?1 WHERE id=?2 AND revision=?3 AND state IN ('committing','failed')",params![encode(&payload)?,id,expected_revision as i64]).map_err(io_error)?;
        let failed = read_output(&tx, id)?;
        tx.commit().map_err(io_error)?;
        Ok(failed)
    }
    pub(crate) fn agent_output_record_operation(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<Option<crate::agent::operations::OperationEntry>> {
        if self
            .agent_output_record_receipt(request, binding, id, expected_revision)?
            .is_none()
        {
            return Ok(None);
        }
        let operation_id: String = self.conn.query_row("SELECT operation_id FROM agent_operation_receipts WHERE run_id=(SELECT run_id FROM agent_outputs WHERE id=?1) AND request_id=?2 AND state='committed' AND json_extract(output_context_json,'$.outputId')=?1", params![id, format!("output:{id}:{expected_revision}")], |r| r.get(0)).map_err(io_error)?;
        self.agent_operation_access(request, binding, &operation_id, "output.commit")
            .map(Some)
    }
    /// The upload's original owner is derived from a validated frozen run,
    /// while the GUI retains its own authority for the eventual native write.
    pub(crate) fn agent_output_file_upload_owner(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        run_id: &str,
        operation: &str,
    ) -> AgentResult<RequestContext> {
        if !matches!(
            operation,
            "output.stage" | "output.update" | "output.commit"
        ) {
            return Err(denied());
        }
        let run = self.output_authorize(request, binding, run_id, operation)?;
        writable(&run)?;
        frozen(request, &run).authorize(binding, &run.scope, operation)?;
        Ok(RequestContext {
            caller: Caller::BuiltinRun {
                run_id: run_id.to_owned(),
            },
            ..frozen(request, &run)
        })
    }
    pub(crate) fn agent_output_record_receipt(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        id: &str,
        expected_revision: u64,
    ) -> AgentResult<Option<Value>> {
        let output = read_output(&self.conn, id)?;
        let run =
            self.output_authorize(request, binding, &output.staged.run_id, "output.commit")?;
        writable(&run)?;
        match &request.caller {
            Caller::Gui if run.mode == ExecutionMode::Review => {}
            Caller::Gui if run.mode == ExecutionMode::Collaborate && run.state.is_terminal() => {}
            Caller::BuiltinRun { .. } if run.mode == ExecutionMode::Collaborate => {
                if output.state != OutputState::Committed {
                    active(&run)?;
                }
            }
            _ => return Err(denied()),
        }
        if output.staged.revision != expected_revision {
            return Err(conflict());
        }
        if !matches!(output.state, OutputState::Committed) {
            return Ok(None);
        }
        let result:Option<String>=self.conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE request_id=?1 AND operation IN ('record.create','record.patch','todo.create','todo.update','file.create','file.version.commit') AND state='committed' AND run_id=?2 AND json_extract(output_context_json,'$.outputId')=?3",params![format!("output:{id}:{expected_revision}"),output.staged.run_id,id],|r|r.get(0)).optional().map_err(io_error)?;
        let result = result.ok_or_else(|| {
            AgentError::new(
                ErrorCode::OutputCommitFailed,
                "Committed output has no native operation receipt",
            )
        })?;
        Ok(Some(decode(&result)?))
    }
}

/// Authority for the Todo native callback. The original receipt owns the
/// operation; this resolves only its actual stage/run and frozen grant.
pub(super) fn agent_output_todo_binding(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
) -> AgentResult<(RuntimeOutput, ScopeGrant)> {
    agent_output_native_binding(tx, caller, request_id, operation)
}
pub(super) fn agent_output_native_binding(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
) -> AgentResult<(RuntimeOutput, ScopeGrant)> {
    let (kind, creating) = match operation {
        "todo.create" => ("todo", true),
        "todo.update" => ("todo", false),
        "file.create" => ("file", true),
        "file.version.commit" => ("file", false),
        _ => return Err(denied()),
    };
    let parts: Vec<_> = request_id.split(':').collect();
    if parts.len() != 3 || parts[0] != "output" {
        return Err(invalid("Invalid output commit identity"));
    }
    id_check(parts[1])?;
    let revision = parts[2]
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0 && *v <= i64::MAX as u64 && v.to_string() == parts[2])
        .ok_or_else(|| invalid("Invalid output commit revision"))?;
    let output = read_output(tx, parts[1])?;
    if output.staged.revision != revision {
        return Err(conflict());
    }
    if output.dismissed || output.state != OutputState::Committing {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Output has not been prepared or already settled",
        ));
    }
    let run = read_run(tx, &output.staged.run_id)?;
    writable(&run)?;
    if !(caller == "gui"
        && (run.mode == ExecutionMode::Review
            || run.mode == ExecutionMode::Collaborate && run.state.is_terminal())
        || caller == format!("run:{}", output.staged.run_id)
            && run.mode == ExecutionMode::Collaborate
            && matches!(run.state, RunState::Running | RunState::Cancelling))
    {
        return Err(denied());
    }
    let (scope, permission, intent, _, _) = intent_scope(&output.staged.intent)?;
    if scope != run.scope
        || output_kind(&output.staged.intent)? != kind
        || creating != (intent == "create")
    {
        return Err(denied());
    }
    let binding = WorkspaceBinding {
        workspace_id: run.grant.workspace_id.clone(),
        generation: String::new(),
    };
    let captured = RequestContext {
        binding: binding.clone(),
        scope_grant: run.grant.clone(),
        caller: Caller::Gui,
        request_id: request_id.into(),
    };
    captured.authorize(&binding, &scope, "output.commit")?;
    captured.authorize(&binding, &scope, permission)?;
    Ok((output, run.grant))
}

/// Settle abandoned saves in the same writer transaction as terminal run state.
/// A native commit that won the writer reservation already has `committed` state.
pub(super) fn agent_output_settle_interrupted(
    tx: &Transaction<'_>,
    run_id: &str,
    code: ErrorCode,
) -> AgentResult<()> {
    let code = serde_json::to_value(code).map_err(|_| damaged())?;
    let code = code.as_str().ok_or_else(damaged)?;
    tx.execute("UPDATE agent_outputs SET state='failed',payload_json=json_set(payload_json,'$.errorCode',?2) WHERE run_id=?1 AND state='committing'", params![run_id, code]).map_err(io_error)?;
    Ok(())
}

/// Called after the original native receipt INSERT, before its outbox and commit.
/// Errors roll back the Record mutation, receipt, and staging transition together.
pub(crate) fn agent_output_record_committed(
    tx: &Transaction<'_>,
    caller: &str,
    request_id: &str,
    operation: &str,
    result_json: &str,
) -> AgentResult<()> {
    if !matches!(operation, "record.create" | "record.patch") || !request_id.starts_with("output:")
    {
        return Ok(());
    }
    let parts: Vec<_> = request_id.split(':').collect();
    if parts.len() != 3 {
        return Err(invalid("Invalid output commit identity"));
    }
    id_check(parts[1])?;
    let revision = parts[2]
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0 && *v <= i64::MAX as u64 && v.to_string() == parts[2])
        .ok_or_else(|| invalid("Invalid output commit revision"))?;
    let output = read_output(tx, parts[1])?;
    if output.staged.revision != revision {
        return Err(conflict());
    }
    if output.dismissed || !matches!(output.state, OutputState::Committing) {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Output has not been prepared or already settled",
        ));
    }
    let run = read_run(tx, &output.staged.run_id)?;
    writable(&run)?;
    if !(caller == "gui"
        && (run.mode == ExecutionMode::Review
            || run.mode == ExecutionMode::Collaborate && run.state.is_terminal())
        || caller == format!("run:{}", output.staged.run_id)
            && run.mode == ExecutionMode::Collaborate
            && matches!(run.state, RunState::Running | RunState::Cancelling))
    {
        return Err(denied());
    }
    let (scope, permission, intent, target, base) = intent_scope(&output.staged.intent)?;
    if scope != run.scope
        || output_kind(&output.staged.intent)? != "record"
        || (operation == "record.create") != (intent == "create")
    {
        return Err(denied());
    }
    let frozen_context = RequestContext {
        binding: WorkspaceBinding {
            workspace_id: run.grant.workspace_id.clone(),
            generation: String::new(),
        },
        scope_grant: run.grant.clone(),
        caller: Caller::Gui,
        request_id: request_id.into(),
    };
    frozen_context.authorize(&frozen_context.binding, &scope, "output.commit")?;
    frozen_context.authorize(&frozen_context.binding, &scope, permission)?;
    let (head, before_revision, before_snapshot, after_snapshot, operation_id, undo) =
        if operation == "record.patch" {
            let result: RecordPatchResult = decode(result_json)?;
            if result.receipt.request_id != request_id
                || Some(result.before_revision) != base
                || Some(&result.receipt.object) != target
                || result.after_revision != result.head.head_revision
            {
                return Err(denied());
            }
            id_check(&result.receipt.operation_id)?;
            (
                result.head,
                Some(result.before_revision),
                Some(result.before_version.clone()),
                result.after_version.or(Some(result.before_version)),
                result.receipt.operation_id,
                if result.receipt.undo_available && !result.no_change {
                    "available"
                } else {
                    "unavailable"
                },
            )
        } else {
            let head: RecordCommittedHead = decode(result_json)?;
            (head, None, None, None, random_id(), "available")
        };
    if head.target.scope != scope {
        return Err(denied());
    }
    let object = ObjectRef {
        workspace_id: run.grant.workspace_id.clone(),
        scope: head.target.scope.clone(),
        kind: ObjectKind::Record,
        id: head.target.record_id.to_string(),
    };
    object.key()?;
    if target.is_some_and(|target| target != &object) {
        return Err(denied());
    }
    let actual: (i64, String) = tx
        .query_row(
            "SELECT head_revision,body_hash FROM record_document_heads WHERE record_key=?1",
            [head.target.key()?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(io_error)?;
    if actual != (head.head_revision as i64, head.body_hash.clone()) {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Native Record result differs from committed head",
        ));
    }
    let after_snapshot=match after_snapshot {Some(version)=>Some(version),None=>tx.query_row("SELECT id FROM record_versions WHERE record_key=?1 AND head_revision=?2 AND body_hash=?3 ORDER BY version_number DESC LIMIT 1",params![head.target.key()?,head.head_revision as i64,head.body_hash],|r|r.get::<_,String>(0)).optional().map_err(io_error)?};
    if after_snapshot.is_none() {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Native Record snapshot is missing",
        ));
    }
    let metadata = super::record_documents::metadata(tx, &head.target)?;
    let context = encode(
        &json!({"outputId":output.staged.id,"outputRevision":revision,"mode":run.mode,"sources":output.staged.sources,"sourceChanged":output.source_changed,"afterMetadata":metadata,"afterBodyHash":head.body_hash}),
    )?;
    if context.len() > 256 * 1024 {
        return Err(invalid("Output operation context exceeds receipt budget"));
    }
    let updated=tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,run_id=?2,target_ref_json=?3,before_revision=?4,after_revision=?5,before_snapshot_ref=?6,after_snapshot_ref=?7,output_context_json=?8,undo_state=?9 WHERE caller_id=?10 AND request_id=?11 AND operation=?12 AND state='committed' AND result_json=?13",params![operation_id,output.staged.run_id,encode(&object)?,before_revision.map(|v| v as i64),head.head_revision as i64,before_snapshot,after_snapshot,context,undo,caller,request_id,operation,result_json]).map_err(io_error)?;
    if updated != 1 {
        return Err(AgentError::new(
            ErrorCode::OutputCommitFailed,
            "Native Record operation receipt is missing",
        ));
    }
    let updated=tx.execute("UPDATE agent_outputs SET state='committed',object_ref_json=?1 WHERE id=?2 AND revision=?3 AND state='committing'",params![encode(&object)?,output.staged.id,revision as i64]).map_err(io_error)?;
    if updated != 1 {
        return Err(conflict());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::outputs::{BlockEdit, RecordPatch},
        record_documents::{
            body_hash, RecordCreate, RecordDocumentProjection, RecordPatchMetadata,
        },
    };
    const SESSION: &str = "11111111111111111111111111111111";
    const RUN: &str = "22222222222222222222222222222222";
    const BLOCK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    struct Fixture {
        _dir: tempfile::TempDir,
        db: Database,
        binding: WorkspaceBinding,
        builtin: RequestContext,
        gui: RequestContext,
    }
    fn fixture(mode: ExecutionMode) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("app.sqlite"), dir.path(), None).unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "workspace-test".into(),
            generation: "generation".into(),
        };
        let grant = ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: vec![],
            operations: [
                "output.stage",
                "output.read",
                "output.update",
                "output.commit",
                "source.read",
                "content.create",
                "record.patch",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        };
        let builtin = RequestContext {
            binding: binding.clone(),
            scope_grant: grant.clone(),
            caller: Caller::BuiltinRun { run_id: RUN.into() },
            request_id: "stage-1".into(),
        };
        let gui = RequestContext {
            caller: Caller::Gui,
            request_id: "gui-1".into(),
            ..builtin.clone()
        };
        db.conn.execute("INSERT INTO agent_sessions(id,scope_key,title,runtime_id,state,session_path,created_at,updated_at) VALUES (?1,'workspace','fixture','pi','active',?2,'now','now')",params![SESSION,format!(".project-mind/agent/sessions/{SESSION}/session.jsonl")]).unwrap();
        db.conn.execute("INSERT INTO agent_runs(id,session_id,client_request_id,state,context_manifest_json,grant_json,started_at) VALUES (?1,?2,'fixture','running',?3,?4,'now')",params![RUN,SESSION,json!({"scope":Scope::Workspace,"mode":mode}).to_string(),json!({"workspaceId":grant.workspace_id,"workspaceContent":true,"projectIds":[],"operations":grant.operations}).to_string()]).unwrap();
        Fixture {
            _dir: dir,
            db,
            binding,
            builtin,
            gui,
        }
    }
    #[test]
    fn output_dismiss_persists_without_business_writes_and_replays_current_revision() {
        let f = fixture(ExecutionMode::Review);
        let original =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Draft"))
                .unwrap();
        assert!(!original.dismissed);
        // Older payloads have no decision field and remain undecided.
        f.db.conn.execute("UPDATE agent_outputs SET payload_json=json_remove(payload_json,'$.dismissed') WHERE id=?1",[&original.staged.id]).unwrap();
        assert!(
            !f.db
                .agent_output_get(&f.gui, &f.binding, &original.staged.id)
                .unwrap()
                .dismissed
        );
        let outbox = count(&f.db, "agent_change_log");
        assert_eq!(
            f.db.agent_output_dismiss(&f.builtin, &f.binding, &original.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let dismissed =
            f.db.agent_output_dismiss(&f.gui, &f.binding, &original.staged.id, 1)
                .unwrap();
        assert!(dismissed.dismissed);
        assert_eq!(dismissed.staged.revision, 2);
        assert_eq!(dismissed.state, OutputState::Staged);
        assert_eq!(count(&f.db, "workspace_notes"), 0);
        assert_eq!(count(&f.db, "notes"), 0);
        assert_eq!(count(&f.db, "agent_change_log"), outbox);
        let reopened =
            Database::open(&f._dir.path().join("app.sqlite"), f._dir.path(), None).unwrap();
        let replay = reopened
            .agent_output_dismiss(&f.gui, &f.binding, &original.staged.id, 1)
            .unwrap();
        assert!(replay.dismissed);
        assert_eq!(replay.staged.revision, 2);
        let mut update_request = f.gui.clone();
        update_request.request_id = "edit-dismissed".into();
        let updated = reopened
            .agent_output_update(
                &update_request,
                &f.binding,
                &OutputUpdateInput {
                    output_id: original.staged.id.clone(),
                    expected_revision: 2,
                    candidate: candidate("Revised draft"),
                },
            )
            .unwrap();
        assert!(!updated.dismissed);
        assert_eq!(updated.staged.revision, 3);
        let original_request_replay = reopened
            .agent_output_dismiss(&f.gui, &f.binding, &original.staged.id, 1)
            .unwrap();
        assert!(!original_request_replay.dismissed);
        assert_eq!(original_request_replay.staged.revision, 3);
        assert_eq!(count(&reopened, "workspace_notes"), 0);
        assert_eq!(count(&reopened, "agent_change_log"), outbox);
        assert_eq!(
            reopened
                .agent_output_commit_prepare(&f.gui, &f.binding, &original.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            reopened
                .agent_output_commit_prepare(&f.gui, &f.binding, &original.staged.id, 3)
                .unwrap()
                .output
                .state,
            OutputState::Committing
        );
    }
    #[test]
    fn output_dismiss_and_commit_reservation_are_mutually_exclusive() {
        let f = fixture(ExecutionMode::Review);
        let first =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Cancel first"))
                .unwrap();
        let cancelled =
            f.db.agent_output_dismiss(&f.gui, &f.binding, &first.staged.id, 1)
                .unwrap();
        for revision in [1, 2] {
            assert_eq!(
                f.db.agent_output_commit_prepare(&f.gui, &f.binding, &first.staged.id, revision)
                    .unwrap_err()
                    .code,
                ErrorCode::OutputCommitFailed
            );
        }
        assert!(cancelled.dismissed);
        let mut stage_request = f.builtin.clone();
        stage_request.request_id = "stage-confirm-first".into();
        let second =
            f.db.agent_output_stage_record(&stage_request, &f.binding, &candidate("Confirm first"))
                .unwrap();
        let reserved =
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &second.staged.id, 1)
                .unwrap();
        let mut dismiss_request = f.gui.clone();
        dismiss_request.request_id = "cancel-reserved".into();
        assert_eq!(
            f.db.agent_output_dismiss(&dismiss_request, &f.binding, &second.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::OutputCommitFailed
        );
        let p = projection("Body");
        f.db.record_create(
            &f.gui.caller.key(),
            &reserved.commit_request_id,
            &RecordCreate {
                scope: Scope::Workspace,
                title: Some("Confirm first".into()),
                tag_ids: vec![],
                document: p.document.clone(),
                code_language: None,
            },
            &p,
            &f.binding.workspace_id,
        )
        .unwrap();
        let committed =
            f.db.agent_output_get(&f.gui, &f.binding, &second.staged.id)
                .unwrap();
        assert_eq!(committed.state, OutputState::Committed);
        assert!(!committed.dismissed);
        assert_eq!(
            f.db.agent_output_dismiss(&dismiss_request, &f.binding, &second.staged.id, 1)
                .unwrap_err()
                .code,
            ErrorCode::OutputCommitFailed
        );
        assert_eq!(count(&f.db, "workspace_notes"), 1);
        // A failed save can also be dismissed and explicitly edited for retry.
        stage_request.request_id = "stage-failed".into();
        let failed_candidate = f
            .db
            .agent_output_stage_record(&stage_request, &f.binding, &candidate("Retry candidate"))
            .unwrap();
        f.db.agent_output_commit_prepare(&f.gui, &f.binding, &failed_candidate.staged.id, 1)
            .unwrap();
        f.db.agent_output_mark_failed(
            &f.gui,
            &f.binding,
            &failed_candidate.staged.id,
            1,
            ErrorCode::IoFailed,
        )
        .unwrap();
        dismiss_request.request_id = "dismiss-failed".into();
        let failed =
            f.db.agent_output_dismiss(&dismiss_request, &f.binding, &failed_candidate.staged.id, 1)
                .unwrap();
        assert_eq!(failed.state, OutputState::Failed);
        assert!(failed.dismissed);
        dismiss_request.request_id = "edit-failed-dismissed".into();
        let edited =
            f.db.agent_output_update(
                &dismiss_request,
                &f.binding,
                &OutputUpdateInput {
                    output_id: failed_candidate.staged.id.clone(),
                    expected_revision: 2,
                    candidate: candidate("Retry reviewed"),
                },
            )
            .unwrap();
        assert!(!edited.dismissed);
        assert_eq!(edited.staged.revision, 3);
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &failed_candidate.staged.id, 3)
            .is_ok());
    }
    fn candidate(title: &str) -> StageRecordInput {
        StageRecordInput {
            intent: OutputIntent::RecordCreate {
                scope: Scope::Workspace,
                title: title.into(),
                markdown: "Body".into(),
            },
            sources: vec![],
        }
    }
    fn count(db: &Database, table: &str) -> i64 {
        db.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    fn projection(text: &str) -> RecordDocumentProjection {
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":BLOCK},"content":[{"type":"text","text":text}]}]});
        RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: format!("<p data-block-id=\"{BLOCK}\">{text}</p>"),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        }
    }
    fn native_create(f: &Fixture, prepared: &PreparedOutputCommit) -> RecordCommittedHead {
        let p = projection("Body");
        let OutputIntent::RecordCreate { title, .. } = &prepared.output.staged.intent else {
            panic!()
        };
        f.db.record_create(
            &f.builtin.caller.key(),
            &prepared.commit_request_id,
            &RecordCreate {
                scope: Scope::Workspace,
                title: Some(title.clone()),
                tag_ids: vec![],
                document: p.document.clone(),
                code_language: None,
            },
            &p,
            &f.binding.workspace_id,
        )
        .unwrap()
    }
    #[test]
    fn agent_outputs_stage_is_idempotent_bound_and_never_writes_business_content() {
        let f = fixture(ExecutionMode::Collaborate);
        let input = candidate("Candidate");
        assert!(f
            .db
            .agent_output_stage_validate(&f.builtin, &f.binding, &input)
            .unwrap()
            .is_none());
        let before = count(&f.db, "workspace_notes");
        let one =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &input)
                .unwrap();
        let two =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &input)
                .unwrap();
        assert_eq!(one.staged.id, two.staged.id);
        assert_eq!(one.staged.ordinal, 0);
        assert_eq!(count(&f.db, "agent_outputs"), 1);
        assert_eq!(count(&f.db, "workspace_notes"), before);
        assert!(f
            .db
            .agent_output_stage_record(&f.builtin, &f.binding, &candidate("Changed payload"))
            .is_err());
        let mut wrong = f.builtin.clone();
        wrong.caller = Caller::BuiltinRun {
            run_id: "33333333333333333333333333333333".into(),
        };
        assert_eq!(
            f.db.agent_output_get(&wrong, &f.binding, &one.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        wrong = f.builtin.clone();
        wrong.binding.generation = "stale".into();
        assert_eq!(
            f.db.agent_output_get(&wrong, &f.binding, &one.staged.id)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        assert!(f
            .db
            .agent_output_stage_record(&f.gui, &f.binding, &input)
            .is_err());
        f.db.conn
            .execute("UPDATE agent_runs SET state='completed'", [])
            .unwrap();
        assert_eq!(
            f.db.agent_output_stage_validate(&f.builtin, &f.binding, &input)
                .unwrap()
                .unwrap()
                .staged
                .id,
            one.staged.id
        );
        let mut fresh = f.builtin.clone();
        fresh.request_id = "new-stage".into();
        assert!(f
            .db
            .agent_output_stage_record(&fresh, &f.binding, &input)
            .is_err());
    }
    #[test]
    fn agent_outputs_enforces_frozen_mode_grants_and_record_only_contract() {
        let readonly = fixture(ExecutionMode::ReadOnly);
        assert_eq!(
            readonly
                .db
                .agent_output_stage_record(
                    &readonly.builtin,
                    &readonly.binding,
                    &candidate("Denied")
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let f = fixture(ExecutionMode::Review);
        f.db.conn.execute("INSERT INTO agent_scope_settings(scope_key,execution_mode) VALUES ('workspace','read_only')",[]).unwrap();
        let output =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Review"))
                .unwrap();
        assert_eq!(output.mode, ExecutionMode::Review);
        assert!(f
            .db
            .agent_output_commit_prepare(&f.builtin, &f.binding, &output.staged.id, 1)
            .is_err());
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &output.staged.id, 1)
            .is_ok());
        let mut req = f.builtin.clone();
        req.request_id = "file-outside-bound-scope".into();
        let todo = StageRecordInput {
            intent: OutputIntent::FileCreate {
                project_id: 1,
                safe_name: "file.txt".into(),
                utf8_content: "File".into(),
            },
            sources: vec![],
        };
        assert_eq!(
            f.db.agent_output_stage_record(&req, &f.binding, &todo)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.db.conn.execute("UPDATE agent_runs SET grant_json=json_set(grant_json,'$.operations',json('[\"output.stage\"]'))",[]).unwrap();
        req.request_id = "reduced-grant".into();
        assert_eq!(
            f.db.agent_output_stage_record(&req, &f.binding, &candidate("Escalation"))
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut untrusted = serde_json::to_value(candidate("No model grant")).unwrap();
        untrusted["runId"] = json!(RUN);
        assert!(serde_json::from_value::<StageRecordInput>(untrusted).is_err());
    }
    #[test]
    fn agent_outputs_update_is_gui_only_cas_and_pagination_is_snapshot_bound() {
        let f = fixture(ExecutionMode::Review);
        let one =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("First"))
                .unwrap();
        let mut req = f.builtin.clone();
        req.request_id = "stage-2".into();
        f.db.agent_output_stage_record(&req, &f.binding, &candidate("Second"))
            .unwrap();
        let page =
            f.db.agent_output_list(&f.gui, &f.binding, RUN, None, 1)
                .unwrap();
        assert_eq!(page.outputs[0].staged.id, one.staged.id);
        req.request_id = "stage-3".into();
        f.db.agent_output_stage_record(&req, &f.binding, &candidate("Third"))
            .unwrap();
        let next =
            f.db.agent_output_list(&f.gui, &f.binding, RUN, page.next_cursor.as_deref(), 1)
                .unwrap();
        assert_eq!(next.outputs.len(), 1);
        assert!(next.next_cursor.is_none());
        assert!(f
            .db
            .agent_output_list(&f.gui, &f.binding, RUN, page.next_cursor.as_deref(), 2)
            .is_err());
        let update = OutputUpdateInput {
            output_id: one.staged.id.clone(),
            expected_revision: 1,
            candidate: candidate("Edited"),
        };
        assert!(f
            .db
            .agent_output_update(&f.builtin, &f.binding, &update)
            .is_err());
        let revised =
            f.db.agent_output_update(&f.gui, &f.binding, &update)
                .unwrap();
        assert_eq!(revised.staged.revision, 2);
        assert_eq!(
            f.db.agent_output_update(&f.gui, &f.binding, &update)
                .unwrap()
                .staged
                .revision,
            2
        );
        let mut other = f.gui.clone();
        other.request_id = "update-stale".into();
        assert_eq!(
            f.db.agent_output_update(&other, &f.binding, &update)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &one.staged.id, 1)
            .is_err());
        let prepared =
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &one.staged.id, 2)
                .unwrap();
        assert_eq!(
            prepared.commit_request_id,
            format!("output:{}:2", one.staged.id)
        );
        assert_eq!(
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &one.staged.id, 2)
                .unwrap()
                .commit_request_id,
            prepared.commit_request_id
        );
        let mut update = update;
        update.expected_revision = 2;
        assert!(f
            .db
            .agent_output_update(&other, &f.binding, &update)
            .is_err());
    }
    #[test]
    fn agent_outputs_failed_collaborate_requires_explicit_terminal_gui_retry() {
        let f = fixture(ExecutionMode::Collaborate);
        let output =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Retry"))
                .unwrap();
        f.db.agent_output_commit_prepare(&f.builtin, &f.binding, &output.staged.id, 1)
            .unwrap();
        let failed =
            f.db.agent_output_mark_failed(
                &f.builtin,
                &f.binding,
                &output.staged.id,
                1,
                ErrorCode::IoFailed,
            )
            .unwrap();
        assert_eq!(failed.state, OutputState::Failed);
        assert_eq!(failed.error_code, Some(ErrorCode::IoFailed));
        assert!(f
            .db
            .agent_output_commit_prepare(&f.builtin, &f.binding, &output.staged.id, 1)
            .is_err());
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &output.staged.id, 1)
            .is_err());
        f.db.conn
            .execute("UPDATE agent_runs SET state='failed'", [])
            .unwrap();
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &output.staged.id, 2)
            .is_err());
        let retry =
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &output.staged.id, 1)
                .unwrap();
        assert_eq!(retry.output.state, OutputState::Committing);
        assert!(retry.output.error_code.is_none());
    }
    #[test]
    fn agent_outputs_native_create_receipt_survives_session_cascade_and_replays() {
        let f = fixture(ExecutionMode::Collaborate);
        let input = candidate("Creation");
        let output =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &input)
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.builtin, &f.binding, &output.staged.id, 1)
                .unwrap();
        let head = native_create(&f, &prepared);
        let count_after = count(&f.db, "workspace_notes");
        let replay = native_create(&f, &prepared);
        assert_eq!(head.target.key().unwrap(), replay.target.key().unwrap());
        assert_eq!(count(&f.db, "workspace_notes"), count_after);
        let committed =
            f.db.agent_output_get(&f.builtin, &f.binding, &output.staged.id)
                .unwrap();
        assert_eq!(committed.state, OutputState::Committed);
        assert!(committed.object.is_some());
        let context:(String,String,String,String)=f.db.conn.query_row("SELECT operation_id,run_id,after_snapshot_ref,output_context_json FROM agent_operation_receipts WHERE request_id=?1",[&prepared.commit_request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        id_check(&context.0).unwrap();
        assert_eq!(context.1, RUN);
        assert!(!context.2.is_empty());
        let ctx: Value = serde_json::from_str(&context.3).unwrap();
        assert_eq!(ctx["afterBodyHash"], head.body_hash);
        assert_eq!(ctx["afterMetadata"]["title"], "Creation");
        f.db.conn
            .execute("UPDATE agent_runs SET state='completed'", [])
            .unwrap();
        assert_eq!(
            f.db.agent_output_stage_validate(&f.builtin, &f.binding, &input)
                .unwrap()
                .unwrap()
                .state,
            OutputState::Committed
        );
        let receipt =
            f.db.agent_output_record_receipt(&f.builtin, &f.binding, &output.staged.id, 1)
                .unwrap()
                .unwrap();
        assert_eq!(receipt["headRevision"], 1);
        assert!(f
            .db
            .agent_output_commit_prepare(&f.gui, &f.binding, &output.staged.id, 1)
            .is_err());
        f.db.conn
            .execute("DELETE FROM agent_sessions WHERE id=?1", [SESSION])
            .unwrap();
        assert_eq!(count(&f.db, "agent_outputs"), 0);
        let retained: (String, String) =
            f.db.conn
                .query_row(
                    "SELECT run_id,undo_state FROM agent_operation_receipts WHERE operation_id=?1",
                    [context.0],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
        assert_eq!(retained, (RUN.into(), "available".into()));
        assert_eq!(count(&f.db, "workspace_notes"), count_after);
    }
    #[test]
    fn agent_outputs_native_failure_rolls_back_receipt_object_and_stage_transition() {
        let f = fixture(ExecutionMode::Collaborate);
        let output =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Rollback"))
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.builtin, &f.binding, &output.staged.id, 1)
                .unwrap();
        let before = count(&f.db, "workspace_notes");
        f.db.conn.execute_batch("CREATE TEMP TRIGGER reject_output_outbox BEFORE INSERT ON agent_change_log WHEN NEW.operation='record.create' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        let p = projection("Body");
        let input = RecordCreate {
            scope: Scope::Workspace,
            title: Some("Rollback".into()),
            tag_ids: vec![],
            document: p.document.clone(),
            code_language: None,
        };
        assert!(f
            .db
            .record_create(
                &f.builtin.caller.key(),
                &prepared.commit_request_id,
                &input,
                &p,
                &f.binding.workspace_id
            )
            .is_err());
        assert_eq!(count(&f.db, "workspace_notes"), before);
        assert_eq!(
            f.db.agent_output_get(&f.builtin, &f.binding, &output.staged.id)
                .unwrap()
                .state,
            OutputState::Committing
        );
        let native_receipts: i64 =
            f.db.conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_operation_receipts WHERE request_id=?1",
                    [&prepared.commit_request_id],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(native_receipts, 0);
        f.db.conn
            .execute_batch("DROP TRIGGER reject_output_outbox")
            .unwrap();
        native_create(&f, &prepared);
    }
    #[test]
    fn agent_outputs_terminal_settlement_fails_only_abandoned_saves() {
        let f = fixture(ExecutionMode::Collaborate);
        let committed =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Committed"))
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.builtin, &f.binding, &committed.staged.id, 1)
                .unwrap();
        native_create(&f, &prepared);
        let mut req = f.builtin.clone();
        req.request_id = "pending-cancel".into();
        let pending =
            f.db.agent_output_stage_record(&req, &f.binding, &candidate("Pending"))
                .unwrap();
        f.db.agent_output_commit_prepare(&req, &f.binding, &pending.staged.id, 1)
            .unwrap();
        req.request_id = "untouched-stage".into();
        let staged =
            f.db.agent_output_stage_record(&req, &f.binding, &candidate("Staged"))
                .unwrap();
        req.scope_grant
            .operations
            .extend(["run.start".into(), "run.cancel".into()]);
        f.db.agent_run_mark_cancelling(&req, &f.binding, RUN)
            .unwrap();
        f.db.agent_run_settle(
            &req,
            &f.binding,
            RUN,
            &crate::agent::conversation::RunSettlement {
                state: RunState::Cancelled,
                runtime_settled: true,
                projection: None,
                usage: None,
                error_code: Some(ErrorCode::Cancelled),
            },
        )
        .unwrap();
        let failed =
            f.db.agent_output_get(&f.gui, &f.binding, &pending.staged.id)
                .unwrap();
        assert_eq!(failed.state, OutputState::Failed);
        assert_eq!(failed.error_code, Some(ErrorCode::Cancelled));
        assert_eq!(
            f.db.agent_output_get(&f.gui, &f.binding, &committed.staged.id)
                .unwrap()
                .state,
            OutputState::Committed
        );
        assert_eq!(
            f.db.agent_output_get(&f.gui, &f.binding, &staged.staged.id)
                .unwrap()
                .state,
            OutputState::Staged
        );
        assert!(f
            .db
            .agent_output_commit_prepare(&req, &f.binding, &pending.staged.id, 1)
            .is_err());
        assert_eq!(
            f.db.agent_output_commit_prepare(&f.gui, &f.binding, &pending.staged.id, 1)
                .unwrap()
                .output
                .state,
            OutputState::Committing
        );
    }
    #[test]
    fn agent_outputs_patch_uses_target_cas_and_original_native_versions() {
        let f = fixture(ExecutionMode::Collaborate);
        let created =
            f.db.agent_output_stage_record(&f.builtin, &f.binding, &candidate("Patch target"))
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&f.builtin, &f.binding, &created.staged.id, 1)
                .unwrap();
        let head = native_create(&f, &prepared);
        let object =
            f.db.agent_output_get(&f.builtin, &f.binding, &created.staged.id)
                .unwrap()
                .object
                .unwrap();
        let stored = f.db.record_document_head(&head.target).unwrap().unwrap();
        let block_hash =
            crate::record_documents::record_block_hash(&stored.projection.document["content"][0])
                .unwrap();
        let patch = RecordPatch {
            record: object,
            base_revision: 1,
            request_id: "model-request".into(),
            operations: vec![BlockEdit::AppendInline {
                block_id: BLOCK.into(),
                expected_block_hash: block_hash,
                text: " revised".into(),
            }],
        };
        let input = StageRecordInput {
            intent: OutputIntent::RecordPatch {
                patch: patch.clone(),
            },
            sources: vec![],
        };
        let mut req = f.builtin.clone();
        req.request_id = "stage-patch".into();
        let staged =
            f.db.agent_output_stage_record(&req, &f.binding, &input)
                .unwrap();
        let prepared =
            f.db.agent_output_commit_prepare(&req, &f.binding, &staged.staged.id, 1)
                .unwrap();
        let OutputIntent::RecordPatch { patch } = &prepared.output.staged.intent else {
            panic!()
        };
        assert_eq!(patch.request_id, prepared.commit_request_id);
        let result =
            f.db.record_patch_commit(
                &req.caller.key(),
                patch,
                &projection("Body revised"),
                &RecordPatchMetadata {
                    created_block_ids: vec![],
                    deleted_block_ids: vec![],
                    normalizations: vec![],
                    no_change: false,
                },
                &f.binding.workspace_id,
            )
            .unwrap();
        assert_eq!(result.before_revision, head.head_revision);
        assert_eq!(result.after_revision, 2);
        let refs:(String,String,String,String)=f.db.conn.query_row("SELECT operation_id,before_snapshot_ref,after_snapshot_ref,undo_state FROM agent_operation_receipts WHERE request_id=?1",[&prepared.commit_request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(refs.0, result.receipt.operation_id);
        assert_eq!(refs.1, result.before_version);
        assert_eq!(Some(refs.2), result.after_version);
        assert_eq!(refs.3, "available");
        // Historical source versions remain valid evidence and retain their
        // original selection; a changed source is reported without rebasing.
        let object = input.intent.clone();
        let OutputIntent::RecordPatch { patch } = object else {
            panic!()
        };
        let fingerprint =
            f.db.source_record_fingerprint(
                &req,
                &f.binding,
                &crate::source_service::SourceReadTarget {
                    object: patch.record.clone(),
                    revision: None,
                    record_version: Some(1),
                    file_version: None,
                },
            )
            .unwrap();
        let reference = SourceRef {
            object: patch.record,
            revision: fingerprint.revision,
            file_version: None,
            record_version: Some(1),
            block_id: Some(BLOCK.into()),
            locator: None,
            title: "Historical evidence".into(),
            excerpt: "Body".into(),
        };
        let mut cited = candidate("Cited candidate");
        cited.sources.push(reference);
        req.request_id = "stage-historical-evidence".into();
        let evidence =
            f.db.agent_output_stage_record(&req, &f.binding, &cited)
                .unwrap();
        assert_eq!(evidence.source_changed, vec![true]);
        assert_eq!(evidence.staged.sources[0].record_version, Some(1));
        cited.sources[0].record_version = Some(999999);
        req.request_id = "missing-source-version".into();
        assert!(f
            .db
            .agent_output_stage_record(&req, &f.binding, &cited)
            .is_err());
        req.request_id = "stale-target".into();
        assert_eq!(
            f.db.agent_output_stage_record(&req, &f.binding, &input)
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
    }
}
