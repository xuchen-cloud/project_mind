use super::agent_operations::{io_error, OperationChange};
use super::record_references::{reference_identities, validate_references, write_reference_edges};
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope},
};
use crate::record_documents::*;
use chrono::{Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn source(conn: &Connection, target: &RecordTarget) -> AgentResult<RecordLegacySource> {
    let current = source_unchecked(conn, target)?;
    super::agent_record_withdrawals::require_record_visible(conn, target)?;
    Ok(current)
}

fn checked_patch_base(
    conn: &Connection,
    patch: &crate::agent::outputs::RecordPatch,
) -> AgentResult<RecordDocumentHead> {
    let target = record_patch_target(patch)?;
    let current = head_unchecked(conn, &target)?.ok_or_else(|| AgentError::new(
        ErrorCode::SourceNotReady, "Initialize the Record document first"
    ))?;
    if current.head_revision != patch.base_revision {
        return Err(conflict(&current));
    }
    validate_record_patch(patch, &current)?;
    Ok(current)
}

fn validate_patch_projection(
    current: &RecordDocumentHead,
    projection: &RecordDocumentProjection,
    metadata: &RecordPatchMetadata,
) -> AgentResult<()> {
    let before: std::collections::BTreeSet<_> =
        document_block_ids(&current.projection.document).into_iter().collect();
    let after: std::collections::BTreeSet<_> =
        document_block_ids(&projection.document).into_iter().collect();
    let created: std::collections::BTreeSet<_> = metadata.created_block_ids.iter().cloned().collect();
    let deleted: std::collections::BTreeSet<_> = metadata.deleted_block_ids.iter().cloned().collect();
    if created.len() != metadata.created_block_ids.len()
        || deleted.len() != metadata.deleted_block_ids.len()
        || created != after.difference(&before).cloned().collect()
        || deleted != before.difference(&after).cloned().collect()
        || metadata.no_change != (current.projection.body_hash == projection.body_hash)
        || current.projection.code_language != projection.code_language
        || metadata.normalizations.iter().any(|repair| match repair.kind.as_str() {
            "empty_document_paragraph" => repair.block_id.is_some(),
            "empty_container_paragraph" | "remove_empty_container" =>
                repair.block_id.as_ref().is_none_or(|id| !before.contains(id)),
            _ => true,
        })
    {
        return Err(invalid("Worker patch metadata differs from the resulting document"));
    }
    Ok(())
}

fn source_unchecked(conn: &Connection, target: &RecordTarget) -> AgentResult<RecordLegacySource> {
    target.key()?;
    let value = match target.scope {
        Scope::Workspace => conn.query_row("SELECT title,content_html,content_markdown,default_code_language FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'", [target.record_id], |row| Ok((row.get::<_, Option<String>>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, Option<String>>(3)?))).optional(),
        Scope::Project { project_id } => conn.query_row("SELECT title,content_html,content_markdown,default_code_language FROM notes WHERE id=?1 AND project_id=?2", params![target.record_id,project_id], |row| Ok((row.get::<_, Option<String>>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, Option<String>>(3)?))).optional(),
    }.map_err(io_error)?.ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Record is not present in this scope"))?;
    let (title, html, markdown, code_language) = value;
    let asset_base_path = if let Scope::Project { project_id } = target.scope {
        let root: String = conn
            .query_row(
                "SELECT root_path FROM projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        let relative = root
            .strip_prefix(super::WORKSPACE_PATH_PREFIX)
            .ok_or_else(|| {
                AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Project root cannot be represented relative to this Workspace",
                )
            })?;
        if relative.is_empty() {
            None
        } else if relative_asset(relative) {
            Some(relative.into())
        } else {
            return Err(invalid("Invalid Project asset base"));
        }
    } else {
        None
    };
    let hash = format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&json!({"html":html,"markdown":markdown,"codeLanguage":code_language,"assetBasePath":asset_base_path})).map_err(|_| invalid("Invalid source body"))?));
    Ok(RecordLegacySource {
        title,
        html,
        markdown,
        code_language,
        source_hash: hash,
        asset_base_path,
    })
}

pub(super) fn metadata(conn: &Connection, target: &RecordTarget) -> AgentResult<RecordMetadata> {
    source(conn, target)?;
    metadata_unchecked(conn, target)
}

pub(super) fn metadata_unchecked(
    conn: &Connection,
    target: &RecordTarget,
) -> AgentResult<RecordMetadata> {
    let current = source_unchecked(conn, target)?;
    let (tags_sql, timestamp_sql) = match target.scope {
        Scope::Workspace => ("SELECT tag_id FROM workspace_note_tag_links WHERE workspace_note_id=?1 ORDER BY tag_id", "SELECT updated_at FROM workspace_notes WHERE id=?1"),
        Scope::Project { .. } => ("SELECT tag_id FROM note_tag_links WHERE note_id=?1 ORDER BY tag_id", "SELECT updated_at FROM notes WHERE id=?1"),
    };
    let mut statement = conn.prepare(tags_sql).map_err(io_error)?;
    let tag_ids: Vec<i64> = statement
        .query_map([target.record_id], |row| row.get(0))
        .map_err(io_error)?
        .collect::<Result<_, _>>()
        .map_err(io_error)?;
    let updated_at = conn
        .query_row(timestamp_sql, [target.record_id], |row| row.get(0))
        .map_err(io_error)?;
    let revision = format!(
        "sha256:{:x}",
        Sha256::digest(json!({"title":current.title,"tagIds":tag_ids}).to_string())
    );
    Ok(RecordMetadata {
        title: current.title,
        tag_ids,
        revision,
        updated_at,
    })
}

pub(super) fn head_unchecked(
    conn: &Connection,
    target: &RecordTarget,
) -> AgentResult<Option<RecordDocumentHead>> {
    let value = conn.query_row("SELECT head_revision,document_json,body_hash,schema_version,code_language,html,markdown,text,edit_session_id,checkpoint_due_at FROM record_document_heads WHERE record_key=?1", [target.key()?], |row| {
        let document: String = row.get(1)?;
        Ok((row.get::<_, i64>(0)?, document, row.get::<_, String>(2)?, row.get::<_, u32>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?))
    }).optional().map_err(io_error)?;
    let result = value
        .map(|value| {
            Ok(RecordDocumentHead {
                target: target.clone(),
                head_revision: value.0 as u64,
                projection: RecordDocumentProjection {
                    document: serde_json::from_str(&value.1).map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Stored Record document is damaged")
                    })?,
                    body_hash: value.2,
                    schema_version: value.3,
                    code_language: value.4,
                    html: value.5,
                    markdown: value.6,
                    text: value.7,
                },
                edit_session_id: value.8,
                checkpoint_due_at: value.9,
            })
        })
        .transpose()?;
    if let Some(head) = &result {
        head.projection.validate().map_err(|_| damaged())?;
    }
    Ok(result)
}

fn conflict(current: &RecordDocumentHead) -> AgentError {
    AgentError::new(
        ErrorCode::RevisionConflict,
        "Record body changed before commit",
    )
    .with_details(
        json!({"headRevision":current.head_revision,"bodyHash":current.projection.body_hash}),
    )
}
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn damaged() -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Stored Record version is damaged")
}
fn parse_origin(origin: String) -> AgentResult<RecordVersionOrigin> {
    serde_json::from_value(Value::String(origin)).map_err(|_| damaged())
}
fn version(conn: &Connection, target: &RecordTarget, id: &str) -> AgentResult<RecordVersion> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("Invalid Record version ID"));
    }
    let value = conn.query_row("SELECT version_number,head_revision,document_snapshot,html,markdown,text,schema_version,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at FROM record_versions WHERE record_key=?1 AND id=?2", params![target.key()?,id], |row| {
        Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,u32>(6)?,row.get::<_,Option<String>>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,String>(9)?,row.get::<_,String>(10)?,row.get::<_,String>(11)?,row.get::<_,String>(12)?,row.get::<_,Option<String>>(13)?,row.get::<_,String>(14)?))
    }).optional().map_err(io_error)?.ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Version is not present in this Record"))?;
    let projection = RecordDocumentProjection {
        document: serde_json::from_str(&value.2).map_err(|_| damaged())?,
        html: value.3,
        markdown: value.4,
        text: value.5,
        schema_version: value.6,
        code_language: value.7,
        body_hash: value.9,
    };
    projection.validate().map_err(|_| damaged())?;
    Ok(RecordVersion {
        id: id.into(),
        version_number: value.0 as u64,
        head_revision: value.1 as u64,
        projection,
        title_snapshot: value.8,
        origin: parse_origin(value.10)?,
        actor: serde_json::from_str(&value.11).map_err(|_| damaged())?,
        operation_id: value.12,
        restored_from_version_id: value.13,
        created_at: value.14,
    })
}

