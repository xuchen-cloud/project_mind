//! Location routing is storage fact, never authority. Payload history stays immutable.
use super::{
    agent_operations::{io_error, parse_scope_key},
    Database,
};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    record_documents::RecordTarget,
    record_owner_moves::*,
};
use rusqlite::{params, Connection, OptionalExtension};

fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn missing() -> AgentError {
    AgentError::new(ErrorCode::NotFound, "Record is no longer present")
}
fn installed(conn: &Connection) -> AgentResult<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_location_aliases')",[],|r|r.get(0)).map_err(io_error)
}
fn actual(conn: &Connection, target: &RecordTarget) -> AgentResult<RecordTarget> {
    let scope = match target.scope {
        Scope::Workspace => conn
            .query_row(
                "SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'",
                [target.record_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional(),
        Scope::Project { .. } => conn
            .query_row(
                "SELECT project_id FROM notes WHERE id=?1",
                [target.record_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional(),
    }
    .map_err(io_error)?
    .ok_or_else(missing)?;
    Ok(RecordTarget {
        scope: scope.map_or(Scope::Workspace, |project_id| Scope::Project { project_id }),
        record_id: target.record_id,
    })
}
fn location_row(
    conn: &Connection,
    sql: &str,
    a: &str,
    b: Option<i64>,
) -> AgentResult<Option<RecordLocation>> {
    let row = if let Some(id) = b {
        conn.query_row(sql, params![a, id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .optional()
    } else {
        conn.query_row(sql, [a], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .optional()
    }
    .map_err(io_error)?;
    row.map(|(id, scope, n)| {
        let target = RecordTarget {
            scope: parse_scope_key(&scope)?,
            record_id: n,
        };
        let current = actual(conn, &target)?;
        if current.key()? != target.key()? {
            return Err(missing());
        }
        Ok(RecordLocation {
            logical_id: Some(id),
            target,
        })
    })
    .transpose()
}
pub(super) fn resolve_location(
    conn: &Connection,
    target: &RecordTarget,
) -> AgentResult<RecordLocation> {
    let key = target.key()?;
    // Published schema 40 remains readable before integration installs the extension.
    if installed(conn)? {
        if let Some(found)=location_row(conn,"SELECT i.logical_id,i.scope_key,i.record_id FROM record_location_aliases a JOIN record_logical_identities i USING(logical_id) WHERE a.location_key=?1",&key,None)? {return Ok(found);}
    }
    let current = actual(conn, target)?;
    if current.key()? != key {
        return Err(AgentError::new(
            ErrorCode::ScopeDenied,
            "Record locator does not match its owner",
        ));
    }
    Ok(RecordLocation {
        logical_id: None,
        target: current,
    })
}
pub(super) fn resolve_object(conn: &Connection, object: &ObjectRef) -> AgentResult<ObjectRef> {
    if object.kind == ObjectKind::Transcript {
        return resolve_transcript(conn, object);
    }
    if object.kind != ObjectKind::Record {
        return Ok(object.clone());
    }
    let id = object
        .id
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == object.id)
        .ok_or_else(|| invalid("Invalid Record identity"))?;
    let location = resolve_location(
        conn,
        &RecordTarget {
            scope: object.scope.clone(),
            record_id: id,
        },
    )?;
    Ok(ObjectRef {
        scope: location.target.scope,
        id: location.target.record_id.to_string(),
        ..object.clone()
    })
}
/// Transcript IDs stay attached to VoiceRecord while its owning Record relocates.
/// Only scopes recorded for that logical Record qualify as historical locators.
fn resolve_transcript(conn: &Connection, object: &ObjectRef) -> AgentResult<ObjectRef> {
    let id = object
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == object.id)
        .ok_or_else(|| invalid("Invalid Transcript identity"))?;
    let (project_id, project_note, workspace_note): (Option<i64>, Option<i64>, Option<i64>) = conn.query_row(
        "SELECT n.project_id,n.id,w.id FROM voice_records v LEFT JOIN notes n ON n.id=v.project_note_id LEFT JOIN workspace_notes w ON w.id=v.workspace_note_id AND w.note_kind='workspace_note' WHERE v.id=?1 AND (n.id IS NOT NULL OR w.id IS NOT NULL)",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(io_error)?.ok_or_else(missing)?;
    let target = RecordTarget {
        scope: project_id.map_or(Scope::Workspace, |project_id| Scope::Project { project_id }),
        record_id: project_note.or(workspace_note).ok_or_else(missing)?,
    };
    if object.scope != target.scope {
        let known = installed(conn)? && conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM record_location_aliases a JOIN record_logical_identities i USING(logical_id) WHERE i.current_key=?1 AND a.location_key=?2||':'||a.record_id)",
            params![target.key()?,object.scope.key()], |r|r.get::<_,bool>(0)).map_err(io_error)?;
        if !known {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Transcript locator does not match its owner history",
            ));
        }
    }
    Ok(ObjectRef {
        scope: target.scope,
        ..object.clone()
    })
}

pub(super) fn record_alias_from_scope(
    conn: &Connection,
    kind: &str,
    id: i64,
    scope: &Scope,
) -> AgentResult<bool> {
    if !installed(conn)? {
        return Ok(false);
    }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM record_location_aliases token JOIN record_location_aliases owner USING(logical_id) WHERE token.reference_kind=?1 AND token.record_id=?2 AND owner.location_key=?3||':'||owner.record_id)",
        params![kind,id,scope.key()],|r|r.get(0)).map_err(io_error)
}