fn snapshot(
    tx: &Transaction<'_>,
    current: &RecordDocumentHead,
    title: &Option<String>,
    origin: &RecordVersionOrigin,
    actor: &Value,
    operation_id: &str,
    restored_from: Option<&str>,
) -> AgentResult<String> {
    let key = current.target.key()?;
    let latest = tx.query_row("SELECT id,body_hash FROM record_versions WHERE record_key=?1 ORDER BY version_number DESC LIMIT 1", [&key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(io_error)?;
    if let Some((id, hash)) = latest {
        if hash == current.projection.body_hash {
            // A matching cached hash cannot make a damaged snapshot undoable.
            version(tx, &current.target, &id)?;
            return Ok(id);
        }
    }
    let version: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM record_versions WHERE record_key=?1",
            [&key],
            |row| row.get(0),
        )
        .map_err(io_error)?;
    let id = random_id();
    let p = &current.projection;
    tx.execute("INSERT INTO record_versions(id,record_key,version_number,head_revision,document_snapshot,html,markdown,text,schema_version,code_language,title_snapshot,body_hash,origin,actor_json,operation_id,restored_from_version_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        params![id,key,version,current.head_revision as i64,p.document.to_string(),p.html,p.markdown,p.text,p.schema_version,p.code_language,title,p.body_hash,origin.key(),actor.to_string(),operation_id,restored_from,Utc::now().to_rfc3339()]).map_err(io_error)?;
    for path in p.validate()? {
        tx.execute(
            "INSERT INTO record_version_assets(version_id,asset_ref) VALUES (?1,?2)",
            params![id, path],
        )
        .map_err(io_error)?;
    }
    Ok(id)
}

impl Database {
    /// Preserve outbox sequence, payload revision and dates while upgrading the
    /// previous Workspace-local Record key format. No object lookup is needed:
    /// logs for explicitly deleted Records still retain their original identity.
    pub(crate) fn record_migrate_operation_keys(&self, workspace_id: &str) -> AgentResult<()> {
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        let mut cursor = 0_i64;
        loop {
            let mut statement = tx.prepare("SELECT seq,object_key,scope_key FROM agent_change_log WHERE seq>?1 AND object_key LIKE 'record:%' ORDER BY seq LIMIT 500").map_err(io_error)?;
            let rows = statement
                .query_map([cursor], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(io_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io_error)?;
            drop(statement);
            if rows.is_empty() {
                break;
            }
            for (seq, key, scope_key) in rows {
                cursor = seq;
                let parts: Vec<_> = key.split(':').collect();
                let (scope, id) = match parts.as_slice() {
                    ["record", "workspace", id] => (Scope::Workspace, *id),
                    ["record", "project", project, id] => (
                        Scope::Project {
                            project_id: project.parse().map_err(|_| damaged())?,
                        },
                        *id,
                    ),
                    _ => return Err(damaged()),
                };
                if scope.key() != scope_key {
                    return Err(damaged());
                }
                let target = RecordTarget {
                    scope,
                    record_id: id.parse().map_err(|_| damaged())?,
                };
                if format!("record:{}", target.key()?) != key {
                    return Err(damaged());
                }
                tx.execute(
                    "UPDATE agent_change_log SET object_key=?1 WHERE seq=?2",
                    params![target.object_key(workspace_id)?, seq],
                )
                .map_err(io_error)?;
            }
        }
        tx.commit().map_err(io_error)
    }
    /// Upgrade the previous full-response receipts one row at a time. Payload
    /// hashes and commit revisions survive; no historic body needs a second copy.
    pub(crate) fn record_compact_operation_receipts(&self) -> AgentResult<()> {
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        let mut cursor = 0_i64;
        loop {
            let row = tx.query_row("SELECT rowid,result_json FROM agent_operation_receipts WHERE rowid>?1 AND operation IN ('record.create','record.document.initialize','record.document.commit','record.document.checkpoint','record.quick_note.transfer','record.version.restore','record.patch') AND (json_type(result_json,'$.projection')='object' OR json_type(result_json,'$.head.projection')='object') ORDER BY rowid LIMIT 1", [cursor], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?))).optional().map_err(io_error)?;
            let Some((rowid, stored)) = row else {
                break;
            };
            cursor = rowid;
            let mut value: Value = serde_json::from_str(&stored).map_err(|_| damaged())?;
            let head = if value.get("head").is_some() {
                value.get_mut("head").ok_or_else(damaged)?
            } else {
                &mut value
            };
            let projection = head.get("projection").ok_or_else(damaged)?;
            let document = projection.get("document").ok_or_else(damaged)?;
            let language: Option<String> = serde_json::from_value(
                projection
                    .get("codeLanguage")
                    .cloned()
                    .unwrap_or(Value::Null),
            )
            .map_err(|_| damaged())?;
            let hash = projection
                .get("bodyHash")
                .and_then(Value::as_str)
                .ok_or_else(damaged)?
                .to_string();
            if body_hash(document, &language) != hash {
                return Err(damaged());
            }
            let target: RecordTarget =
                serde_json::from_value(head.get("target").cloned().ok_or_else(damaged)?)
                    .map_err(|_| damaged())?;
            target.key()?;
            if head
                .get("headRevision")
                .and_then(Value::as_u64)
                .is_none_or(|revision| revision == 0 || revision > i64::MAX as u64)
            {
                return Err(damaged());
            }
            let map = head.as_object_mut().ok_or_else(damaged)?;
            map.remove("projection");
            map.remove("editSessionId");
            map.remove("checkpointDueAt");
            map.insert("bodyHash".into(), json!(hash));
            tx.execute(
                "UPDATE agent_operation_receipts SET result_json=?1 WHERE rowid=?2",
                params![value.to_string(), rowid],
            )
            .map_err(io_error)?;
        }
        tx.commit().map_err(io_error)
    }
    pub(crate) fn record_create(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordCreate,
        projection: &RecordDocumentProjection,
        workspace_id: &str,
    ) -> AgentResult<RecordCommittedHead> {
        self.record_create_from_intent(caller, request_id, input, projection, input, workspace_id)
    }
    pub(crate) fn record_create_from_intent<T: serde::Serialize>(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordCreate,
        projection: &RecordDocumentProjection,
        original_payload: &T,
        workspace_id: &str,
    ) -> AgentResult<RecordCommittedHead> {
        input.scope.validate()?;
        projection.validate()?;
        self.record_document_scope_from_gui(&input.scope, &projection.document)?;
        let compatibility = self.record_compatibility_html(
            &RecordTarget {
                scope: input.scope.clone(),
                record_id: 1,
            },
            projection,
        )?;
        self.agent_atomic_operation(caller, request_id, "record.create", original_payload, |tx| {
            validate_references(tx, &input.scope, &projection.document, &Default::default(), workspace_id)?;
            let timestamp = Utc::now().to_rfc3339();
            match input.scope {
                Scope::Project { project_id } => self.insert_project_note(project_id, None, "", "<p></p>", None, &timestamp).map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot create Record"))?,
                Scope::Workspace => { tx.execute("INSERT INTO workspace_notes(note_kind,title,content_markdown,content_html,created_at,updated_at) VALUES ('workspace_note',NULL,'','<p></p>',?1,?1)", [&timestamp]).map_err(io_error)?; }
            }
            let target = RecordTarget { scope: input.scope.clone(), record_id: tx.last_insert_rowid() };
            let current = metadata(tx, &target)?;
            let (saved_metadata, _) = self.record_metadata_transaction(tx, &RecordMetadataUpdate {
                target: target.clone(), expected_revision: current.revision,
                title: input.title.clone(), tag_ids: input.tag_ids.clone(),
            }, workspace_id)?;
            let (project, workspace) = match input.scope { Scope::Workspace => (None, Some(target.record_id)), Scope::Project { .. } => (Some(target.record_id), None) };
            tx.execute("INSERT INTO record_document_heads(record_key,project_note_id,workspace_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,code_language,updated_at) VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11)", params![target.key()?,project,workspace,projection.document.to_string(),projection.html,projection.markdown,projection.text,projection.body_hash,projection.schema_version,projection.code_language,timestamp]).map_err(io_error)?;
            Self::record_write_projection(tx, &target, projection, &compatibility, workspace_id)?;
            let initial = head_unchecked(tx, &target)?.ok_or_else(damaged)?;
            snapshot(tx, &initial, &saved_metadata.title, &RecordVersionOrigin::Baseline, &if caller=="gui" {json!({"kind":"gui"})}else{json!({"kind":"agent","caller":caller})}, request_id, None)?;
            Ok((RecordCommittedHead::from(&initial), Some(OperationChange { object_key: target.object_key(workspace_id)?, scope: target.scope, revision: projection.body_hash.clone() })))
        })
    }
    /// Pure creation checks shared by previews and the native insert path.
    pub(crate) fn record_create_preview_validate(
        &self,
        input: &RecordCreate,
        projection: &RecordDocumentProjection,
        workspace_id: &str,
    ) -> AgentResult<(Option<String>, Vec<i64>)> {
        input.scope.validate()?;
        projection.validate()?;
        self.record_document_scope_from_gui(&input.scope, &projection.document)?;
        self.record_compatibility_html(&RecordTarget {
            scope: input.scope.clone(), record_id: 1,
        }, projection)?;
        let metadata = self.validated_record_metadata(&input.scope, &input.title, &input.tag_ids)?;
        validate_references(
            &self.conn, &input.scope, &projection.document, &Default::default(), workspace_id,
        )?;
        Ok(metadata)
    }
    pub(crate) fn record_quick_note_source(
        &self,
        scope: &Scope,
    ) -> AgentResult<RecordQuickNoteSource> {
        scope.validate()?;
        let (quick_note_id, html, markdown, code_language, updated_at) = match scope {
            Scope::Project { project_id } => self.conn.query_row(
                "SELECT NULL,summary_html,summary_markdown,quick_note_code_language,updated_at FROM projects WHERE id=?1", [project_id],
                |row| Ok((row.get::<_,Option<i64>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?))),
            Scope::Workspace => self.conn.query_row(
                "SELECT id,content_html,content_markdown,default_code_language,updated_at FROM workspace_notes WHERE note_kind=?1 ORDER BY created_at DESC,id DESC LIMIT 1", [super::WORKSPACE_NOTE_KIND_TODAY_QUICK],
                |row| Ok((row.get::<_,Option<i64>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?))),
        }.optional().map_err(io_error)?.ok_or_else(|| AgentError::new(ErrorCode::NotFound,"QuickNote is missing"))?;
        let asset_base_path = if let Scope::Project { project_id } = scope {
            let root = self
                .project_root_path(*project_id)
                .map_err(|_| AgentError::new(ErrorCode::NotFound, "Project is missing"))?;
            let relative = root
                .strip_prefix(&self.workspace_root)
                .map_err(|_| {
                    AgentError::new(ErrorCode::ScopeDenied, "Project is outside this Workspace")
                })?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.is_empty() {
                None
            } else {
                Some(relative)
            }
        } else {
            None
        };
        let source_hash = format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&json!({"id":quick_note_id,"html":html,"markdown":markdown,"codeLanguage":code_language,"updatedAt":updated_at})).map_err(|_|invalid("Invalid QuickNote source"))?));
        Ok(RecordQuickNoteSource {
            quick_note_id,
            html,
            markdown,
            code_language,
            asset_base_path,
            source_hash,
        })
    }

    pub(crate) fn record_quick_note_transfer(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordQuickNoteTransfer,
        expected_source_hash: &str,
        projection: &RecordDocumentProjection,
        empty: Option<&RecordDocumentProjection>,
        workspace_id: &str,
    ) -> AgentResult<RecordCommitResult> {
        input.scope.validate()?;
        if input.expected_markdown.trim().is_empty()
            || input.expected_markdown.len() > 1024 * 1024
            || input.record_id.is_some_and(|id| id <= 0)
            || (input.record_id.is_some()
                && (input.base_revision.is_none() || input.metadata_revision.is_none()))
            || (input.record_id.is_none()
                && (input.base_revision.is_some() || input.metadata_revision.is_some()))
        {
            return Err(invalid("Invalid QuickNote transfer baseline"));
        }
        let claimed = RecordTarget {
            scope: input.scope.clone(),
            record_id: input.record_id.unwrap_or(1),
        };
        let compatibility = self.record_compatibility_html(&claimed, projection)?;
        if let Some(empty) = empty {
            empty.validate()?;
        }
        self.agent_atomic_operation(caller, request_id, "record.quick_note.transfer", input, |tx| {
            let quick = self.record_quick_note_source(&input.scope)?;
            if quick.markdown != input.expected_markdown || quick.source_hash != expected_source_hash {
                return Err(AgentError::new(ErrorCode::SourceChanged,"QuickNote changed before transfer"));
            }
            let quick_object = ObjectRef { workspace_id: workspace_id.into(), scope: input.scope.clone(), kind: ObjectKind::QuickNote,
                id: match input.scope { Scope::Project { project_id } => project_id, Scope::Workspace => quick.quick_note_id.ok_or_else(damaged)? }.to_string() };
            let quick_before = self.source_quick_note_current(quick_object.clone())?.source.revision;
            let timestamp = Utc::now().to_rfc3339();
            let target = if let Some(record_id) = input.record_id {
                let target = RecordTarget { scope: input.scope.clone(), record_id };
                source(tx, &target)?;
                target
            } else {
                match input.scope {
                    Scope::Project { project_id } => self.insert_project_note(project_id,None,"","<p></p>",None,&timestamp).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Cannot create Record"))?,
                    Scope::Workspace => { tx.execute("INSERT INTO workspace_notes(note_kind,title,content_markdown,content_html,created_at,updated_at) VALUES ('workspace_note',NULL,'','<p></p>',?1,?1)",[&timestamp]).map_err(io_error)?; }
                }
                RecordTarget { scope: input.scope.clone(), record_id: tx.last_insert_rowid() }
            };
            let current_metadata = metadata(tx, &target)?;
            let update = RecordMetadataUpdate { target: target.clone(), expected_revision: input.metadata_revision.clone().unwrap_or_else(||current_metadata.revision.clone()),
                title: if input.record_id.is_some() { current_metadata.title } else { input.title.clone() }, tag_ids: input.tag_ids.clone() };
            let (saved_metadata, _) = self.record_metadata_transaction(tx, &update, workspace_id)?;
            if input.record_id.is_none() {
                let initial = empty.ok_or_else(||invalid("New Record requires an empty baseline"))?;
                if !initial.text.is_empty() || !initial.validate()?.is_empty() { return Err(invalid("New Record baseline must be empty")); }
                let (project_id, workspace_id) = match input.scope { Scope::Project { .. } => (Some(target.record_id),None), Scope::Workspace => (None,Some(target.record_id)) };
                tx.execute("INSERT INTO record_document_heads(record_key,project_note_id,workspace_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,code_language,updated_at) VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11)",params![target.key()?,project_id,workspace_id,initial.document.to_string(),initial.html,initial.markdown,initial.text,initial.body_hash,initial.schema_version,initial.code_language,timestamp]).map_err(io_error)?;
                let initial_head = head_unchecked(tx,&target)?.ok_or_else(damaged)?;
                snapshot(tx,&initial_head,&saved_metadata.title,&RecordVersionOrigin::Baseline,&json!({"kind":"gui"}),request_id,None)?;
            }
            let commit = RecordDocumentCommit { target: target.clone(), base_revision: input.base_revision.unwrap_or(1), projection: projection.clone(),
                origin: RecordVersionOrigin::QuickNote, actor: json!({"kind":"gui","source":"quick_note"}), edit_session_id: None };
            let (mut saved, change) = Self::record_commit_transaction(tx, request_id, &commit, &compatibility, None, workspace_id)?;
            match input.scope {
                Scope::Project { project_id } => { tx.execute("UPDATE projects SET summary='',summary_html='<p></p>',summary_markdown='',quick_note_code_language=NULL,updated_at=?1 WHERE id=?2",params![timestamp,project_id]).map_err(io_error)?; }
                Scope::Workspace => {
                    let quick_note_id = quick.quick_note_id.ok_or_else(damaged)?;
                    tx.execute("UPDATE workspace_notes SET content_html='<p></p>',content_markdown='',default_code_language=NULL,updated_at=?1 WHERE id=?2",params![timestamp,quick_note_id]).map_err(io_error)?;
                    self.replace_workspace_note_tags(quick_note_id,&[],&timestamp).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Cannot clear QuickNote tags"))?;
                }
            }
            let quick_after = self.source_quick_note_current(quick_object.clone())?.source.revision;
            if quick_after != quick_before {
                tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'quick_note.clear',?3,?4)",
                    params![quick_object.key()?,quick_object.scope.key(),quick_after,timestamp]).map_err(io_error)?;
            }
            saved.metadata = Some(saved_metadata);
            Ok((saved, change))
        })
    }

    pub(crate) fn record_editor_state(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<RecordEditorState> {
        let head = self.record_document_head(target)?.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Initialize the Record document first",
            )
        })?;
        let metadata = self.record_metadata_get(target)?;
        let record = match target.scope {
            Scope::Project { .. } => {
                RecordEditorRecord::Project(self.note_record(target.record_id).map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot read editor Record")
                })?)
            }
            Scope::Workspace => RecordEditorRecord::Workspace(
                self.workspace_note_record(target.record_id).map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot read editor Record")
                })?,
            ),
        };
        Ok(RecordEditorState {
            head,
            metadata,
            record,
        })
    }
    pub(crate) fn record_metadata_get(&self, target: &RecordTarget) -> AgentResult<RecordMetadata> {
        metadata(&self.conn, target)
    }
    pub(crate) fn record_version_editor_html(
        &self,
        target: &RecordTarget,
        projection: &RecordDocumentProjection,
    ) -> AgentResult<String> {
        source(&self.conn, target)?;
        let html = self.record_compatibility_html(target, projection)?;
        match target.scope {
            Scope::Project { project_id } => self
                .hydrate_project_rich_text_html(project_id, &html)
                .map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot display historic Record assets")
                }),
            Scope::Workspace => Ok(self.hydrate_workspace_rich_text_html(&html)),
        }
    }
    pub(crate) fn record_metadata_update(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordMetadataUpdate,
        workspace_id: &str,
    ) -> AgentResult<RecordMetadata> {
        self.agent_atomic_operation(caller, request_id, "record.metadata.update", input, |tx| {
            self.record_metadata_transaction(tx, input, workspace_id)
        })
    }
    fn record_metadata_transaction(
        &self,
        tx: &Transaction<'_>,
        input: &RecordMetadataUpdate,
        workspace_id: &str,
    ) -> AgentResult<(RecordMetadata, Option<OperationChange>)> {
        if !input.expected_revision.starts_with("sha256:") || input.expected_revision.len() != 71 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Record metadata",
            ));
        }
        let (title, tag_ids) = self.validated_record_metadata(&input.target.scope, &input.title, &input.tag_ids)?;

        let current = metadata(tx, &input.target)?;
        if current.revision != input.expected_revision {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Record metadata changed before save",
            )
            .with_details(json!({"current":current})));
        }
        if current.title == title && current.tag_ids == tag_ids {
            return Ok((current, None));
        }
        let timestamp = Utc::now().to_rfc3339();
        match input.target.scope {
            Scope::Workspace => {
                tx.execute("UPDATE workspace_notes SET title=?1,updated_at=?2 WHERE id=?3 AND note_kind='workspace_note'", params![title, timestamp, input.target.record_id]).map_err(io_error)?;
                self.replace_workspace_note_tags(input.target.record_id, &tag_ids, &timestamp)
                    .map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Cannot update Record tags")
                    })?;
            }
            Scope::Project { project_id } => {
                tx.execute(
                    "UPDATE notes SET title=?1,updated_at=?2 WHERE id=?3 AND project_id=?4",
                    params![title, timestamp, input.target.record_id, project_id],
                )
                .map_err(io_error)?;
                self.replace_note_tags(input.target.record_id, &tag_ids, &timestamp)
                    .map_err(|_| {
                        AgentError::new(ErrorCode::IoFailed, "Cannot update Record tags")
                    })?;
                tx.execute(
                    "UPDATE projects SET updated_at=?1 WHERE id=?2",
                    params![timestamp, project_id],
                )
                .map_err(io_error)?;
            }
        }
        let saved = metadata(tx, &input.target)?;
        let change = OperationChange {
            object_key: input.target.object_key(workspace_id)?,
            scope: input.target.scope.clone(),
            revision: saved.revision.clone(),
        };
        Ok((saved, Some(change)))
    }
    fn validated_record_metadata(
        &self,
        scope: &Scope,
        title: &Option<String>,
        tags: &[i64],
    ) -> AgentResult<(Option<String>, Vec<i64>)> {
        if tags.len() > 1000 || tags.iter().any(|id| *id <= 0)
            || title.as_ref().is_some_and(|title| title.len() > 64 * 1024 || title.contains(['\n', '\r', '\0'])) {
            return Err(AgentError::new(ErrorCode::InvalidArgument, "Invalid Record metadata"));
        }
        let title = title.as_deref().map(str::trim).filter(|title| !title.is_empty()).map(str::to_string);
        let mut tag_ids = tags.to_vec();
        tag_ids.sort_unstable();
        tag_ids.dedup();
        let project_id = match scope { Scope::Workspace => None, Scope::Project { project_id } => Some(*project_id) };
        for id in &tag_ids {
            self.scoped_file_tag_record(project_id, *id).map_err(|_| {
                AgentError::new(ErrorCode::ScopeDenied, "Record tag is outside this scope")
            })?;
        }
        Ok((title, tag_ids))
    }
    pub(crate) fn record_metadata_apply(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordMetadataApply,
        workspace_id: &str,
    ) -> AgentResult<RecordMetadata> {
        if input.new_tags.len() > 3 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "AI metadata can create at most three tags",
            ));
        }
        self.agent_atomic_operation(caller, request_id, "record.metadata.apply", input, |tx| {
            let current = metadata(tx, &input.metadata.target)?;
            if current.revision != input.metadata.expected_revision {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "Record metadata changed before AI apply",
                )
                .with_details(json!({"current":current})));
            }
            let project_id = match input.metadata.target.scope {
                Scope::Workspace => None,
                Scope::Project { project_id } => Some(project_id),
            };
            let timestamp = Utc::now().to_rfc3339();
            let mut update = input.metadata.clone();
            for tag in &input.new_tags {
                let id = self
                    .upsert_file_tag_by_label(project_id, &tag.label, &tag.color_key, &timestamp)
                    .map_err(|_| {
                        AgentError::new(ErrorCode::InvalidArgument, "Invalid new Record tag")
                    })?;
                if !update.tag_ids.contains(&id) {
                    update.tag_ids.push(id);
                }
            }
            self.record_metadata_transaction(tx, &update, workspace_id)
        })
    }
    pub(crate) fn record_metadata_tags(
        &self,
        target: &RecordTarget,
        ids: &[i64],
    ) -> AgentResult<Vec<crate::models::DocumentTagRecord>> {
        source(&self.conn, target)?;
        let project_id = match target.scope {
            Scope::Workspace => None,
            Scope::Project { project_id } => Some(project_id),
        };
        ids.iter()
            .map(|id| {
                let tag = self.scoped_file_tag_record(project_id, *id).map_err(|_| {
                    AgentError::new(ErrorCode::ScopeDenied, "Record tag is outside this scope")
                })?;
                Ok(crate::models::DocumentTagRecord {
                    id: tag.id,
                    label: tag.label,
                    color_key: tag.color_key,
                })
            })
            .collect()
    }
    pub(super) fn require_legacy_record_write(&self, target: &RecordTarget) -> anyhow::Result<()> {
        source(&self.conn, target).map_err(|error| anyhow::anyhow!(error.message))?;
        let initialized: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM record_document_heads WHERE record_key=?1)",
            [target
                .key()
                .map_err(|error| anyhow::anyhow!(error.message))?],
            |row| row.get(0),
        )?;
        if initialized {
            anyhow::bail!("Record 正文已启用版本控制，请通过正文保存接口提交；旧保存请求未写入");
        }
        Ok(())
    }
    /// The trusted GUI hydrates managed assets to local paths for rendering.
    /// Strip that presentation layer before the utility process sees the tree.
    pub(crate) fn record_document_from_gui(
        &self,
        target: &RecordTarget,
        document: &Value,
    ) -> AgentResult<Value> {
        source(&self.conn, target)?;
        self.record_document_scope_from_gui(&target.scope, document)
    }
    pub(crate) fn record_document_scope_from_gui(
        &self,
        scope: &Scope,
        document: &Value,
    ) -> AgentResult<Value> {
        scope.validate()?;
        if serde_json::to_vec(document)
            .map_err(|_| invalid("Invalid editor document"))?
            .len()
            > 1024 * 1024
        {
            return Err(invalid("Record document exceeds size limit"));
        }
        let project_root = match *scope {
            Scope::Project { project_id } => Some(
                self.project_root_path(project_id)
                    .map_err(|_| AgentError::new(ErrorCode::NotFound, "Project is missing"))?,
            ),
            Scope::Workspace => None,
        };
        if project_root
            .as_ref()
            .is_some_and(|path| !path.starts_with(&self.workspace_root))
        {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Project is outside the Workspace",
            ));
        }
        fn visit(
            node: &mut Value,
            root: &std::path::Path,
            project: Option<&std::path::Path>,
            depth: usize,
            count: &mut usize,
        ) -> AgentResult<()> {
            *count += 1;
            if depth > 64 || *count > 50_000 {
                return Err(invalid("Record document exceeds tree limits"));
            }
            let image = node.get("type").and_then(Value::as_str) == Some("image");
            let attachment = node.get("type").and_then(Value::as_str) == Some("attachment");
            if image || attachment {
                if let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut) {
                    if let Some(path) = attrs
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|path| !path.is_empty())
                    {
                        let local = std::path::Path::new(path);
                        let relative = if local.is_absolute() {
                            local
                                .strip_prefix(root)
                                .map_err(|_| {
                                    AgentError::new(
                                        ErrorCode::ScopeDenied,
                                        "Editor asset is outside the Workspace",
                                    )
                                })?
                                .to_string_lossy()
                                .replace(std::path::MAIN_SEPARATOR, "/")
                        } else {
                            path.to_string()
                        };
                        if !relative_asset(&relative) {
                            return Err(invalid("Invalid managed editor asset path"));
                        }
                        if project.is_some_and(|project| !root.join(&relative).starts_with(project))
                        {
                            return Err(AgentError::new(
                                ErrorCode::ScopeDenied,
                                "Editor asset is outside this Project",
                            ));
                        }
                        attrs.insert("path".into(), json!(relative));
                        attrs.insert(if image { "src" } else { "href" }.into(), Value::Null);
                    }
                }
            }
            if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
                for child in children {
                    visit(child, root, project, depth + 1, count)?;
                }
            }
            Ok(())
        }
        let mut portable = document.clone();
        visit(
            &mut portable,
            &self.workspace_root,
            project_root.as_deref(),
            0,
            &mut 0,
        )?;
        self.record_validate_assets(scope, &portable)?;
        validate_references(
            &self.conn,
            scope,
            &portable,
            &reference_identities(&portable)?,
            self.native_workspace_id.as_deref().unwrap_or("preflight"),
        )?;
        Ok(portable)
    }
    pub(super) fn ensure_record_document_schema(&mut self) -> anyhow::Result<()> {
        let savepoint = self.conn.savepoint()?;
        savepoint.execute_batch(include_str!("record_documents.sql"))?;
        let version: i64 = savepoint.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < super::RECORD_DOCUMENT_SCHEMA_VERSION {
            savepoint.pragma_update(None, "user_version", super::RECORD_DOCUMENT_SCHEMA_VERSION)?;
        }
        savepoint.commit()?;
        Ok(())
    }
    pub(crate) fn record_document_source(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<RecordLegacySource> {
        source(&self.conn, target)
    }
    pub(crate) fn record_document_head(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<Option<RecordDocumentHead>> {
        source(&self.conn, target)?;
        head_unchecked(&self.conn, target)
    }
    pub(crate) fn record_patch_prepare(
        &self,
        caller: &str,
        patch: &crate::agent::outputs::RecordPatch,
    ) -> AgentResult<RecordPatchPreparation> {
        let target = record_patch_target(patch)?;
        source(&self.conn, &target)?;
        if let Some(previous) =
            self.agent_operation_replay(caller, &patch.request_id, "record.patch", patch)?
        {
            return Ok(RecordPatchPreparation::Replay(previous));
        }
        Ok(RecordPatchPreparation::Base(checked_patch_base(&self.conn, patch)?))
    }
    pub(crate) fn record_patch_preview_base(
        &self,
        patch: &crate::agent::outputs::RecordPatch,
    ) -> AgentResult<RecordDocumentHead> {
        source(&self.conn, &record_patch_target(patch)?)?;
        checked_patch_base(&self.conn, patch)
    }
    pub(crate) fn record_patch_preview_validate(
        &self,
        patch: &crate::agent::outputs::RecordPatch,
        projection: &RecordDocumentProjection,
        metadata: &RecordPatchMetadata,
    ) -> AgentResult<()> {
        let target = record_patch_target(patch)?;
        source(&self.conn, &target)?;
        let current = checked_patch_base(&self.conn, patch)?;
        self.record_compatibility_html(&target, projection)?;
        validate_patch_projection(&current, projection, metadata)?;
        validate_references(
            &self.conn, &target.scope, &projection.document,
            &reference_identities(&current.projection.document)?, &patch.record.workspace_id,
        )?;
        Ok(())
    }
    pub(crate) fn record_patch_commit(
        &self,
        caller: &str,
        patch: &crate::agent::outputs::RecordPatch,
        projection: &RecordDocumentProjection,
        metadata: &RecordPatchMetadata,
        workspace_id: &str,
    ) -> AgentResult<RecordPatchResult> {
        let target = record_patch_target(patch)?;
        let compatibility = self.record_compatibility_html(&target, projection)?;
        // Receipt identity uses original intent, not randomly allocated worker IDs.
        self.agent_atomic_operation(caller, &patch.request_id, "record.patch", patch, |tx| {
            source(tx, &target)?;
            let current = checked_patch_base(tx, patch)?;
            validate_patch_projection(&current, projection, metadata)?;
            let operation_id = random_id();
            let commit = RecordDocumentCommit {
                target: target.clone(),
                base_revision: patch.base_revision,
                projection: projection.clone(),
                origin: RecordVersionOrigin::Agent,
                actor: json!({"kind":"agent","caller":caller}),
                edit_session_id: None,
            };
            let (saved, change) = Self::record_commit_transaction(
                tx,
                &operation_id,
                &commit,
                &compatibility,
                None,
                workspace_id,
            )?;
            let receipt = crate::agent::outputs::OperationReceipt {
                operation_id,
                request_id: patch.request_id.clone(),
                object: patch.record.clone(),
                result_revision: saved.head.body_hash.clone(),
                file_version: None,
                undo_available: !saved.no_change,
            };
            Ok((
                RecordPatchResult {
                    before_revision: patch.base_revision,
                    after_revision: saved.head.head_revision,
                    created_block_ids: metadata.created_block_ids.clone(),
                    deleted_block_ids: metadata.deleted_block_ids.clone(),
                    normalizations: metadata.normalizations.clone(),
                    before_version: saved.before_version,
                    after_version: saved.after_version,
                    changed_refs: if saved.no_change {
                        vec![]
                    } else {
                        vec![patch.record.clone()]
                    },
                    receipt,
                    no_change: saved.no_change,
                    head: saved.head,
                },
                change,
            ))
        })
    }
    /// Run only while holding the current Workspace database lock. Each Record
    /// remains independently atomic; a damaged snapshot is never overwritten.
    pub(crate) fn record_seal_pending_checkpoints(
        &self,
        recovery: bool,
        workspace_id: &str,
    ) -> AgentResult<u32> {
        self.record_seal_checkpoints(
            if recovery {
                RecordCheckpointReason::Recovery
            } else {
                RecordCheckpointReason::Due
            },
            workspace_id,
        )
    }

    pub(crate) fn record_seal_checkpoints(
        &self,
        reason: RecordCheckpointReason,
        workspace_id: &str,
    ) -> AgentResult<u32> {
        let mut sealed = 0;
        loop {
            let pending = self
                .record_pending_checkpoints(!matches!(reason, RecordCheckpointReason::Due), 100)?;
            let count = pending.len();
            for mut input in pending {
                input.reason = reason.clone();
                let request_id = format!("{:032x}", rand::random::<u128>());
                let result = self.record_document_checkpoint(
                    "system:record-checkpoints",
                    &request_id,
                    &input,
                    workspace_id,
                )?;
                if result.checkpointed {
                    sealed += 1;
                }
            }
            if count < 100 {
                return Ok(sealed);
            }
        }
    }

    pub(crate) fn record_pending_checkpoints(
        &self,
        recovery: bool,
        limit: u32,
    ) -> AgentResult<Vec<RecordCheckpointInput>> {
        if !(1..=100).contains(&limit) {
            return Err(invalid("Invalid checkpoint batch size"));
        }
        let mut statement = self.conn.prepare("SELECT h.project_note_id,h.workspace_note_id,n.project_id,h.head_revision FROM record_document_heads h LEFT JOIN notes n ON n.id=h.project_note_id WHERE h.edit_session_id IS NOT NULL AND (?1 OR julianday(h.checkpoint_due_at)<=julianday(?2)) ORDER BY h.checkpoint_due_at,h.record_key LIMIT ?3").map_err(io_error)?;
        let rows = statement
            .query_map(params![recovery, Utc::now().to_rfc3339(), limit], |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(io_error)?;
        let mut pending = Vec::new();
        for row in rows {
            let (project_note, workspace_note, project_id, revision) = row.map_err(io_error)?;
            let target = match (project_note, workspace_note, project_id) {
                (Some(record_id), None, Some(project_id)) => RecordTarget {
                    scope: Scope::Project { project_id },
                    record_id,
                },
                (None, Some(record_id), None) => RecordTarget {
                    scope: Scope::Workspace,
                    record_id,
                },
                _ => return Err(damaged()),
            };
            pending.push(RecordCheckpointInput {
                target,
                base_revision: revision as u64,
                reason: if recovery {
                    RecordCheckpointReason::Recovery
                } else {
                    RecordCheckpointReason::Due
                },
            });
        }
        Ok(pending)
    }
    pub(crate) fn record_versions_list(
        &self,
        target: &RecordTarget,
        before: Option<u64>,
        limit: u32,
    ) -> AgentResult<RecordVersionPage> {
        source_unchecked(&self.conn, target)?;
        if !(1..=100).contains(&limit)
            || before.is_some_and(|cursor| cursor == 0 || cursor > i64::MAX as u64)
        {
            return Err(invalid("Invalid Record version pagination"));
        }
        let mut statement = self.conn.prepare("SELECT id,version_number,head_revision,title_snapshot,body_hash,origin,created_at FROM record_versions WHERE record_key=?1 AND (?2 IS NULL OR version_number<?2) ORDER BY version_number DESC LIMIT ?3").map_err(io_error)?;
        let rows = statement
            .query_map(
                params![target.key()?, before.map(|cursor| cursor as i64), limit + 1],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .map_err(io_error)?;
        let mut versions = Vec::new();
        for row in rows {
            let value = row.map_err(io_error)?;
            versions.push(RecordVersionSummary {
                id: value.0,
                version_number: value.1 as u64,
                head_revision: value.2 as u64,
                title_snapshot: value.3,
                body_hash: value.4,
                origin: parse_origin(value.5)?,
                created_at: value.6,
            });
        }
        let more = versions.len() > limit as usize;
        versions.truncate(limit as usize);
        let next_before = if more {
            versions.last().map(|version| version.version_number)
        } else {
            None
        };
        Ok(RecordVersionPage {
            versions,
            next_before,
        })
    }
    pub(crate) fn record_version_get(
        &self,
        target: &RecordTarget,
        id: &str,
    ) -> AgentResult<RecordVersion> {
        source_unchecked(&self.conn, target)?;
        version(&self.conn, target, id)
    }
    pub(crate) fn record_version_capacity(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<RecordVersionCapacity> {
        source_unchecked(&self.conn, target)?;
        let key = target.key()?;
        let (version_count,snapshot_bytes): (i64,i64) = self.conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(document_snapshot AS BLOB))+length(CAST(html AS BLOB))+length(CAST(markdown AS BLOB))+length(CAST(text AS BLOB))),0) FROM record_versions WHERE record_key=?1", [&key], |row|Ok((row.get(0)?,row.get(1)?))).map_err(io_error)?;
        let retained_asset_count: i64 = self.conn.query_row("SELECT count(DISTINCT asset_ref) FROM record_version_assets JOIN record_versions ON record_versions.id=version_id WHERE record_key=?1", [&key], |row|row.get(0)).map_err(io_error)?;
        let project_id = match target.scope {
            Scope::Workspace => None,
            Scope::Project { project_id } => Some(project_id),
        };
        let (receipt_count,receipt_bytes): (i64,i64) = self.conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(result_json AS BLOB))),0) FROM agent_operation_receipts WHERE operation LIKE 'record.%' AND state='committed' AND COALESCE(json_extract(result_json,'$.head.target.recordId'),json_extract(result_json,'$.target.recordId'))=?1 AND COALESCE(json_extract(result_json,'$.head.target.scope.kind'),json_extract(result_json,'$.target.scope.kind'))=?2 AND COALESCE(json_extract(result_json,'$.head.target.scope.projectId'),json_extract(result_json,'$.target.scope.projectId')) IS ?3", params![target.record_id,if project_id.is_some() {"project"} else {"workspace"},project_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(io_error)?;
        Ok(RecordVersionCapacity {
            version_count: version_count as u64,
            snapshot_bytes: snapshot_bytes as u64,
            retained_asset_count: retained_asset_count as u64,
            receipt_count: receipt_count as u64,
            receipt_bytes: receipt_bytes as u64,
        })
    }
    pub(crate) fn record_document_checkpoint(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordCheckpointInput,
        workspace_id: &str,
    ) -> AgentResult<RecordCheckpointResult> {
        if input.base_revision == 0 || input.base_revision > i64::MAX as u64 {
            return Err(invalid("Invalid checkpoint revision"));
        }
        self.agent_atomic_operation(caller,request_id,"record.document.checkpoint",input,|tx| {
            let current_source = source(tx,&input.target)?;
            let current = head_unchecked(tx,&input.target)?.ok_or_else(||AgentError::new(ErrorCode::SourceNotReady,"Initialize the Record document first"))?;
            if current.head_revision != input.base_revision { return Err(conflict(&current)); }
            let due = current.checkpoint_due_at.as_deref().map(chrono::DateTime::parse_from_rfc3339).transpose().map_err(|_|damaged())?;
            if current.edit_session_id.is_none() || (matches!(input.reason,RecordCheckpointReason::Due) && due.is_none_or(|due|due > Utc::now())) {
                return Ok((RecordCheckpointResult{head:(&current).into(),version_id:None,checkpointed:false},None));
            }
            let id = snapshot(tx,&current,&current_source.title,&RecordVersionOrigin::Manual,&json!({"kind":"gui","checkpointReason":input.reason}),request_id,None)?;
            tx.execute("UPDATE record_document_heads SET edit_session_id=NULL,edit_started_at=NULL,checkpoint_due_at=NULL WHERE record_key=?1", [input.target.key()?]).map_err(io_error)?;
            let updated = head_unchecked(tx,&input.target)?.ok_or_else(damaged)?;
            Ok((RecordCheckpointResult{head:(&updated).into(),version_id:Some(id),checkpointed:true},Some(OperationChange{object_key:input.target.object_key(workspace_id)?,scope:input.target.scope.clone(),revision:current.projection.body_hash})))
        })
    }
    pub(crate) fn record_version_restore(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordRestoreInput,
        workspace_id: &str,
    ) -> AgentResult<RecordCommitResult> {
        let historic = self.record_version_get(&input.target, &input.version_id)?;
        self.record_version_restore_projection(
            caller,
            request_id,
            input,
            &historic.projection,
            workspace_id,
        )
    }
    pub(crate) fn record_version_restore_projection(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordRestoreInput,
        projection: &RecordDocumentProjection,
        workspace_id: &str,
    ) -> AgentResult<RecordCommitResult> {
        if input.base_revision == 0 || input.base_revision > i64::MAX as u64 {
            return Err(invalid("Invalid restore revision"));
        }
        let historic = self.record_version_get(&input.target, &input.version_id)?;
        projection.validate()?;
        if historic.projection.body_hash != projection.body_hash {
            return Err(invalid(
                "Restored projection differs from the historic document",
            ));
        }
        let compatibility = self.record_compatibility_html(&input.target, projection)?;
        self.agent_atomic_operation(caller, request_id, "record.version.restore", input, |tx| {
            let historic = version(tx, &input.target, &input.version_id)?;
            if historic.projection.body_hash != projection.body_hash {
                return Err(invalid("Historic document changed during restore"));
            }
            let commit = RecordDocumentCommit {
                target: input.target.clone(),
                base_revision: input.base_revision,
                projection: projection.clone(),
                origin: RecordVersionOrigin::Restore,
                actor: json!({"kind":"restore","caller":caller}),
                edit_session_id: None,
            };
            Self::record_commit_transaction(
                tx,
                request_id,
                &commit,
                &compatibility,
                Some(&input.version_id),
                workspace_id,
            )
        })
    }
    fn record_validate_assets(&self, scope: &Scope, document: &Value) -> AgentResult<()> {
        let mut statement = self
            .conn
            .prepare("SELECT id,root_path FROM projects")
            .map_err(io_error)?;
        let roots = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        let roots: Vec<_> = roots
            .into_iter()
            .map(|(id, path)| (id, self.decode_path_ref(&path)))
            .collect();
        let project_root = match *scope {
            Scope::Project { project_id } => Some(
                self.project_root_path(project_id)
                    .map_err(|_| AgentError::new(ErrorCode::NotFound, "Project is missing"))?,
            ),
            Scope::Workspace => None,
        };
        fn visit(
            database: &Database,
            scope: &Scope,
            project_root: Option<&std::path::Path>,
            project_roots: &[(i64, std::path::PathBuf)],
            node: &Value,
        ) -> AgentResult<()> {
            if matches!(
                node.get("type").and_then(Value::as_str),
                Some("image" | "attachment")
            ) {
                if node
                    .pointer("/attrs/documentId")
                    .is_some_and(|id| !id.is_null())
                    && node
                        .pointer("/attrs/path")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return Err(invalid(
                        "Managed document references require a retained asset path",
                    ));
                }
                if let Some(relative) = node.pointer("/attrs/path").and_then(Value::as_str) {
                    if !relative_asset(relative) {
                        return Err(invalid("Invalid retained asset path"));
                    }
                    let local = database.workspace_root.join(relative);
                    let nearest_depth = project_roots
                        .iter()
                        .filter(|(_, root)| local.starts_with(root))
                        .map(|(_, root)| root.components().count())
                        .max();
                    if project_roots.iter().any(|(id, root)| {
                        local.starts_with(root)
                            && Some(root.components().count()) == nearest_depth
                            && *scope != (Scope::Project { project_id: *id })
                    }) {
                        return Err(AgentError::new(
                            ErrorCode::ScopeDenied,
                            "Record asset belongs to another Project resource root",
                        ));
                    }
                    let allowed = if let Some(root) = project_root {
                        let within = local.strip_prefix(root).map_err(|_| {
                            AgentError::new(
                                ErrorCode::ScopeDenied,
                                "Record asset is outside this Project",
                            )
                        })?;
                        // Legacy Project assets remain portable. Private Workspace/
                        // Project state can never be exposed as a managed attachment.
                        !within
                            .components()
                            .any(|part| part.as_os_str() == super::WORKSPACE_HIDDEN_DIR_NAME)
                            || within.starts_with(
                                std::path::Path::new(super::WORKSPACE_HIDDEN_DIR_NAME)
                                    .join(super::PROJECT_NOTE_ASSET_DIR_NAME)
                                    .join("project"),
                            )
                    } else {
                        std::path::Path::new(relative).starts_with("assets")
                            || std::path::Path::new(relative).starts_with(
                                std::path::Path::new(super::WORKSPACE_HIDDEN_DIR_NAME)
                                    .join(super::PROJECT_NOTE_ASSET_DIR_NAME)
                                    .join("workspace"),
                            )
                    };
                    if !allowed {
                        return Err(AgentError::new(
                            ErrorCode::ScopeDenied,
                            "Record asset is outside its managed resource scope",
                        ));
                    }
                    let mut component = database.workspace_root.clone();
                    for part in std::path::Path::new(relative).components() {
                        component.push(part);
                        match std::fs::symlink_metadata(&component) {
                            Ok(info) if info.file_type().is_symlink() => {
                                return Err(AgentError::new(
                                    ErrorCode::ScopeDenied,
                                    "Record asset contains a symbolic link",
                                ))
                            }
                            Ok(_) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                            Err(_) => {
                                return Err(AgentError::new(
                                    ErrorCode::IoFailed,
                                    "Cannot inspect Record asset",
                                ))
                            }
                        }
                    }
                    if let Some(id) = node
                        .pointer("/attrs/documentId")
                        .filter(|value| !value.is_null())
                    {
                        let id = positive_object_id(id)
                            .ok_or_else(|| invalid("Invalid managed document ID"))?
                            as i64;
                        let owner = database
                            .conn
                            .query_row(
                                "SELECT project_id,managed_path FROM documents WHERE id=?1",
                                [id],
                                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                            )
                            .optional()
                            .map_err(io_error)?;
                        if let Some((owner, path)) = owner {
                            if *scope != (Scope::Project { project_id: owner }) {
                                return Err(AgentError::new(
                                    ErrorCode::ScopeDenied,
                                    "Managed document belongs to another scope",
                                ));
                            }
                            let current = database.decode_path_ref(&path) == local;
                            let mut statement = database.conn.prepare("SELECT managed_path FROM document_versions WHERE document_id=?1").map_err(io_error)?;
                            let versions = statement
                                .query_map([id], |row| row.get::<_, String>(0))
                                .map_err(io_error)?
                                .collect::<Result<Vec<_>, _>>()
                                .map_err(io_error)?;
                            if !current
                                && !versions
                                    .iter()
                                    .any(|path| database.decode_path_ref(path) == local)
                            {
                                return Err(AgentError::new(
                                    ErrorCode::ScopeDenied,
                                    "Managed document path differs from its retained versions",
                                ));
                            }
                        }
                        // An explicitly deleted File may still occur in an immutable
                        // Record version. Keep its reference so the UI shows missing
                        // source; restoring a Record never recreates that File.
                    }
                }
            }
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    visit(database, scope, project_root, project_roots, child)?;
                }
            }
            Ok(())
        }
        visit(self, scope, project_root.as_deref(), &roots, document)
    }

    pub(super) fn record_compatibility_html(
        &self,
        target: &RecordTarget,
        projection: &RecordDocumentProjection,
    ) -> AgentResult<String> {
        let assets = projection.validate()?;
        self.record_validate_assets(&target.scope, &projection.document)?;
        if let Scope::Project { project_id } = target.scope {
            let root = self
                .project_root_path(project_id)
                .map_err(|_| AgentError::new(ErrorCode::NotFound, "Project is missing"))?;
            for asset in &assets {
                if !self.workspace_root.join(asset).starts_with(&root) {
                    return Err(AgentError::new(
                        ErrorCode::ScopeDenied,
                        "Record asset is outside this Project",
                    ));
                }
            }
        }
        // Compatibility HTML retains the existing per-Project path convention.
        // Only managed path attributes are projected; user text is never replaced.
        let hydrated = super::rewrite_html_tags(&projection.html, |tag| {
            let Some(raw) = super::html_attribute_value(tag, "data-path") else {
                return tag.to_string();
            };
            let relative = super::unescape_html_attribute(&raw);
            if !assets.contains(&relative) {
                return tag.to_string();
            }
            super::replace_html_attribute_value(
                tag,
                "data-path",
                &super::escape_html_attribute(
                    &self.workspace_root.join(relative).to_string_lossy(),
                ),
            )
        });
        Ok(match target.scope {
            Scope::Project { project_id } => self
                .persist_project_rich_text_html(project_id, &hydrated)
                .map_err(|_| {
                    AgentError::new(ErrorCode::IoFailed, "Cannot project Record assets")
                })?,
            Scope::Workspace => self.persist_workspace_rich_text_html(&hydrated),
        })
    }
    fn record_write_projection(
        tx: &Transaction<'_>,
        target: &RecordTarget,
        projection: &RecordDocumentProjection,
        html: &str,
        workspace_id: &str,
    ) -> AgentResult<()> {
        write_reference_edges(tx, target, &projection.document, workspace_id)?;
        let timestamp = Utc::now().to_rfc3339();
        let affected = match target.scope {
            Scope::Workspace => tx.execute("UPDATE workspace_notes SET content_html=?1,content_markdown=?2,default_code_language=?3,updated_at=?4 WHERE id=?5 AND note_kind='workspace_note'", params![html,projection.markdown,projection.code_language,timestamp,target.record_id]),
            Scope::Project { project_id } => {
                let affected = tx.execute("UPDATE notes SET content_html=?1,content_markdown=?2,default_code_language=?3,updated_at=?4 WHERE id=?5 AND project_id=?6", params![html,projection.markdown,projection.code_language,timestamp,target.record_id,project_id]);
                tx.execute("UPDATE projects SET updated_at=?1 WHERE id=?2",params![timestamp,project_id]).map_err(io_error)?;
                affected
            }
        }.map_err(io_error)?;
        if affected != 1 {
            return Err(AgentError::new(ErrorCode::NotFound, "Record is missing"));
        }
        Ok(())
    }
    pub(crate) fn record_document_initialize(
        &self,
        caller: &str,
        request_id: &str,
        target: &RecordTarget,
        expected_source_hash: &str,
        projection: &RecordDocumentProjection,
        workspace_id: &str,
    ) -> AgentResult<RecordCommittedHead> {
        let compatibility = self.record_compatibility_html(target, projection)?;
        self.agent_atomic_operation(caller,request_id,"record.document.initialize", &(target,expected_source_hash,projection), |tx| {
            let current_source = source(tx,target)?;
            if let Some(current) = head_unchecked(tx,target)? { return Ok((RecordCommittedHead::from(&current),None)); }
            if current_source.source_hash != expected_source_hash { return Err(AgentError::new(ErrorCode::RevisionConflict,"Legacy Record changed before baseline conversion")); }
            let (project,workspace) = match target.scope { Scope::Workspace => (None,Some(target.record_id)),Scope::Project { .. } => (Some(target.record_id),None) };
            tx.execute("INSERT INTO record_document_heads(record_key,project_note_id,workspace_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,code_language,updated_at) VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11)",params![target.key()?,project,workspace,projection.document.to_string(),projection.html,projection.markdown,projection.text,projection.body_hash,projection.schema_version,projection.code_language,Utc::now().to_rfc3339()]).map_err(io_error)?;
            Self::record_write_projection(tx,target,projection,&compatibility, workspace_id)?;
            let initial = head_unchecked(tx,target)?.ok_or_else(|| AgentError::new(ErrorCode::IoFailed,"Cannot read new Record head"))?;
            snapshot(tx,&initial,&current_source.title,&RecordVersionOrigin::Baseline,&json!({"kind":"gui"}),request_id,None)?;
            Ok((RecordCommittedHead::from(&initial),Some(OperationChange{object_key:target.object_key(workspace_id)?,scope:target.scope.clone(),revision:projection.body_hash.clone()})))
        })
    }
    pub(crate) fn record_document_commit(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordDocumentCommit,
        workspace_id: &str,
    ) -> AgentResult<RecordCommitResult> {
        self.record_document_commit_intent(caller, request_id, input, input, None, workspace_id)
    }
    pub(crate) fn record_document_commit_intent(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordDocumentCommit,
        intent: &impl serde::Serialize,
        metadata: Option<&RecordMetadataUpdate>,
        workspace_id: &str,
    ) -> AgentResult<RecordCommitResult> {
        if input.base_revision == 0
            || input.base_revision > i64::MAX as u64
            || !input.actor.is_object()
            || input.actor.to_string().len() > 1024
            || matches!(
                input.origin,
                RecordVersionOrigin::Baseline | RecordVersionOrigin::Restore
            )
        {
            return Err(invalid("Invalid Record commit metadata"));
        }
        let manual = matches!(input.origin, RecordVersionOrigin::Manual);
        if manual
            && input.edit_session_id.as_deref().is_none_or(|id| {
                id.len() != 32
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
        {
            return Err(invalid("Manual commit requires an edit session ID"));
        }
        let compatibility = self.record_compatibility_html(&input.target, &input.projection)?;
        if let Some(metadata) = metadata {
            if metadata.target.key()? != input.target.key()? {
                return Err(invalid("Metadata target differs from the body target"));
            }
        }
        self.agent_atomic_operation(caller, request_id, "record.document.commit", intent, |tx| {
            let (saved_metadata, metadata_change) = match metadata {
                Some(metadata) => {
                    let (saved, change) =
                        self.record_metadata_transaction(tx, metadata, workspace_id)?;
                    (Some(saved), change)
                }
                None => (None, None),
            };
            let (mut saved, body_change) = Self::record_commit_transaction(
                tx,
                request_id,
                input,
                &compatibility,
                None,
                workspace_id,
            )?;
            saved.metadata = saved_metadata;
            Ok((saved, body_change.or(metadata_change)))
        })
    }
    pub(super) fn record_commit_transaction(
        tx: &Transaction<'_>,
        request_id: &str,
        input: &RecordDocumentCommit,
        compatibility: &str,
        restored_from: Option<&str>,
        workspace_id: &str,
    ) -> AgentResult<(RecordCommitResult, Option<OperationChange>)> {
        let manual = matches!(input.origin, RecordVersionOrigin::Manual);
        let current_source = source(tx, &input.target)?;
        let current = head_unchecked(tx, &input.target)?.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Initialize the Record document first",
            )
        })?;
        if current.head_revision != input.base_revision {
            return Err(conflict(&current));
        }
        let mut retained = reference_identities(&current.projection.document)?;
        if let Some(id) = restored_from {
            retained.extend(reference_identities(
                &version(tx, &input.target, id)?.projection.document,
            )?);
        }
        validate_references(
            tx,
            &input.target.scope,
            &input.projection.document,
            &retained,
            workspace_id,
        )?;
        let latest_version: String = tx.query_row("SELECT id FROM record_versions WHERE record_key=?1 ORDER BY version_number DESC LIMIT 1", [input.target.key()?], |row| row.get(0)).map_err(io_error)?;
        if current.projection.body_hash == input.projection.body_hash {
            return Ok((
                RecordCommitResult {
                    head: (&current).into(),
                    no_change: true,
                    before_version: latest_version,
                    after_version: None,
                    metadata: None,
                },
                None,
            ));
        }
        let before_version = if manual && current.edit_session_id == input.edit_session_id {
            latest_version
        } else {
            snapshot(
                tx,
                &current,
                &current_source.title,
                &RecordVersionOrigin::Manual,
                &json!({"kind":"gui","editSessionId":current.edit_session_id,"checkpointReason":"action_boundary"}),
                request_id,
                None,
            )?
        };
        let revision = current
            .head_revision
            .checked_add(1)
            .filter(|revision| *revision <= i64::MAX as u64)
            .ok_or_else(|| invalid("Record revision overflow"))?;
        let now = Utc::now();
        let (session, started, due) = if manual {
            let started: Option<String> = tx
                .query_row(
                    "SELECT edit_started_at FROM record_document_heads WHERE record_key=?1",
                    [input.target.key()?],
                    |row| row.get(0),
                )
                .map_err(io_error)?;
            let start = if current.edit_session_id == input.edit_session_id {
                started
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
                    .map(|value| value.with_timezone(&Utc))
                    .unwrap_or(now)
            } else {
                now
            };
            (
                input.edit_session_id.clone(),
                Some(start.to_rfc3339()),
                Some(
                    std::cmp::min(now + Duration::seconds(30), start + Duration::seconds(60))
                        .to_rfc3339(),
                ),
            )
        } else {
            (None, None, None)
        };
        let p = &input.projection;
        tx.execute("UPDATE record_document_heads SET head_revision=?1,document_json=?2,html=?3,markdown=?4,text=?5,body_hash=?6,schema_version=?7,code_language=?8,edit_session_id=?9,edit_started_at=?10,checkpoint_due_at=?11,updated_at=?12 WHERE record_key=?13 AND head_revision=?14",params![revision as i64,p.document.to_string(),p.html,p.markdown,p.text,p.body_hash,p.schema_version,p.code_language,session,started,due,now.to_rfc3339(),input.target.key()?,input.base_revision as i64]).map_err(io_error)?;
        Self::record_write_projection(tx, &input.target, p, compatibility, workspace_id)?;
        let updated = head_unchecked(tx, &input.target)?.ok_or_else(|| {
            AgentError::new(ErrorCode::IoFailed, "Cannot read updated Record head")
        })?;
        let after_version = if manual {
            None
        } else {
            Some(snapshot(
                tx,
                &updated,
                &current_source.title,
                &input.origin,
                &input.actor,
                request_id,
                restored_from,
            )?)
        };
        Ok((
            RecordCommitResult {
                head: (&updated).into(),
                no_change: false,
                before_version,
                after_version,
                metadata: None,
            },
            Some(OperationChange {
                object_key: input.target.object_key(workspace_id)?,
                scope: input.target.scope.clone(),
                revision: p.body_hash.clone(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{errors::ErrorCode, models::Scope},
        models::WorkspaceRecordUpsertInput,
    };
    use serde_json::json;

    fn setup() -> (
        tempfile::TempDir,
        Database,
        RecordTarget,
        RecordDocumentProjection,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let mut database =
            Database::open(&directory.path().join("app.sqlite"), directory.path(), None).unwrap();
        let projection: RecordDocumentProjection =
            serde_json::from_str(include_str!("../record_document_projection.fixture.json"))
                .unwrap();
        let legacy = (1..=7).fold(projection.html.clone(), |html, number| {
            html.replace(
                &format!(" data-block-id=\"{}\"", number.to_string().repeat(32)),
                "",
            )
        });
        let record = database
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Original title".into()),
                html: legacy,
                markdown: projection.markdown.clone(),
                default_code_language: projection.code_language.clone(),
                tag_ids: vec![],
            })
            .unwrap();
        (
            directory,
            database,
            RecordTarget {
                scope: Scope::Workspace,
                record_id: record.id,
            },
            projection,
        )
    }
    #[test]
    fn preview_requires_existing_head_without_initializing_it() {
        let (_directory, database, target, _projection) = setup();
        let patch = crate::agent::outputs::RecordPatch {
            record: ObjectRef {
                workspace_id: "workspace-test".into(), scope: target.scope.clone(),
                kind: ObjectKind::Record, id: target.record_id.to_string(),
            },
            base_revision: 1, request_id: "preview-uninitialized".into(),
            operations: vec![crate::agent::outputs::BlockEdit::Append {
                parent_block_id: None, position: None,
                blocks: vec![serde_json::from_value(json!({"type":"paragraph","content":[{"type":"text","text":"new"}]})).unwrap()],
            }],
        };
        assert_eq!(database.record_patch_preview_base(&patch).unwrap_err().code, ErrorCode::SourceNotReady);
        assert!(database.record_document_head(&target).unwrap().is_none());
        let heads: i64 = database.conn.query_row("SELECT count(*) FROM record_document_heads", [], |row| row.get(0)).unwrap();
        assert_eq!(heads, 0);
    }
    #[test]
    fn preview_rejects_new_cross_project_reference_under_native_scope_rules() {
        let (_directory, mut database, _, _) = setup();
        let (own_project, own_record) = reference_target(&mut database, "Preview owner");
        let (_, foreign_record) = reference_target(&mut database, "Foreign reference");
        let target = RecordTarget { scope: Scope::Project { project_id: own_project }, record_id: own_record };
        let block_id = "a".repeat(32);
        let document = json!({"type":"doc","content":[{
            "type":"paragraph","attrs":{"blockId":block_id},
            "content":[{"type":"text","text":"Target"}]
        }]});
        let baseline = RecordDocumentProjection {
            schema_version: 1, body_hash: body_hash(&document, &None), document,
            html: format!("<p data-block-id=\"{block_id}\">Target</p>"),
            markdown: "Target".into(), text: "Target".into(), code_language: None,
        };
        database.record_document_initialize(
            "gui", "preview-baseline", &target,
            &database.record_document_source(&target).unwrap().source_hash,
            &baseline, "workspace-test",
        ).unwrap();
        let patch = crate::agent::outputs::RecordPatch {
            record: ObjectRef {
                workspace_id: "workspace-test".into(), scope: target.scope.clone(),
                kind: ObjectKind::Record, id: target.record_id.to_string(),
            },
            base_revision: 1, request_id: "preview-foreign-reference".into(),
            operations: vec![crate::agent::outputs::BlockEdit::AppendInline {
                block_id: block_id.clone(),
                expected_block_hash: record_block_hash(&baseline.document["content"][0]).unwrap(),
                text: " x".into(),
            }],
        };
        database.record_patch_preview_base(&patch).unwrap();
        let mut converted = baseline.clone();
        converted.document["content"][0]["content"] = json!([{
            "type":"internalReference","attrs":{"refKind":"note","refId":foreign_record,"label":"Foreign"}
        }]);
        converted.body_hash = body_hash(&converted.document, &converted.code_language);
        converted.html = format!("<p data-block-id=\"{block_id}\">Foreign</p>");
        converted.markdown = "Foreign".into();
        converted.text = "Foreign".into();
        let metadata = RecordPatchMetadata {
            created_block_ids: vec![], deleted_block_ids: vec![],
            normalizations: vec![], no_change: false,
        };
        assert_eq!(database.record_patch_preview_validate(&patch, &converted, &metadata).unwrap_err().code, ErrorCode::ScopeDenied);
        assert_eq!(database.record_document_head(&target).unwrap().unwrap().head_revision, 1);
    }
    #[test]
    fn record_workspace_reference_keeps_colliding_project_identity_and_scope_rules() {
        let (_directory, mut database, target, mut projection) = setup();
        let (project, project_record) = reference_target(&mut database, "Project target");
        assert_eq!(
            project_record, target.record_id,
            "fixture must exercise colliding business IDs"
        );
        projection.document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"internalReference","attrs":{"refKind":"workspace_record","refId":target.record_id,"label":"个人方法"}},{"type":"text","text":" 和 "},{"type":"internalReference","attrs":{"refKind":"note","refId":project_record,"label":"项目资料"}}]}]});
        projection.code_language = None;
        projection.body_hash = body_hash(&projection.document, &None);
        projection.markdown = format!(
            "[[workspace_record:{}|个人方法]] 和 [[note:{}|项目资料]]",
            target.record_id, project_record
        );
        projection.text = "个人方法 和 项目资料".into();
        projection.html=format!("<p data-block-id=\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"><span data-type=\"internal-reference\" data-ref-kind=\"workspace_record\" data-ref-id=\"{}\" data-label=\"个人方法\">个人方法</span> 和 <span data-type=\"internal-reference\" data-ref-kind=\"note\" data-ref-id=\"{}\" data-label=\"项目资料\">项目资料</span></p>",target.record_id,project_record);
        projection.validate().unwrap();
        database
            .record_document_scope_from_gui(&Scope::Workspace, &projection.document)
            .unwrap();
        assert_eq!(
            database
                .record_document_scope_from_gui(
                    &Scope::Project {
                        project_id: project
                    },
                    &projection.document
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let legacy = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "workspace-reference-baseline",
                &target,
                &legacy.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let mut statement=database.conn.prepare("SELECT target_object_key FROM content_reference_edges WHERE source_object_key=?1 ORDER BY target_object_key").unwrap();
        let edges: Vec<String> = statement
            .query_map([target.object_key("workspace-test").unwrap()], |row| {
                row.get(0)
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut expected = vec![
            format!("workspace-test/workspace/record/{}", target.record_id),
            format!("workspace-test/project:{project}/record/{project_record}"),
        ];
        expected.sort();
        assert_eq!(edges, expected);
    }
    #[test]
    fn quick_note_transfer_is_atomic_replayable_and_preserves_existing_block_ids() {
        let (_directory, mut database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        database
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "Captured".into(),
                html: "<p>Captured</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let quick = database.record_quick_note_source(&target.scope).unwrap();
        let input = RecordQuickNoteTransfer {
            scope: target.scope.clone(),
            record_id: Some(target.record_id),
            base_revision: Some(1),
            metadata_revision: Some(database.record_metadata_get(&target).unwrap().revision),
            expected_markdown: "Captured".into(),
            title: None,
            tag_ids: vec![],
        };
        let mut candidate = projection.clone();
        candidate.document["content"].as_array_mut().unwrap().push(json!({"type":"paragraph","attrs":{"blockId":"8".repeat(32)},"content":[{"type":"text","text":"Captured"}]}));
        candidate.html.push_str("<p>Captured</p>");
        candidate.markdown.push_str("\n\nCaptured");
        candidate.text.push_str("\n\nCaptured");
        candidate.body_hash = body_hash(&candidate.document, &candidate.code_language);
        let before_transfer = database.committed_change_watermark().unwrap();
        let saved = database
            .record_quick_note_transfer(
                "gui",
                "transfer",
                &input,
                &quick.source_hash,
                &candidate,
                None,
                "workspace-test",
            )
            .unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert!(database
            .workspace_quick_note_get()
            .unwrap()
            .unwrap()
            .content_markdown
            .is_empty());
        assert_eq!(
            database
                .record_document_head(&saved.head.target)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][0]["attrs"]["blockId"],
            projection.document["content"][0]["attrs"]["blockId"]
        );
        assert_eq!(version_count(&database), 2);
        assert_eq!(
            database.committed_change_watermark().unwrap(),
            before_transfer + 2
        );
        let replay = database
            .record_quick_note_transfer(
                "gui",
                "transfer",
                &input,
                &quick.source_hash,
                &candidate,
                None,
                "workspace-test",
            )
            .unwrap();
        assert_eq!(replay.head.head_revision, 2);
        assert_eq!(version_count(&database), 2);
        assert_eq!(
            database.committed_change_watermark().unwrap(),
            before_transfer + 2
        );
        let stale = database
            .record_quick_note_transfer(
                "gui",
                "stale",
                &input,
                &quick.source_hash,
                &candidate,
                None,
                "workspace-test",
            )
            .unwrap_err();
        assert_eq!(stale.code, ErrorCode::SourceChanged);
        assert_eq!(version_count(&database), 2);
    }
    #[test]
    fn quick_note_transfer_conflicts_leave_the_source_metadata_and_versions_untouched() {
        let (_directory, mut database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        database
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "Captured".into(),
                html: "<p>Captured</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let quick = database.record_quick_note_source(&target.scope).unwrap();
        let input = RecordQuickNoteTransfer {
            scope: target.scope.clone(),
            record_id: Some(target.record_id),
            base_revision: Some(2),
            metadata_revision: Some(database.record_metadata_get(&target).unwrap().revision),
            expected_markdown: "Captured".into(),
            title: Some("Must not replace title".into()),
            tag_ids: vec![],
        };
        let candidate = changed(&projection, "Appended");
        assert_eq!(
            database
                .record_quick_note_transfer(
                    "gui",
                    "stale-head",
                    &input,
                    &quick.source_hash,
                    &candidate,
                    None,
                    "workspace-test"
                )
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        assert_eq!(
            database
                .record_metadata_get(&target)
                .unwrap()
                .title
                .as_deref(),
            Some("Original title")
        );
        assert_eq!(
            database
                .workspace_quick_note_get()
                .unwrap()
                .unwrap()
                .content_markdown,
            "Captured"
        );
        assert_eq!(version_count(&database), 1);
        let mut fresh = input;
        fresh.base_revision = Some(1);
        database.conn.execute("UPDATE workspace_notes SET content_html='<h1>Changed presentation</h1>' WHERE id=?1",[quick.quick_note_id.unwrap()]).unwrap();
        assert_eq!(
            database
                .record_quick_note_transfer(
                    "gui",
                    "changed-source",
                    &fresh,
                    &quick.source_hash,
                    &candidate,
                    None,
                    "workspace-test"
                )
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
        assert_eq!(version_count(&database), 1);
    }

    #[test]
    fn quick_note_transfer_to_a_new_record_creates_baseline_and_action_versions_once() {
        let (_directory, mut database, _target, _projection) = setup();
        database
            .workspace_quick_note_upsert(crate::models::WorkspaceQuickNoteUpsertInput {
                markdown: "Captured".into(),
                html: "<p>Captured</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let quick = database
            .record_quick_note_source(&Scope::Workspace)
            .unwrap();
        fn paragraph(text: &str, id: &str) -> RecordDocumentProjection {
            let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":id},"content":if text.is_empty(){json!([])}else{json!([{"type":"text","text":text}])}}]});
            RecordDocumentProjection {
                schema_version: 1,
                body_hash: body_hash(&document, &None),
                document,
                html: format!("<p data-block-id=\"{id}\">{text}</p>"),
                markdown: text.into(),
                text: text.into(),
                code_language: None,
            }
        }
        let input = RecordQuickNoteTransfer {
            scope: Scope::Workspace,
            record_id: None,
            base_revision: None,
            metadata_revision: None,
            expected_markdown: "Captured".into(),
            title: Some("Saved idea".into()),
            tag_ids: vec![],
        };
        let candidate = paragraph("Captured", &"8".repeat(32));
        let empty = paragraph("", &"9".repeat(32));
        let saved = database
            .record_quick_note_transfer(
                "gui",
                "new-record",
                &input,
                &quick.source_hash,
                &candidate,
                Some(&empty),
                "workspace-test",
            )
            .unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert_eq!(
            saved.metadata.as_ref().unwrap().title.as_deref(),
            Some("Saved idea")
        );
        assert_eq!(version_count(&database), 2);
        let versions = database
            .record_versions_list(&saved.head.target, None, 10)
            .unwrap();
        assert_eq!(versions.versions[0].origin.key(), "quick_note");
        assert_eq!(versions.versions[1].origin.key(), "baseline");
        assert!(database
            .workspace_quick_note_get()
            .unwrap()
            .unwrap()
            .content_markdown
            .is_empty());
        let replay = database
            .record_quick_note_transfer(
                "gui",
                "new-record",
                &input,
                &quick.source_hash,
                &candidate,
                Some(&empty),
                "workspace-test",
            )
            .unwrap();
        assert_eq!(
            replay.head.target.key().unwrap(),
            saved.head.target.key().unwrap()
        );
        assert_eq!(version_count(&database), 2);
    }
    #[test]
    fn historic_gui_preview_hydrates_assets_without_modifying_portable_snapshot() {
        let (_directory, database, target, projection) = setup();
        let original = projection.document.clone();
        let html = database
            .record_version_editor_html(&target, &projection)
            .unwrap();
        assert!(html.contains(
            &database
                .workspace_root
                .join("assets/图片.png")
                .to_string_lossy()
                .to_string()
        ));
        assert!(html.contains("data-block-id"));
        assert_eq!(projection.document, original);
        assert!(!projection
            .html
            .contains(&database.workspace_root.to_string_lossy().to_string()));
    }
    #[test]
    fn record_assets_reject_private_state_and_preserve_owned_media() {
        let (_directory, database, target, projection) = setup();
        for path in [
            ".project-mind/workspace.sqlite",
            ".project-mind/tmp/request.json",
            "Other Project/image.png",
        ] {
            let mut candidate = projection.document.clone();
            candidate["content"][2]["attrs"]["path"] = json!(path);
            assert_eq!(
                database
                    .record_document_scope_from_gui(&target.scope, &candidate)
                    .unwrap_err()
                    .code,
                ErrorCode::ScopeDenied
            );
        }
        let mut candidate = projection.document.clone();
        candidate["content"][2]["attrs"]["path"] =
            json!(".project-mind/embedded-note-assets/workspace/image.png");
        assert!(database
            .record_document_scope_from_gui(&target.scope, &candidate)
            .is_ok());
    }
    #[test]
    fn record_managed_document_ids_must_match_scope_and_retained_file_paths() {
        let (_directory, mut database, _target, projection) = setup();
        let project = database
            .project_create(crate::models::ProjectCreateInput {
                name: "Owned assets".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let other = database
            .project_create(crate::models::ProjectCreateInput {
                name: "Other assets".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let source = database.workspace_root.join("sample.png");
        std::fs::write(&source, "managed-image").unwrap();
        let document = database
            .document_import(crate::models::DocumentImportInput {
                project_id: project.id,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let scope = Scope::Project {
            project_id: project.id,
        };
        let mut candidate =
            json!({"type":"doc","content":[projection.document["content"][2].clone()]});
        candidate["content"][0]["attrs"]["path"] = json!(document.managed_path);
        candidate["content"][0]["attrs"]["documentId"] = json!(document.id.to_string());
        assert!(database
            .record_document_scope_from_gui(&scope, &candidate)
            .is_ok());
        let mut remote = candidate.clone();
        remote["content"][0]["attrs"]["path"] = Value::Null;
        remote["content"][0]["attrs"]["src"] = json!("https://example.com/image.png");
        assert_eq!(
            database
                .record_document_scope_from_gui(&scope, &remote)
                .unwrap_err()
                .code,
            ErrorCode::InvalidPatch
        );
        assert_eq!(
            database
                .record_document_scope_from_gui(&Scope::Workspace, &candidate)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        candidate["content"][0]["attrs"]["path"] = json!(std::path::Path::new(&project.root_path)
            .join("invented.png")
            .to_string_lossy());
        assert_eq!(
            database
                .record_document_scope_from_gui(&scope, &candidate)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        candidate["content"][0]["attrs"]["path"] = json!(std::path::Path::new(&other.root_path)
            .join("invented.png")
            .to_string_lossy());
        assert_eq!(
            database
                .record_document_scope_from_gui(
                    &Scope::Project {
                        project_id: other.id
                    },
                    &candidate
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        candidate["content"][0]["attrs"]["path"] = json!(document.managed_path);
        database
            .conn
            .execute("DELETE FROM documents WHERE id=?1", [document.id])
            .unwrap();
        std::fs::remove_file(&document.managed_path).unwrap();
        // Retained references remain valid when the user explicitly deletes a
        // whole File, but the absent external source is never recreated.
        assert!(database
            .record_document_scope_from_gui(&scope, &candidate)
            .is_ok());
        assert!(!std::path::Path::new(&document.managed_path).exists());
    }
    #[cfg(unix)]
    #[test]
    fn record_assets_reject_symbolic_links_before_migration_and_gui_preview() {
        let (_directory, database, target, projection) = setup();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("图片.png"), "outside").unwrap();
        std::os::unix::fs::symlink(external.path(), database.workspace_root.join("assets"))
            .unwrap();
        assert_eq!(
            database
                .record_document_scope_from_gui(&target.scope, &projection.document)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let source = database.record_document_source(&target).unwrap();
        assert_eq!(
            database
                .record_document_initialize(
                    "gui",
                    "symlink",
                    &target,
                    &source.source_hash,
                    &projection,
                    "workspace-test"
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert!(database.record_document_head(&target).unwrap().is_none());
        assert_eq!(
            database
                .record_version_editor_html(&target, &projection)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    #[test]
    fn record_assets_cannot_hide_a_project_root_inside_legacy_workspace_assets() {
        let (_directory, mut database, target, projection) = setup();
        let (project, _) = reference_target(&mut database, "Overlapping resource root");
        database
            .conn
            .execute(
                "UPDATE projects SET root_path='workspace:assets/owned' WHERE id=?1",
                [project],
            )
            .unwrap();
        let mut candidate = projection.document.clone();
        candidate["content"][2]["attrs"]["path"] = json!("assets/owned/image.png");
        assert_eq!(
            database
                .record_document_scope_from_gui(&target.scope, &candidate)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert!(database
            .record_document_scope_from_gui(
                &Scope::Project {
                    project_id: project
                },
                &json!({"type":"doc","content":[candidate["content"][2].clone()]})
            )
            .is_ok());
    }
    #[test]
    fn removing_current_media_keeps_physical_assets_and_immutable_versions_restorable() {
        let (_directory, database, target, projection) = setup();
        std::fs::create_dir_all(database.workspace_root.join("assets")).unwrap();
        std::fs::write(
            database.workspace_root.join("assets/图片.png"),
            "retained-image",
        )
        .unwrap();
        std::fs::write(
            database.workspace_root.join("assets/文件.pdf"),
            "retained-file",
        )
        .unwrap();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline-media",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let baseline = database
            .record_versions_list(&target, None, 1)
            .unwrap()
            .versions[0]
            .id
            .clone();
        let document = json!({"type":"doc","content":[projection.document["content"][0].clone()]});
        let removed = RecordDocumentProjection {
            body_hash: body_hash(&document, &projection.code_language),
            document,
            html: format!(
                "<p data-block-id=\"{}\"><strong>Fixture 正文</strong></p>",
                "1".repeat(32)
            ),
            markdown: "**Fixture 正文**".into(),
            text: "Fixture 正文".into(),
            code_language: projection.code_language.clone(),
            schema_version: 1,
        };
        database
            .record_document_commit(
                "gui",
                "remove-media",
                &RecordDocumentCommit {
                    target: target.clone(),
                    base_revision: 1,
                    projection: removed,
                    origin: RecordVersionOrigin::EditorAi,
                    actor: json!({"kind":"gui"}),
                    edit_session_id: None,
                },
                "workspace-test",
            )
            .unwrap();
        assert_eq!(
            database
                .record_version_capacity(&target)
                .unwrap()
                .retained_asset_count,
            2
        );
        assert_eq!(
            std::fs::read_to_string(database.workspace_root.join("assets/图片.png")).unwrap(),
            "retained-image"
        );
        let stored = database.record_version_get(&target, &baseline).unwrap();
        assert_eq!(stored.projection.document, projection.document);
        database
            .record_version_restore(
                "gui",
                "restore-media",
                &RecordRestoreInput {
                    target: target.clone(),
                    base_revision: 2,
                    version_id: baseline.clone(),
                },
                "workspace-test",
            )
            .unwrap();
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .projection
                .document["content"][2]["attrs"]["blockId"],
            json!("6".repeat(32))
        );
        let unchanged = database
            .record_version_get(&target, &baseline)
            .unwrap()
            .projection;
        assert_eq!(
            serde_json::to_value(unchanged).unwrap(),
            serde_json::to_value(stored.projection).unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(database.workspace_root.join("assets/文件.pdf")).unwrap(),
            "retained-file"
        );
    }
    #[test]
    fn record_creation_is_atomic_and_replays_the_original_intent() {
        let (_directory, database, _target, projection) = setup();
        let mut input = RecordCreate {
            scope: Scope::Workspace,
            title: Some(" New record ".into()),
            tag_ids: vec![99999],
            document: projection.document.clone(),
            code_language: projection.code_language.clone(),
        };
        let count = || {
            database
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM workspace_notes WHERE note_kind='workspace_note'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        let before = count();
        assert_eq!(
            database
                .record_create("gui", "bad-create", &input, &projection, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(count(), before);
        input.tag_ids.clear();
        let created = database
            .record_create("gui", "create-1", &input, &projection, "workspace-test")
            .unwrap();
        let replay = database
            .record_create("gui", "create-1", &input, &projection, "workspace-test")
            .unwrap();
        assert_eq!(created.target.record_id, replay.target.record_id);
        assert_eq!(count(), before + 1);
        assert_eq!(created.head_revision, 1);
        assert_eq!(
            database
                .record_metadata_get(&created.target)
                .unwrap()
                .title
                .as_deref(),
            Some("New record")
        );
        assert_eq!(
            database
                .record_version_capacity(&created.target)
                .unwrap()
                .version_count,
            1
        );
        assert_eq!(
            database
                .record_document_source(&created.target)
                .unwrap()
                .markdown,
            projection.markdown
        );
        input.title = Some("Different intent".into());
        assert!(database
            .record_create("gui", "create-1", &input, &projection, "workspace-test")
            .is_err());
        assert_eq!(count(), before + 1);
    }
    #[test]
    fn ai_metadata_apply_rolls_back_new_tags_on_failure_and_replays_without_body_versions() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let baseline = database.record_metadata_get(&target).unwrap();
        let mut input = RecordMetadataApply {
            metadata: RecordMetadataUpdate {
                target: target.clone(),
                expected_revision: baseline.revision.clone(),
                title: Some("AI title".into()),
                tag_ids: vec![],
            },
            new_tags: vec![
                RecordMetadataNewTag {
                    label: "New tag".into(),
                    color_key: "blue".into(),
                },
                RecordMetadataNewTag {
                    label: "Bad tag".into(),
                    color_key: "invalid-color".into(),
                },
            ],
        };
        assert_eq!(
            database
                .record_metadata_apply("gui", "bad-ai", &input, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            database
                .conn
                .query_row("SELECT COUNT(*) FROM file_tag_options", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            database.record_metadata_get(&target).unwrap().revision,
            baseline.revision
        );
        input.new_tags.pop();
        let saved = database
            .record_metadata_apply("gui", "ai-1", &input, "workspace-test")
            .unwrap();
        let replay = database
            .record_metadata_apply("gui", "ai-1", &input, "workspace-test")
            .unwrap();
        assert_eq!(saved.revision, replay.revision);
        assert_eq!(saved.tag_ids.len(), 1);
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        assert_eq!(
            database
                .record_version_capacity(&target)
                .unwrap()
                .version_count,
            1
        );
        let tags = database
            .record_metadata_tags(&target, &saved.tag_ids)
            .unwrap();
        assert_eq!(tags[0].label, "New tag");
        assert_eq!(
            database
                .record_metadata_apply("gui", "stale-ai", &input, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
    }
    #[test]
    fn gui_document_paths_become_portable_without_replacing_user_text_or_block_ids() {
        let (_directory, database, target, projection) = setup();
        let mut input = projection.document.clone();
        let absolute = database
            .workspace_root
            .join("assets/图片.png")
            .to_string_lossy()
            .into_owned();
        input["content"][0]["content"][0]["text"] = json!(absolute);
        input["content"][2]["attrs"]["path"] = json!(absolute);
        input["content"][2]["attrs"]["src"] = json!("asset://transient-image-url");
        let result = database.record_document_from_gui(&target, &input).unwrap();
        assert_eq!(result["content"][2]["attrs"]["path"], "assets/图片.png");
        assert!(result["content"][2]["attrs"]["src"].is_null());
        assert_eq!(
            result["content"][0]["content"][0]["text"],
            input["content"][0]["content"][0]["text"]
        );
        assert_eq!(
            result["content"][2]["attrs"]["blockId"],
            projection.document["content"][2]["attrs"]["blockId"]
        );
        let mut outside = input.clone();
        let outside_directory = tempfile::tempdir().unwrap();
        outside["content"][2]["attrs"]["path"] = json!(outside_directory.path().join("图片.png"));
        assert_eq!(
            database
                .record_document_from_gui(&target, &outside)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(input["content"][2]["attrs"]["path"], absolute);
    }
    #[test]
    fn legacy_autosave_cannot_overwrite_a_record_with_a_canonical_head() {
        let (_directory, mut database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let result = database.workspace_record_upsert(WorkspaceRecordUpsertInput {
            note_id: Some(target.record_id),
            title: Some("Stale title".into()),
            html: "<p>Stale autosave</p>".into(),
            markdown: "Stale autosave".into(),
            default_code_language: None,
            tag_ids: vec![],
        });
        assert!(result.is_err());
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .projection
                .body_hash,
            projection.body_hash
        );
        let after = database.record_document_source(&target).unwrap();
        assert_eq!(after.title, source.title);
        assert_eq!(after.markdown, projection.markdown);
    }
    #[test]
    fn metadata_cas_updates_title_without_touching_canonical_body_or_history() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let before = database.record_metadata_get(&target).unwrap();
        let input = RecordMetadataUpdate {
            target: target.clone(),
            expected_revision: before.revision.clone(),
            title: Some("New title".into()),
            tag_ids: vec![],
        };
        let updated = database
            .record_metadata_update("gui", "title-1", &input, "workspace-test")
            .unwrap();
        assert_eq!(updated.title.as_deref(), Some("New title"));
        assert_ne!(updated.revision, before.revision);
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        assert_eq!(
            database.record_document_source(&target).unwrap().markdown,
            projection.markdown
        );
        assert_eq!(
            database
                .record_version_capacity(&target)
                .unwrap()
                .version_count,
            1
        );
        assert_eq!(
            database
                .record_metadata_update("gui", "title-1", &input, "workspace-test")
                .unwrap()
                .revision,
            updated.revision
        );
        assert_eq!(
            database
                .record_metadata_update("gui", "title-stale", &input, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        let invalid_tags = RecordMetadataUpdate {
            target: target.clone(),
            expected_revision: updated.revision.clone(),
            title: Some("Must roll back".into()),
            tag_ids: vec![999_999],
        };
        assert_eq!(
            database
                .record_metadata_update("gui", "bad-tags", &invalid_tags, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            database.record_metadata_get(&target).unwrap().revision,
            updated.revision
        );
    }
    #[test]
    fn record_head_cas_snapshots_receipts_and_compatibility_content_commit_together() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        let initial = database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        assert_eq!(initial.head_revision, 1);
        let mut changed = projection.clone();
        changed.document["content"][0]["content"][0]["text"] = json!("Changed");
        changed.html = changed.html.replace("Fixture 正文", "Changed");
        changed.markdown = changed.markdown.replace("Fixture 正文", "Changed");
        changed.text = changed.text.replace("Fixture 正文", "Changed");
        changed.body_hash = body_hash(&changed.document, &changed.code_language);
        let input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed,
            origin: RecordVersionOrigin::Agent,
            actor: json!({"kind":"agent","runId":"test"}),
            edit_session_id: None,
        };
        let saved = database
            .record_document_commit("run:test", "patch", &input, "workspace-test")
            .unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert!(saved.after_version.is_some());
        assert_eq!(
            database
                .record_document_commit("run:test", "patch", &input, "workspace-test")
                .unwrap()
                .head
                .head_revision,
            2
        );
        assert_eq!(
            database
                .record_document_commit("run:test", "stale", &input, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert!(database
            .record_document_source(&target)
            .unwrap()
            .html
            .contains("Changed"));
        let versions: i64 = database
            .conn
            .query_row("SELECT count(*) FROM record_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(versions, 2);
        assert_eq!(
            database
                .record_document_source(&target)
                .unwrap()
                .title
                .as_deref(),
            Some("Original title")
        );
    }

    fn changed(projection: &RecordDocumentProjection, text: &str) -> RecordDocumentProjection {
        let mut changed = projection.clone();
        let old = changed.document["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        changed.document["content"][0]["content"][0]["text"] = json!(text);
        changed.html = changed.html.replace(&old, text);
        changed.markdown = changed.markdown.replace(&old, text);
        changed.text = changed.text.replace(&old, text);
        changed.body_hash = body_hash(&changed.document, &changed.code_language);
        changed
    }
    fn reference_projection(
        projection: &RecordDocumentProjection,
        id: i64,
    ) -> RecordDocumentProjection {
        let mut document = projection.clone();
        document.document["content"][0]["content"] = json!([{"type":"internalReference","attrs":{"refKind":"note","refId":id.to_string(),"label":"Target"}}]);
        document.body_hash = body_hash(&document.document, &document.code_language);
        document
    }
    fn reference_target(database: &mut Database, name: &str) -> (i64, i64) {
        let project = database
            .project_create(crate::models::ProjectCreateInput {
                name: name.into(),
                summary: None,
                status: None,
            })
            .unwrap();
        database
            .insert_project_note(
                project.id,
                Some("Target"),
                "Target",
                "<p>Target</p>",
                None,
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        (project.id, database.conn.last_insert_rowid())
    }
    #[test]
    fn create_preview_uses_native_metadata_and_cross_project_reference_checks_without_writes() {
        let (_directory, mut database, _, _) = setup();
        let (owner, _) = reference_target(&mut database, "Preview owner");
        let (_, foreign) = reference_target(&mut database, "Preview foreign");
        let document = json!({"type":"doc","content":[{
            "type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            "content":[{"type":"internalReference","attrs":{
                "refKind":"note","refId":foreign,"label":"Foreign"
            }}]
        }]});
        let projection = RecordDocumentProjection {
            schema_version: 1, body_hash: body_hash(&document, &None), document: document.clone(),
            html: "<p>Foreign</p>".into(), markdown: "Foreign".into(),
            text: "Foreign".into(), code_language: None,
        };
        let input = RecordCreate {
            scope: Scope::Project { project_id: owner }, title: Some("  Valid  ".into()),
            tag_ids: vec![], document, code_language: None,
        };
        let before: i64 = database.conn.query_row("SELECT count(*) FROM record_document_heads", [], |row| row.get(0)).unwrap();
        assert_eq!(database.record_create_preview_validate(&input, &projection, "workspace-test").unwrap_err().code, ErrorCode::ScopeDenied);
        let mut valid_projection = projection.clone();
        valid_projection.document["content"][0]["content"] = json!([{"type":"text","text":"Foreign"}]);
        valid_projection.body_hash = body_hash(&valid_projection.document, &valid_projection.code_language);
        let mut invalid = input;
        invalid.document = valid_projection.document.clone();
        invalid.title = Some("line\nbreak".into());
        assert_eq!(database.record_create_preview_validate(&invalid, &valid_projection, "workspace-test").unwrap_err().code, ErrorCode::InvalidArgument);
        let after: i64 = database.conn.query_row("SELECT count(*) FROM record_document_heads", [], |row| row.get(0)).unwrap();
        assert_eq!(after, before);
    }
    #[test]
    fn record_autosave_receipts_store_commit_credentials_without_body_copies() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let mut commit = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, &"Large draft ".repeat(10000)),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        let saved = database
            .record_document_commit("gui", "autosave-first", &commit, "workspace-test")
            .unwrap();
        commit.base_revision = 2;
        commit.projection = changed(&projection, "Later body");
        database
            .record_document_commit("gui", "autosave-later", &commit, "workspace-test")
            .unwrap();
        let receipt: String = database.conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE request_id='autosave-first'", [], |row| row.get(0)).unwrap();
        assert!(
            receipt.len() < 2048,
            "receipt copied the body: {} bytes",
            receipt.len()
        );
        assert!(!receipt.contains("Large draft"));
        commit.base_revision = 1;
        commit.projection = changed(&projection, &"Large draft ".repeat(10000));
        let replay = database
            .record_document_commit("gui", "autosave-first", &commit, "workspace-test")
            .unwrap();
        assert_eq!(replay.head.head_revision, saved.head.head_revision);
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            3
        );
        assert_eq!(version_count(&database), 1);
        let capacity = database.record_version_capacity(&target).unwrap();
        assert_eq!(capacity.receipt_count, 3);
        assert!(capacity.receipt_bytes < 4096);
        let mut legacy = serde_json::to_value(&saved).unwrap();
        legacy["head"] = json!({"target":target,"headRevision":saved.head.head_revision,"projection":commit.projection,"editSessionId":"a".repeat(32),"checkpointDueAt":"old"});
        database.conn.execute("UPDATE agent_operation_receipts SET result_json=?1 WHERE request_id='autosave-first'", [legacy.to_string()]).unwrap();
        database.record_compact_operation_receipts().unwrap();
        database.record_compact_operation_receipts().unwrap();
        let compacted: String = database.conn.query_row("SELECT result_json FROM agent_operation_receipts WHERE request_id='autosave-first'", [], |row| row.get(0)).unwrap();
        assert!(compacted.len() < 2048);
        assert!(!compacted.contains("Large draft"));
        assert_eq!(
            database
                .record_document_commit("gui", "autosave-first", &commit, "workspace-test")
                .unwrap()
                .head
                .head_revision,
            2
        );
    }
    #[test]
    fn record_change_log_uses_canonical_object_keys_and_migrates_legacy_rows() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let expected = format!("workspace-test/workspace/record/{}", target.record_id);
        let actual: String = database.conn.query_row("SELECT object_key FROM agent_change_log WHERE operation='record.document.initialize'", [], |row| row.get(0)).unwrap();
        assert_eq!(actual, expected);
        database.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES ('record:project:7:42','project:7','record.patch','rev','old')", []).unwrap();
        database
            .record_migrate_operation_keys("workspace-test")
            .unwrap();
        database
            .record_migrate_operation_keys("workspace-test")
            .unwrap();
        let migrated: (String,String,String) = database.conn.query_row("SELECT object_key,revision,created_at FROM agent_change_log WHERE operation='record.patch'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(
            migrated,
            (
                "workspace-test/project:7/record/42".into(),
                "rev".into(),
                "old".into()
            )
        );
    }
    #[test]
    fn record_reference_edges_follow_cas_restore_and_entity_deletion_atomically() {
        let (_directory, mut database, target, projection) = setup();
        let (project, referenced) = reference_target(&mut database, "Reference targets");
        let linked = reference_projection(&projection, referenced);
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &linked,
                "workspace-test",
            )
            .unwrap();
        let source_key = format!("workspace-test/workspace/record/{}", target.record_id);
        let target_key = format!("workspace-test/project:{project}/record/{referenced}");
        let edges = || {
            database.conn.query_row("SELECT count(*) FROM content_reference_edges WHERE source_object_key=?1 AND target_object_key=?2 AND relation='internal_reference'", params![source_key,target_key], |row| row.get::<_,i64>(0)).unwrap()
        };
        assert_eq!(edges(), 1);
        let baseline = database
            .record_versions_list(&target, None, 50)
            .unwrap()
            .versions[0]
            .id
            .clone();
        let commit = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: projection.clone(),
            origin: RecordVersionOrigin::Agent,
            actor: json!({"kind":"test"}),
            edit_session_id: None,
        };
        database
            .record_document_commit("gui", "remove-reference", &commit, "workspace-test")
            .unwrap();
        assert_eq!(edges(), 0);
        let restore = RecordRestoreInput {
            target: target.clone(),
            base_revision: 2,
            version_id: baseline,
        };
        database.conn.execute_batch("CREATE TEMP TRIGGER reject_record_edge BEFORE INSERT ON content_reference_edges BEGIN SELECT RAISE(ABORT, 'edge failure'); END;").unwrap();
        assert_eq!(
            database
                .record_version_restore("gui", "failed-edge-restore", &restore, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            2
        );
        assert_eq!(edges(), 0);
        assert_eq!(database.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE request_id='failed-edge-restore'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        database
            .conn
            .execute_batch("DROP TRIGGER reject_record_edge;")
            .unwrap();
        database
            .record_version_restore("gui", "restore-reference", &restore, "workspace-test")
            .unwrap();
        assert_eq!(edges(), 1);
        database
            .conn
            .execute(
                "DELETE FROM workspace_notes WHERE id=?1",
                [target.record_id],
            )
            .unwrap();
        assert_eq!(edges(), 0);
    }
    #[test]
    fn record_new_invalid_references_reject_all_writes_and_existing_missing_sources_survive() {
        let (_directory, mut database, target, projection) = setup();
        let (project, referenced) = reference_target(&mut database, "Owned reference targets");
        let linked = reference_projection(&projection, referenced);
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &linked,
                "workspace-test",
            )
            .unwrap();
        database
            .conn
            .execute("DELETE FROM notes WHERE id=?1", [referenced])
            .unwrap();
        let mut retained = linked.clone();
        retained.document["content"][1]["content"][0]["content"][0]["content"][0]["content"] =
            json!([{"type":"text","text":"Unrelated edit"}]);
        retained.body_hash = body_hash(&retained.document, &retained.code_language);
        let mut commit = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: retained,
            origin: RecordVersionOrigin::Agent,
            actor: json!({"kind":"test"}),
            edit_session_id: None,
        };
        database
            .record_document_commit("gui", "keep-missing-reference", &commit, "workspace-test")
            .unwrap();
        commit.base_revision = 2;
        commit.projection = reference_projection(&projection, referenced + 10000);
        assert_eq!(
            database
                .record_document_commit("gui", "invented-reference", &commit, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            2
        );
        assert_eq!(database.conn.query_row("SELECT count(*) FROM agent_operation_receipts WHERE request_id='invented-reference'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        let other = database
            .project_create(crate::models::ProjectCreateInput {
                name: "Other scope".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        // Project-scope checking also rejects a real target from another Project.
        database
            .insert_project_note(
                project,
                Some("Target"),
                "Target",
                "<p>Target</p>",
                None,
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
        let cross_scope = reference_projection(&projection, database.conn.last_insert_rowid());
        assert_eq!(
            database
                .record_document_scope_from_gui(
                    &Scope::Project {
                        project_id: other.id
                    },
                    &cross_scope.document
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
    fn version_count(database: &Database) -> i64 {
        database
            .conn
            .query_row("SELECT count(*) FROM record_versions", [], |row| row.get(0))
            .unwrap()
    }
    #[test]
    fn record_head_manual_autosaves_group_and_no_change_does_not_snapshot_dirty_head() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let mut input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, "First"),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        let first = database
            .record_document_commit("gui", "first", &input, "workspace-test")
            .unwrap();
        input.base_revision = 2;
        input.projection = changed(&projection, "Second");
        let second = database
            .record_document_commit("gui", "second", &input, "workspace-test")
            .unwrap();
        assert_eq!(second.before_version, first.before_version);
        let second_checkpoint_due_at = database
            .record_document_head(&second.head.target)
            .unwrap()
            .unwrap()
            .checkpoint_due_at;
        assert_eq!(version_count(&database), 1);
        input.base_revision = 3;
        let unchanged = database
            .record_document_commit("gui", "unchanged", &input, "workspace-test")
            .unwrap();
        assert!(unchanged.no_change);
        assert_eq!(unchanged.head.head_revision, 3);
        assert_eq!(version_count(&database), 1);
        assert_eq!(
            database
                .record_document_head(&unchanged.head.target)
                .unwrap()
                .unwrap()
                .checkpoint_due_at,
            second_checkpoint_due_at
        );
        input.origin = RecordVersionOrigin::Agent;
        input.edit_session_id = None;
        input.projection = changed(&projection, "Agent boundary");
        let boundary = database
            .record_document_commit("agent", "boundary", &input, "workspace-test")
            .unwrap();
        assert_ne!(boundary.before_version, first.before_version);
        assert_eq!(version_count(&database), 3);
        assert!(database
            .record_document_head(&boundary.head.target)
            .unwrap()
            .unwrap()
            .edit_session_id
            .is_none());
    }

    #[test]
    fn workspace_shared_open_migrates_receipts_and_recovers_checkpoints_on_every_reopen() {
        use crate::agent::{
            access::ScopeGrant,
            changes::{ChangeInput, ChangeRepository},
        };
        let (root, database, target, projection) = setup();
        let legacy = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &legacy.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, "Saved before crash"),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        let saved = database
            .record_document_commit("gui", "draft", &input, "workspace-test")
            .unwrap();
        let mut old_receipt = serde_json::to_value(&saved).unwrap();
        old_receipt["head"] = json!({"target":target,"headRevision":2,"projection":input.projection,"editSessionId":"a".repeat(32),"checkpointDueAt":"old"});
        database
            .conn
            .execute(
                "UPDATE agent_operation_receipts SET result_json=?1 WHERE request_id='draft'",
                [old_receipt.to_string()],
            )
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE agent_change_log SET object_key=?1",
                [format!("record:{}", target.key().unwrap())],
            )
            .unwrap();
        drop(database);
        let grant = ScopeGrant {
            object_keys: None,
            workspace_id: "workspace-test".into(),
            workspace_content: true,
            project_ids: vec![],
            operations: vec!["record.read".into()],
        };
        for password in [None, Some("reopened-password".into()), None] {
            let opened = crate::workspace_initialization::open_workspace_database(
                &root.path().join("app.sqlite"),
                root.path(),
                password,
                "workspace-test",
            )
            .unwrap();
            assert!(opened.checkpoint_error.is_none());
            let db = opened.db;
            let head = db.record_document_head(&target).unwrap().unwrap();
            assert_eq!(head.head_revision, 2);
            assert_eq!(head.projection.body_hash, saved.head.body_hash);
            assert!(head.edit_session_id.is_none());
            assert_eq!(
                db.record_versions_list(&target, None, 50)
                    .unwrap()
                    .versions
                    .len(),
                2
            );
            let replay = db
                .record_document_commit("gui", "draft", &input, "workspace-test")
                .unwrap();
            assert_eq!(replay.head.head_revision, 2);
            assert_eq!(replay.head.body_hash, saved.head.body_hash);
            assert!(db.record_version_capacity(&target).unwrap().receipt_bytes < 4096);
            let changes = db
                .agent_changes_list(
                    &grant,
                    &ChangeInput {
                        after_seq: 0,
                        limit: 200,
                    },
                )
                .unwrap();
            assert!(changes
                .entries
                .iter()
                .all(|change| change.object_key == target.object_key("workspace-test").unwrap()));
        }
    }
    #[test]
    fn record_head_checkpoint_recovers_autosave_and_restore_preserves_metadata_and_history() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let baseline = database
            .record_versions_list(&target, None, 1)
            .unwrap()
            .versions[0]
            .id
            .clone();
        let input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, "Crash-persisted draft"),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        database
            .record_document_commit("gui", "draft", &input, "workspace-test")
            .unwrap();
        let mut checkpoint = RecordCheckpointInput {
            target: target.clone(),
            base_revision: 2,
            reason: RecordCheckpointReason::Due,
        };
        assert!(
            !database
                .record_document_checkpoint("gui", "early", &checkpoint, "workspace-test")
                .unwrap()
                .checkpointed
        );
        checkpoint.reason = RecordCheckpointReason::Recovery;
        let saved = database
            .record_document_checkpoint("system", "recovered", &checkpoint, "workspace-test")
            .unwrap();
        assert!(saved.checkpointed);
        assert_eq!(saved.head.head_revision, 2);
        assert!(database
            .record_document_head(&saved.head.target)
            .unwrap()
            .unwrap()
            .edit_session_id
            .is_none());
        assert_eq!(version_count(&database), 2);
        assert!(
            database
                .record_document_checkpoint("system", "recovered", &checkpoint, "workspace-test")
                .unwrap()
                .checkpointed
        );
        assert!(
            !database
                .record_document_checkpoint("gui", "again", &checkpoint, "workspace-test")
                .unwrap()
                .checkpointed
        );
        let page = database.record_versions_list(&target, None, 1).unwrap();
        assert_eq!(page.versions[0].version_number, 2);
        let older = database
            .record_versions_list(&target, page.next_before, 1)
            .unwrap();
        assert_eq!(older.versions[0].id, baseline);
        assert!(older.next_before.is_none());
        database
            .conn
            .execute(
                "UPDATE workspace_notes SET title='Current title' WHERE id=?1",
                [target.record_id],
            )
            .unwrap();
        let restore = RecordRestoreInput {
            target: target.clone(),
            base_revision: 2,
            version_id: baseline.clone(),
        };
        let restored = database
            .record_version_restore("gui", "restore", &restore, "workspace-test")
            .unwrap();
        assert_eq!(restored.head.body_hash, projection.body_hash);
        assert_eq!(restored.head.head_revision, 3);
        assert_eq!(version_count(&database), 3);
        assert_eq!(
            database
                .record_document_source(&target)
                .unwrap()
                .title
                .as_deref(),
            Some("Current title")
        );
        let version = database
            .record_version_get(&target, restored.after_version.as_deref().unwrap())
            .unwrap();
        assert_eq!(
            version.restored_from_version_id.as_deref(),
            Some(baseline.as_str())
        );
        assert_eq!(version.origin.key(), "restore");
        assert_eq!(
            database
                .record_version_get(&target, &baseline)
                .unwrap()
                .title_snapshot
                .as_deref(),
            Some("Original title")
        );
        assert_eq!(
            database
                .record_version_restore("gui", "restore", &restore, "workspace-test")
                .unwrap()
                .head
                .head_revision,
            3
        );
        let no_change = RecordRestoreInput {
            base_revision: 3,
            ..restore
        };
        assert!(
            database
                .record_version_restore("gui", "same", &no_change, "workspace-test")
                .unwrap()
                .no_change
        );
        assert_eq!(version_count(&database), 3);
        let capacity = database.record_version_capacity(&target).unwrap();
        assert_eq!(capacity.version_count, 3);
        assert!(capacity.snapshot_bytes > 0);
        assert_eq!(capacity.retained_asset_count, 2);
    }

    #[test]
    fn record_head_checkpoint_due_and_restore_failures_do_not_mutate_history() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let baseline = database
            .record_versions_list(&target, None, 1)
            .unwrap()
            .versions[0]
            .id
            .clone();
        let input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, "Waiting"),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        database
            .record_document_commit("gui", "draft", &input, "workspace-test")
            .unwrap();
        database
            .conn
            .execute(
                "UPDATE record_document_heads SET checkpoint_due_at=?1",
                [(Utc::now() - Duration::seconds(1)).to_rfc3339()],
            )
            .unwrap();
        let checkpoint = RecordCheckpointInput {
            target: target.clone(),
            base_revision: 2,
            reason: RecordCheckpointReason::Due,
        };
        assert!(
            database
                .record_document_checkpoint("timer", "due", &checkpoint, "workspace-test")
                .unwrap()
                .checkpointed
        );
        let restore = RecordRestoreInput {
            target: target.clone(),
            base_revision: 1,
            version_id: baseline.clone(),
        };
        assert_eq!(
            database
                .record_version_restore("gui", "stale-restore", &restore, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        database
            .conn
            .execute(
                "UPDATE record_versions SET body_hash='sha256:damaged' WHERE id=?1",
                [&baseline],
            )
            .unwrap();
        let restore = RecordRestoreInput {
            base_revision: 2,
            ..restore
        };
        assert_eq!(
            database
                .record_version_restore("gui", "damaged-restore", &restore, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(version_count(&database), 2);
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            2
        );
        assert!(database.record_versions_list(&target, None, 0).is_err());
    }

    #[test]
    fn record_head_continuous_edit_checkpoint_deadline_and_restart_recovery() {
        let (directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let mut input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed(&projection, "First"),
            origin: RecordVersionOrigin::Manual,
            actor: json!({"kind":"gui"}),
            edit_session_id: Some("a".repeat(32)),
        };
        database
            .record_document_commit("gui", "first", &input, "workspace-test")
            .unwrap();
        let before = Utc::now();
        database
            .conn
            .execute(
                "UPDATE record_document_heads SET edit_started_at=?1",
                [(before - Duration::seconds(59)).to_rfc3339()],
            )
            .unwrap();
        input.base_revision = 2;
        input.projection = changed(&projection, "Last persisted draft");
        let last = database
            .record_document_commit("gui", "last", &input, "workspace-test")
            .unwrap();
        let due = chrono::DateTime::parse_from_rfc3339(
            database
                .record_document_head(&last.head.target)
                .unwrap()
                .unwrap()
                .checkpoint_due_at
                .as_deref()
                .unwrap(),
        )
        .unwrap();
        assert!(due <= before + Duration::seconds(1));
        assert_eq!(version_count(&database), 1);
        drop(database);
        let database =
            Database::open(&directory.path().join("app.sqlite"), directory.path(), None).unwrap();
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .projection
                .body_hash,
            input.projection.body_hash
        );
        let pending = database.record_pending_checkpoints(false, 10).unwrap();
        assert!(pending.is_empty());
        let pending = database.record_pending_checkpoints(true, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].base_revision, 3);
        assert_eq!(
            database
                .record_seal_pending_checkpoints(true, "workspace-test")
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .record_seal_pending_checkpoints(true, "workspace-test")
                .unwrap(),
            0
        );
        assert!(database
            .record_pending_checkpoints(true, 10)
            .unwrap()
            .is_empty());
        assert_eq!(version_count(&database), 2);
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .projection
                .body_hash,
            input.projection.body_hash
        );
    }

    #[test]
    fn record_head_patch_replays_original_intent_even_when_worker_allocates_different_ids() {
        use crate::agent::{
            models::{ObjectKind, ObjectRef},
            outputs::RecordPatch,
        };
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        let patch:RecordPatch=serde_json::from_value(json!({"record":ObjectRef{workspace_id:"w1".into(),scope:target.scope.clone(),kind:ObjectKind::Record,id:target.record_id.to_string()},"baseRevision":1,"requestId":"patch","operations":[{"op":"append","parentBlockId":null,"blocks":[{"type":"paragraph","content":[{"type":"text","text":"New"}]}]}]})).unwrap();
        assert!(matches!(
            database.record_patch_prepare("run:test", &patch).unwrap(),
            RecordPatchPreparation::Base(_)
        ));
        let mut changed = projection.clone();
        changed.document["content"].as_array_mut().unwrap().push(json!({"type":"paragraph","attrs":{"blockId":"f".repeat(32)},"content":[{"type":"text","text":"New"}]}));
        changed
            .html
            .push_str(&format!("<p data-block-id=\"{}\">New</p>", "f".repeat(32)));
        changed.markdown.push_str("\n\nNew");
        changed.text.push_str("\nNew");
        changed.body_hash = body_hash(&changed.document, &changed.code_language);
        let mut metadata = RecordPatchMetadata {
            created_block_ids: vec!["f".repeat(32)],
            deleted_block_ids: vec![],
            normalizations: vec![],
            no_change: false,
        };
        let saved = database
            .record_patch_commit("run:test", &patch, &changed, &metadata, "workspace-test")
            .unwrap();
        assert_eq!(saved.before_revision, 1);
        assert_eq!(saved.after_revision, 2);
        assert!(saved.receipt.undo_available);
        assert_eq!(version_count(&database), 2);
        changed.document["content"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["attrs"]["blockId"] = json!("e".repeat(32));
        changed.body_hash = body_hash(&changed.document, &changed.code_language);
        metadata.created_block_ids = vec!["e".repeat(32)];
        let replay = database
            .record_patch_commit("run:test", &patch, &changed, &metadata, "workspace-test")
            .unwrap();
        assert_eq!(replay.created_block_ids, saved.created_block_ids);
        assert_eq!(replay.receipt.operation_id, saved.receipt.operation_id);
        assert_eq!(version_count(&database), 2);
        assert!(matches!(
            database.record_patch_prepare("run:test", &patch).unwrap(),
            RecordPatchPreparation::Replay(_)
        ));
        let mut stale = patch.clone();
        stale.request_id = "stale".into();
        assert_eq!(
            database
                .record_patch_prepare("run:test", &stale)
                .err()
                .unwrap()
                .code,
            ErrorCode::RevisionConflict
        );
        let mut different = serde_json::to_value(&patch).unwrap();
        different["operations"][0]["blocks"][0]["content"][0]["text"] = json!("Different");
        let different: RecordPatch = serde_json::from_value(different).unwrap();
        assert_eq!(
            database
                .record_patch_prepare("run:test", &different)
                .err()
                .unwrap()
                .code,
            ErrorCode::IdempotencyConflict
        );
    }

    #[test]
    fn record_head_outbox_failure_rolls_back_body_version_and_receipt() {
        let (_directory, database, target, projection) = setup();
        let source = database.record_document_source(&target).unwrap();
        database
            .record_document_initialize(
                "gui",
                "baseline",
                &target,
                &source.source_hash,
                &projection,
                "workspace-test",
            )
            .unwrap();
        database.conn.execute_batch("CREATE TRIGGER reject_record_change BEFORE INSERT ON agent_change_log BEGIN SELECT RAISE(FAIL, 'full'); END;").unwrap();
        let mut changed = projection.clone();
        changed.code_language = Some("rust".into());
        changed.body_hash = body_hash(&changed.document, &changed.code_language);
        let input = RecordDocumentCommit {
            target: target.clone(),
            base_revision: 1,
            projection: changed,
            origin: RecordVersionOrigin::EditorAi,
            actor: json!({"kind":"gui"}),
            edit_session_id: None,
        };
        assert_eq!(
            database
                .record_document_commit("gui", "failed", &input, "workspace-test")
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            database
                .record_document_head(&target)
                .unwrap()
                .unwrap()
                .head_revision,
            1
        );
        let versions: i64 = database
            .conn
            .query_row("SELECT count(*) FROM record_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(versions, 1);
    }
}