pub(super) fn resolve_legacy(
    conn: &Connection,
    kind: &str,
    id: i64,
) -> AgentResult<Option<RecordTarget>> {
    if installed(conn)? {
        if let Some(found)=location_row(conn,"SELECT i.logical_id,i.scope_key,i.record_id FROM record_location_aliases a JOIN record_logical_identities i USING(logical_id) WHERE a.reference_kind=?1 AND a.record_id=?2",kind,Some(id))? {return Ok(Some(found.target));}
    }
    let result = match kind {
        "note" => conn
            .query_row("SELECT project_id FROM notes WHERE id=?1", [id], |r| {
                Ok(Scope::Project {
                    project_id: r.get(0)?,
                })
            })
            .optional(),
        "workspace_record" => conn
            .query_row(
                "SELECT 1 FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'",
                [id],
                |_| Ok(Scope::Workspace),
            )
            .optional(),
        _ => return Err(invalid("Invalid Record reference namespace")),
    }
    .map_err(io_error)?;
    Ok(result.map(|scope| RecordTarget {
        scope,
        record_id: id,
    }))
}
impl Database {
    /// Called once from integration's unified versioned migration; no global number here.
    pub(crate) fn ensure_record_owner_moves_schema(&mut self) -> anyhow::Result<()> {
        if installed(&self.conn).map_err(|e| anyhow::anyhow!(e.message))? {
            return Ok(());
        }
        let tx = self.conn.savepoint()?;
        tx.execute_batch(include_str!("record_owner_moves.sql"))?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn record_resolve_location(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<RecordLocation> {
        resolve_location(&self.conn, target)
    }
    pub(crate) fn record_require_current_location(&self, target: &RecordTarget) -> AgentResult<()> {
        let actual = self.record_resolve_location(target)?;
        if actual.target.key()? != target.key()? {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Record has moved; reopen it at its current location",
            )
            .with_details(
                serde_json::json!({"target":actual.target,"logicalId":actual.logical_id}),
            ));
        }
        Ok(())
    }
}

use crate::record_documents::{RecordDocumentProjection, RecordVersionOrigin};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const OP: &str = "record.owner.move";
fn conflict(message: &str) -> AgentError {
    AgentError::new(ErrorCode::RevisionConflict, message)
}
fn project(scope: &Scope) -> Option<i64> {
    match scope {
        Scope::Workspace => None,
        Scope::Project { project_id } => Some(*project_id),
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct MoveTag {
    source: i64,
    target: i64,
    label: String,
    color: String,
    create: bool,
}
#[derive(Debug, Clone)]
pub(crate) struct PreparedRecordOwnerMove {
    pub tags: Vec<MoveTag>,
    pub document: Value,
    pub needs_projection: bool,
    pub code_language: Option<String>,
}
fn remap_tags(node: &mut Value, tags: &BTreeMap<i64, i64>) -> AgentResult<bool> {
    let mut changed = false;
    if node.get("type").and_then(Value::as_str) == Some("tagMention") {
        let id = node
            .pointer("/attrs/tagId")
            .and_then(crate::record_documents::positive_object_id)
            .ok_or_else(|| invalid("Invalid Tag mention"))? as i64;
        let target = tags.get(&id).ok_or_else(|| {
            AgentError::new(
                ErrorCode::ScopeDenied,
                "Tag mention is outside the source scope",
            )
        })?;
        if *target != id {
            node["attrs"]["tagId"] = json!(target);
            changed = true;
        }
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            changed |= remap_tags(child, tags)?;
        }
    }
    Ok(changed)
}
fn mention_ids(node: &Value, ids: &mut BTreeSet<i64>) {
    if node.get("type").and_then(Value::as_str) == Some("tagMention") {
        if let Some(id) = node
            .pointer("/attrs/tagId")
            .and_then(crate::record_documents::positive_object_id)
        {
            ids.insert(id as i64);
        }
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            mention_ids(child, ids);
        }
    }
}
impl Database {
    fn authorize_record_move(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<RecordLocation> {
        self.operation_binding(binding)?;
        if request.binding != *binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Workspace binding is no longer current",
            ));
        }
        let location = self.record_resolve_location(&input.source)?;
        request.authorize(binding, &location.target.scope, "record.move")?;
        request.require_object_allowed(&ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: location.target.scope.clone(),
            kind: ObjectKind::Record,
            id: location.target.record_id.to_string(),
        })?;
        request.authorize(binding, &input.destination, "record.move")?;
        input.destination.validate()?;
        Ok(location)
    }
    /// Admission probes only existence/payload equality after source-window origin
    /// validation. The result itself is returned solely by authorized canonical replay.
    pub(crate) fn record_owner_move_gui_receipt_exists(
        &self,
        binding: &WorkspaceBinding,
        request_id: &str,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<bool> {
        self.operation_binding(binding)?;
        self.agent_operation_replay::<RecordOwnerMoveResult>(
            &crate::agent::access::Caller::Gui.key(),
            request_id,
            OP,
            &json!({"binding":binding,"input":input}),
        )
        .map(|receipt| receipt.is_some())
    }
    pub(crate) fn record_owner_move_replay(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<Option<RecordOwnerMoveResult>> {
        self.authorize_record_move(request, binding, input)?;
        self.agent_operation_replay(
            &request.caller.key(),
            &request.request_id,
            OP,
            &json!({"binding":binding,"input":input}),
        )
    }
    pub(crate) fn record_owner_move_prepare(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<PreparedRecordOwnerMove> {
        let location = self.authorize_record_move(request, binding, input)?;
        if location.target.key()? != input.source.key()? {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Record has moved; reopen it at its current location",
            )
            .with_details(json!({"target":location.target,"logicalId":location.logical_id})));
        }
        if input.source.scope == input.destination {
            return Err(invalid("Record is already at this location"));
        }
        self.source_live_scope(&input.destination)?;
        super::agent_record_withdrawals::require_record_visible(&self.conn, &input.source)?;
        let head = self.record_document_head(&input.source)?.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Initialize and save the Record before moving it",
            )
        })?;
        let metadata = self.record_metadata_get(&input.source)?;
        if input.head_revision != head.head_revision
            || input.body_hash != head.projection.body_hash
            || input.metadata_revision != metadata.revision
        {
            return Err(conflict("Record changed; save and reload its current baseline before moving").with_details(json!({"headRevision":head.head_revision,"bodyHash":head.projection.body_hash,"metadataRevision":metadata.revision})));
        }
        let active:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM voice_records v JOIN recording_sessions s ON s.voice_record_id=v.id WHERE ((?1 AND v.workspace_note_id=?2) OR (NOT ?1 AND v.project_note_id=?2)) AND s.lifecycle!='ended')",params![matches!(input.source.scope,Scope::Workspace),input.source.record_id],|r|r.get(0)).map_err(io_error)?;
        if active {
            return Err(AgentError::new(
                ErrorCode::RunBusy,
                "请先结束此语音记录的录音，再移动记录",
            ));
        }
        let mut ids: BTreeSet<_> = metadata.tag_ids.into_iter().collect();
        mention_ids(&head.projection.document, &mut ids);
        let mut next:i64=self.conn.query_row("SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name='file_tag_options'),0),coalesce((SELECT max(id) FROM file_tag_options),0))",[],|r|r.get(0)).map_err(io_error)?;
        let mut tags = Vec::new();
        for id in ids {
            let (label, color): (String, String) = self
                .conn
                .query_row(
                    "SELECT label,color_key FROM file_tag_options WHERE id=?1 AND project_id IS ?2",
                    params![id, project(&input.source.scope)],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(io_error)?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::ScopeDenied,
                        "Record Tag is outside its source scope",
                    )
                })?;
            let found:Option<(i64,String)>=self.conn.query_row("SELECT id,color_key FROM file_tag_options WHERE project_id IS ?1 AND label=?2 COLLATE NOCASE",params![project(&input.destination),label],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(io_error)?;
            let (target, create) = match found {
                Some((target, target_color)) => {
                    if target_color != color {
                        return Err(conflict(
                            "目标位置存在同名但颜色不同的 Tag，请先统一 Tag 定义",
                        )
                        .with_details(
                            json!({"label":label,"sourceColor":color,"targetColor":target_color}),
                        ));
                    }
                    (target, false)
                }
                None => {
                    next = next
                        .checked_add(1)
                        .ok_or_else(|| invalid("Tag identity exhausted"))?;
                    (next, true)
                }
            };
            tags.push(MoveTag {
                source: id,
                target,
                label,
                color,
                create,
            });
        }
        let map = tags.iter().map(|tag| (tag.source, tag.target)).collect();
        let mut document = head.projection.document.clone();
        let needs_projection = remap_tags(&mut document, &map)?;
        Ok(PreparedRecordOwnerMove {
            tags,
            document,
            needs_projection,
            code_language: head.projection.code_language,
        })
    }
    #[cfg(test)]
    pub(crate) fn record_owner_move(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordOwnerMoveInput,
    ) -> AgentResult<RecordOwnerMoveResult> {
        if let Some(replay) = self.record_owner_move_replay(request, binding, input)? {
            return Ok(replay);
        }
        let plan = self.record_owner_move_prepare(request, binding, input)?;
        self.record_owner_move_commit(request, binding, input, &plan, None)
    }
    pub(crate) fn record_owner_move_commit(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordOwnerMoveInput,
        plan: &PreparedRecordOwnerMove,
        projection: Option<&RecordDocumentProjection>,
    ) -> AgentResult<RecordOwnerMoveResult> {
        if !installed(&self.conn)? {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "Record owner-move schema is not installed",
            ));
        }
        self.authorize_record_move(request, binding, input)?;
        let mut owners = BTreeSet::new();
        owners.insert(project(&input.source.scope));
        owners.insert(project(&input.destination));
        let _owners = owners
            .into_iter()
            .map(|owner| self.file_project_lock(owner, false))
            .collect::<anyhow::Result<Vec<_>>>()
            .map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot acquire Record owner leases")
            })?;
        // No File bytes change and no File lease is needed. Never run recovery here.
        let _permit = self.file_commit_permit()?;
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,OP,&json!({"binding":binding,"input":input}),|tx| {
   let checked=self.record_owner_move_prepare(request,binding,input)?;
   if checked.tags!=plan.tags || checked.document!=plan.document {return Err(conflict("Tag definitions changed while preparing this move"));}
   let mut head=super::record_documents::head_unchecked(tx,&input.source)?.ok_or_else(missing)?;
   let meta=super::record_documents::metadata(tx,&input.source)?;
   let operation_id=format!("{:032x}",rand::random::<u128>());
   let now=chrono::Utc::now().to_rfc3339();
   for tag in &plan.tags {if tag.create {tx.execute("INSERT INTO file_tag_options(id,project_id,label,color_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![tag.target,project(&input.destination),tag.label,tag.color,now]).map_err(io_error)?;}}
   let logical_id=self.record_resolve_location(&input.source)?.logical_id.unwrap_or_else(||format!("{:032x}",rand::random::<u128>()));
   tx.execute("INSERT OR IGNORE INTO record_logical_identities(logical_id,current_key,scope_key,record_id) VALUES(?1,?2,?3,?4)",params![logical_id,input.source.key()?,input.source.scope.key(),input.source.record_id]).map_err(io_error)?;
   tx.execute("INSERT OR IGNORE INTO record_location_aliases VALUES(?1,?2,?3,?4)",params![input.source.key()?,if matches!(input.source.scope,Scope::Workspace){"workspace_record"}else{"note"},input.source.record_id,logical_id]).map_err(io_error)?;
   // Preserve the current committed body too, including a pending manual checkpoint.
   super::record_documents::snapshot(tx,&head,&meta.title,&RecordVersionOrigin::Manual,&json!({"kind":"gui","caller":request.caller.key()}),&operation_id,None)?;
   let mut paths:Vec<String>=tx.prepare("SELECT DISTINCT a.asset_ref FROM record_version_assets a JOIN record_versions v ON v.id=a.version_id WHERE v.record_key=?1").map_err(io_error)?.query_map([input.source.key()?],|r|r.get(0)).map_err(io_error)?.collect::<Result<_,_>>().map_err(io_error)?;
   paths.extend(head.projection.validate()?);paths.sort();paths.dedup();
   for path in paths {tx.execute("INSERT OR IGNORE INTO record_owner_move_assets VALUES(?1,?2,?3)",params![logical_id,path,input.source.scope.key()]).map_err(io_error)?;}
   let source_table=if matches!(input.source.scope,Scope::Workspace){"workspace_notes"}else{"notes"};
   let sql=match input.destination {Scope::Workspace=>format!("INSERT INTO workspace_notes(note_kind,title,content_markdown,content_html,default_code_language,created_at,updated_at) SELECT 'workspace_note',title,content_markdown,content_html,default_code_language,created_at,updated_at FROM {source_table} WHERE id=?1"),Scope::Project{..}=>format!("INSERT INTO notes(project_id,title,content_markdown,content_html,default_code_language,created_at,updated_at) SELECT ?2,title,content_markdown,content_html,default_code_language,created_at,updated_at FROM {source_table} WHERE id=?1")};
   if matches!(input.destination,Scope::Workspace) {tx.execute(&sql,params![input.source.record_id])}else{tx.execute(&sql,params![input.source.record_id,project(&input.destination)])}.map_err(io_error)?;
   let target=RecordTarget{scope:input.destination.clone(),record_id:tx.last_insert_rowid()};
   // Rekey indexes under deferred FK checking; version payloads and UUIDs are untouched.
   tx.execute_batch("PRAGMA defer_foreign_keys=ON;").map_err(io_error)?;
   tx.execute("UPDATE record_document_heads SET record_key=?1,project_note_id=?2,workspace_note_id=?3,edit_session_id=NULL,edit_started_at=NULL,checkpoint_due_at=NULL WHERE record_key=?4",params![target.key()?,project(&target.scope).map(|_|target.record_id),if matches!(target.scope,Scope::Workspace){Some(target.record_id)}else{None},input.source.key()?]).map_err(io_error)?;
   tx.execute("UPDATE record_versions SET record_key=?1 WHERE record_key=?2",params![target.key()?,input.source.key()?]).map_err(io_error)?;
   tx.execute("UPDATE record_logical_identities SET scope_key=?1,record_id=?2 WHERE logical_id=?3",params![target.scope.key(),target.record_id,logical_id]).map_err(io_error)?;
   tx.execute("INSERT INTO record_location_aliases VALUES(?1,?2,?3,?4)",params![target.key()?,if matches!(target.scope,Scope::Workspace){"workspace_record"}else{"note"},target.record_id,logical_id]).map_err(io_error)?;
   tx.execute("UPDATE voice_records SET project_note_id=?1,workspace_note_id=?2 WHERE project_note_id IS ?3 AND workspace_note_id IS ?4",params![project(&target.scope).map(|_|target.record_id),if matches!(target.scope,Scope::Workspace){Some(target.record_id)}else{None},project(&input.source.scope).map(|_|input.source.record_id),if matches!(input.source.scope,Scope::Workspace){Some(input.source.record_id)}else{None}]).map_err(io_error)?;
   let (links,column)=if matches!(target.scope,Scope::Workspace){("workspace_note_tag_links","workspace_note_id")}else{("note_tag_links","note_id")};
   for id in &meta.tag_ids {let tag=plan.tags.iter().find(|tag|tag.source==*id).ok_or_else(||invalid("Missing Tag mapping"))?;tx.execute(&format!("INSERT INTO {links}({column},tag_id,created_at) VALUES(?1,?2,?3)"),params![target.record_id,tag.target,now]).map_err(io_error)?;}
   head.target=target.clone();head.edit_session_id=None;head.checkpoint_due_at=None;
   if plan.needs_projection {
    let converted=projection.ok_or_else(||AgentError::new(ErrorCode::SourceNotReady,"Current Tag mentions need canonical conversion before moving"))?;
    converted.validate()?;
    if converted.document!=plan.document || converted.code_language!=plan.code_language {return Err(invalid("Canonical Tag mapping differs from the prepared move"));}
    head.head_revision=head.head_revision.checked_add(1).filter(|v|*v<=i64::MAX as u64).ok_or_else(||invalid("Record revision exhausted"))?;
    head.projection=converted.clone();
    tx.execute("UPDATE record_document_heads SET head_revision=?1,document_json=?2,html=?3,markdown=?4,text=?5,body_hash=?6,schema_version=?7,code_language=?8,updated_at=?9 WHERE record_key=?10",params![head.head_revision as i64,converted.document.to_string(),converted.html,converted.markdown,converted.text,converted.body_hash,converted.schema_version,converted.code_language,now,target.key()?]).map_err(io_error)?;
    super::record_documents::snapshot(tx,&head,&meta.title,&RecordVersionOrigin::Manual,&json!({"kind":"gui","caller":request.caller.key(),"operation":"record.owner.move"}),&operation_id,None)?;
   }
   super::record_references::validate_move_references(tx,&target.scope,&head.projection.document,&binding.workspace_id)?;
   let old_key=input.source.object_key(&binding.workspace_id)?;let new_key=target.object_key(&binding.workspace_id)?;
   tx.execute("UPDATE content_reference_edges SET source_object_key=?1 WHERE source_object_key=?2",params![new_key,old_key]).map_err(io_error)?;
   tx.execute("UPDATE content_reference_edges SET target_object_key=?1 WHERE target_object_key=?2",params![new_key,old_key]).map_err(io_error)?;
   super::record_references::write_reference_edges(tx,&target,&head.projection.document,&binding.workspace_id)?;
   // Access policy follows the logical object; stale search copies cannot retain old-owner access.
   if self.table_exists("source_access_policies").map_err(|_|invalid("Cannot inspect source policies"))? {
    tx.execute("UPDATE source_access_policies SET object_key=?1 WHERE object_key=?2",params![new_key,old_key]).map_err(io_error)?;
    tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1",[&old_key]).map_err(io_error)?;
    let voice_id:Option<i64> = tx.query_row("SELECT id FROM voice_records WHERE project_note_id IS ?1 AND workspace_note_id IS ?2",params![project(&target.scope).map(|_|target.record_id),if matches!(target.scope,Scope::Workspace){Some(target.record_id)}else{None}],|r|r.get(0)).optional().map_err(io_error)?;
    if let Some(id)=voice_id {
     let old_transcript=ObjectRef{workspace_id:binding.workspace_id.clone(),scope:input.source.scope.clone(),kind:ObjectKind::Transcript,id:id.to_string()}.key()?;
     let new_transcript=ObjectRef{workspace_id:binding.workspace_id.clone(),scope:target.scope.clone(),kind:ObjectKind::Transcript,id:id.to_string()}.key()?;
     tx.execute("UPDATE source_access_policies SET object_key=?1 WHERE object_key=?2",params![new_transcript,old_transcript]).map_err(io_error)?;
     tx.execute("DELETE FROM source_index_snapshots WHERE object_key IN (?1,?2)",params![old_transcript,new_transcript]).map_err(io_error)?;
    }
   }
   tx.execute("UPDATE agent_object_withdrawals SET object_key=?1 WHERE object_key=?2",params![new_key,old_key]).map_err(io_error)?;
   tx.execute(&format!("DELETE FROM {source_table} WHERE id=?1"),[input.source.record_id]).map_err(io_error)?;
   // Render compatibility paths using this Record's exact retained-resource provenance.
   let compatibility=self.record_compatibility_html(&target,&head.projection)?;
   let target_table=if matches!(target.scope,Scope::Workspace){"workspace_notes"}else{"notes"};
   tx.execute(&format!("UPDATE {target_table} SET content_html=?1,content_markdown=?2,default_code_language=?3,updated_at=CASE WHEN ?5 THEN ?6 ELSE updated_at END WHERE id=?4"),params![compatibility,head.projection.markdown,head.projection.code_language,target.record_id,plan.needs_projection,now]).map_err(io_error)?;
   for owner in [&input.source.scope,&target.scope] {if let Some(id)=project(owner){tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2",params![now,id]).map_err(io_error)?;}}
   let metadata=self.record_metadata_get(&target)?;
   let result=RecordOwnerMoveResult{logical_id,source:input.source.clone(),target,operation_id,head_revision:head.head_revision,body_hash:head.projection.body_hash,metadata_revision:metadata.revision};
   for (object,scope) in [(old_key,&input.source.scope),(new_key,&input.destination)] {tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,?3,?4,?5)",params![object,scope.key(),OP,result.body_hash,now]).map_err(io_error)?;}
   Ok((result,None))
  })
    }
}

impl Database {
    pub(super) fn record_move_retained_assets(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<BTreeMap<String, Scope>> {
        if !installed(&self.conn)? {
            return Ok(BTreeMap::new());
        }
        let mut q=self.conn.prepare("SELECT a.asset_ref,a.origin_scope_key FROM record_owner_move_assets a JOIN record_logical_identities i USING(logical_id) WHERE i.current_key=?1").map_err(io_error)?;
        let rows = q
            .query_map([target.key()?], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        rows.into_iter()
            .map(|(path, scope)| Ok((path, parse_scope_key(&scope)?)))
            .collect()
    }
}

pub(super) fn receipt_committed(
    tx: &rusqlite::Transaction<'_>,
    caller: &str,
    request: &str,
    operation: &str,
    result: &str,
    workspace: Option<&str>,
) -> AgentResult<()> {
    if operation != OP {
        return Ok(());
    }
    let result: RecordOwnerMoveResult =
        serde_json::from_str(result).map_err(|_| invalid("Invalid Record move receipt"))?;
    // The binding is also part of payload_hash. Native DBs always have this ID;
    // fixture DBs intentionally do not expose operation history to a real caller.
    let object = ObjectRef {
        workspace_id: workspace
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::WorkspaceChanged,
                    "Record move database is not bound",
                )
            })?
            .into(),
        scope: result.target.scope.clone(),
        kind: ObjectKind::Record,
        id: result.target.record_id.to_string(),
    };
    tx.execute("UPDATE agent_operation_receipts SET operation_id=?1,target_ref_json=?2,after_revision=?3,undo_state='unavailable',output_context_json=?4 WHERE caller_id=?5 AND request_id=?6",params![result.operation_id,serde_json::to_string(&object).map_err(|_|invalid("Invalid Record move object"))?,result.head_revision as i64,json!({"source":result.source,"logicalId":result.logical_id,"bodyHash":result.body_hash}).to_string(),caller,request]).map_err(io_error)?;
    Ok(())
}

impl Database {
    pub(super) fn record_move_reference_route(
        &self,
        kind: &str,
        id: i64,
    ) -> anyhow::Result<Option<crate::models::InternalReferenceResolveResult>> {
        let Some(target) = resolve_legacy(&self.conn, kind, id)
            .map_err(|e| anyhow::anyhow!(serde_json::to_string(&e).unwrap_or(e.message)))?
        else {
            return Ok(None);
        };
        super::agent_record_withdrawals::require_record_visible(&self.conn, &target)
            .map_err(|e| anyhow::anyhow!(serde_json::to_string(&e).unwrap_or(e.message)))?;
        let table = if matches!(target.scope, Scope::Workspace) {
            "workspace_notes"
        } else {
            "notes"
        };
        let label:String=self.conn.query_row(&format!("SELECT CASE WHEN NULLIF(TRIM(title),'') IS NOT NULL AND TRIM(title)!='记录' THEN TRIM(title) ELSE coalesce(NULLIF(TRIM(content_markdown),''),'记录') END FROM {table} WHERE id=?1"),[target.record_id],|r|r.get(0))?;
        let (kind, scope, project_id, route) = match target.scope {
            Scope::Workspace => (
                "workspace_record",
                crate::models::TodoScope::Workspace,
                None,
                format!("/workspace/records/{}", target.record_id),
            ),
            Scope::Project { project_id } => (
                "note",
                crate::models::TodoScope::Project,
                Some(project_id),
                format!("/projects/{project_id}/records/{}", target.record_id),
            ),
        };
        Ok(Some(crate::models::InternalReferenceResolveResult {
            kind: kind.into(),
            id: target.record_id,
            label: super::truncate_text(
                &super::normalize_internal_reference_label(kind, &label),
                72,
            ),
            scope,
            project_id,
            route,
            focus_id: None,
            managed_path: None,
        }))
    }
}
/// Receipts survive deletion; route only a recorded migration alias here.
pub(super) fn resolve_receipt_object(
    conn: &Connection,
    object: &ObjectRef,
) -> AgentResult<ObjectRef> {
    if object.kind != ObjectKind::Record || !installed(conn)? {
        return Ok(object.clone());
    }
    let id = object
        .id
        .parse::<i64>()
        .map_err(|_| invalid("Invalid receipt Record identity"))?;
    let key = RecordTarget {
        scope: object.scope.clone(),
        record_id: id,
    }
    .key()?;
    let found: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM record_location_aliases WHERE location_key=?1)",
            [key],
            |r| r.get(0),
        )
        .map_err(io_error)?;
    if found {
        resolve_object(conn, object)
    } else {
        Ok(object.clone())
    }
}

impl Database {
    /// Read-only directory mutation guard. Integration invokes this before the
    /// filesystem mutation, again under its commit-time owner lease/fence.
    pub(crate) fn record_owner_require_unshared_root(
        &self,
        _root: &std::path::Path,
        _owner: Option<i64>,
    ) -> anyhow::Result<()> {
        if !installed(&self.conn).map_err(|e| anyhow::anyhow!(e.message))? {
            return Ok(());
        }
        anyhow::ensure!(
            _root.is_absolute(),
            "Record resource mutation root must be absolute"
        );
        // Directory callers already reject symlinks and validate the physical owner.
        // Canonicalizing the existing root also aligns /tmp and /private/tmp aliases.
        let root = std::fs::canonicalize(_root)?;
        let workspace = std::fs::canonicalize(&self.workspace_root)?;
        let owner = _owner.map_or_else(|| "workspace".to_string(), |id| format!("project:{id}"));
        let mut statement = self.conn.prepare("SELECT a.asset_ref,i.logical_id FROM record_owner_move_assets a JOIN record_logical_identities i USING(logical_id) WHERE i.scope_key!=?1")?;
        for row in statement.query_map([owner], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (asset, logical_id) = row?;
            if workspace.join(&asset).starts_with(&root) {
                anyhow::bail!("此路径仍保留已移到其他位置的 Record {logical_id} 使用的资源 {asset}，请先迁移或保留这些资源");
            }
        }
        Ok(())
    }
}
