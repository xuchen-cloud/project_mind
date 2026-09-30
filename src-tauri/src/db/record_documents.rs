use super::agent_operations::{io_error, OperationChange};
use super::Database;
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
};
use crate::record_documents::*;
use chrono::{Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn source(conn: &Connection, target: &RecordTarget) -> AgentResult<RecordLegacySource> {
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

fn head(conn: &Connection, target: &RecordTarget) -> AgentResult<Option<RecordDocumentHead>> {
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
        head(&self.conn, target)
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
        let current = head(&self.conn, &target)?.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Initialize the Record document first",
            )
        })?;
        if current.head_revision != patch.base_revision {
            return Err(conflict(&current));
        }
        validate_record_patch(patch, &current)?;
        Ok(RecordPatchPreparation::Base(current))
    }
    pub(crate) fn record_patch_commit(
        &self,
        caller: &str,
        patch: &crate::agent::outputs::RecordPatch,
        projection: &RecordDocumentProjection,
        metadata: &RecordPatchMetadata,
    ) -> AgentResult<RecordPatchResult> {
        let target = record_patch_target(patch)?;
        let compatibility = self.record_compatibility_html(&target, projection)?;
        // Receipt identity uses original intent, not randomly allocated worker IDs.
        self.agent_atomic_operation(caller, &patch.request_id, "record.patch", patch, |tx| {
            source(tx, &target)?;
            let current = head(tx, &target)?.ok_or_else(|| {
                AgentError::new(
                    ErrorCode::SourceNotReady,
                    "Initialize the Record document first",
                )
            })?;
            if current.head_revision != patch.base_revision {
                return Err(conflict(&current));
            }
            validate_record_patch(patch, &current)?;
            let before: std::collections::BTreeSet<_> =
                document_block_ids(&current.projection.document)
                    .into_iter()
                    .collect();
            let after: std::collections::BTreeSet<_> = document_block_ids(&projection.document)
                .into_iter()
                .collect();
            let created: std::collections::BTreeSet<_> =
                metadata.created_block_ids.iter().cloned().collect();
            let deleted: std::collections::BTreeSet<_> =
                metadata.deleted_block_ids.iter().cloned().collect();
            if created.len() != metadata.created_block_ids.len()
                || deleted.len() != metadata.deleted_block_ids.len()
                || created != after.difference(&before).cloned().collect()
                || deleted != before.difference(&after).cloned().collect()
                || metadata.no_change != (current.projection.body_hash == projection.body_hash)
                || current.projection.code_language != projection.code_language
                || metadata
                    .normalizations
                    .iter()
                    .any(|repair| match repair.kind.as_str() {
                        "empty_document_paragraph" => repair.block_id.is_some(),
                        "empty_container_paragraph" | "remove_empty_container" => repair
                            .block_id
                            .as_ref()
                            .is_none_or(|id| !before.contains(id)),
                        _ => true,
                    })
            {
                return Err(invalid(
                    "Worker patch metadata differs from the resulting document",
                ));
            }
            let operation_id = random_id();
            let commit = RecordDocumentCommit {
                target: target.clone(),
                base_revision: patch.base_revision,
                projection: projection.clone(),
                origin: RecordVersionOrigin::Agent,
                actor: json!({"kind":"agent","caller":caller}),
                edit_session_id: None,
            };
            let (saved, change) =
                Self::record_commit_transaction(tx, &operation_id, &commit, &compatibility, None)?;
            let receipt = crate::agent::outputs::OperationReceipt {
                operation_id,
                request_id: patch.request_id.clone(),
                object: patch.record.clone(),
                result_revision: saved.head.projection.body_hash.clone(),
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
        source(&self.conn, target)?;
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
        source(&self.conn, target)?;
        version(&self.conn, target, id)
    }
    pub(crate) fn record_version_capacity(
        &self,
        target: &RecordTarget,
    ) -> AgentResult<RecordVersionCapacity> {
        source(&self.conn, target)?;
        let key = target.key()?;
        let (version_count,snapshot_bytes): (i64,i64) = self.conn.query_row("SELECT count(*),COALESCE(sum(length(CAST(document_snapshot AS BLOB))+length(CAST(html AS BLOB))+length(CAST(markdown AS BLOB))+length(CAST(text AS BLOB))),0) FROM record_versions WHERE record_key=?1", [&key], |row|Ok((row.get(0)?,row.get(1)?))).map_err(io_error)?;
        let retained_asset_count: i64 = self.conn.query_row("SELECT count(DISTINCT asset_ref) FROM record_version_assets JOIN record_versions ON record_versions.id=version_id WHERE record_key=?1", [&key], |row|row.get(0)).map_err(io_error)?;
        Ok(RecordVersionCapacity {
            version_count: version_count as u64,
            snapshot_bytes: snapshot_bytes as u64,
            retained_asset_count: retained_asset_count as u64,
        })
    }
    pub(crate) fn record_document_checkpoint(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordCheckpointInput,
    ) -> AgentResult<RecordCheckpointResult> {
        if input.base_revision == 0 || input.base_revision > i64::MAX as u64 {
            return Err(invalid("Invalid checkpoint revision"));
        }
        self.agent_atomic_operation(caller,request_id,"record.document.checkpoint",input,|tx| {
            let current_source = source(tx,&input.target)?;
            let current = head(tx,&input.target)?.ok_or_else(||AgentError::new(ErrorCode::SourceNotReady,"Initialize the Record document first"))?;
            if current.head_revision != input.base_revision { return Err(conflict(&current)); }
            let due = current.checkpoint_due_at.as_deref().map(chrono::DateTime::parse_from_rfc3339).transpose().map_err(|_|damaged())?;
            if current.edit_session_id.is_none() || (matches!(input.reason,RecordCheckpointReason::Due) && due.is_none_or(|due|due > Utc::now())) {
                return Ok((RecordCheckpointResult{head:current,version_id:None,checkpointed:false},None));
            }
            let id = snapshot(tx,&current,&current_source.title,&RecordVersionOrigin::Manual,&json!({"kind":"gui","checkpointReason":input.reason}),request_id,None)?;
            tx.execute("UPDATE record_document_heads SET edit_session_id=NULL,edit_started_at=NULL,checkpoint_due_at=NULL WHERE record_key=?1", [input.target.key()?]).map_err(io_error)?;
            let updated = head(tx,&input.target)?.ok_or_else(damaged)?;
            Ok((RecordCheckpointResult{head:updated,version_id:Some(id),checkpointed:true},Some(OperationChange{object_key:format!("record:{}",input.target.key()?),scope:input.target.scope.clone(),revision:current.projection.body_hash})))
        })
    }
    pub(crate) fn record_version_restore(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordRestoreInput,
    ) -> AgentResult<RecordCommitResult> {
        if input.base_revision == 0 || input.base_revision > i64::MAX as u64 {
            return Err(invalid("Invalid restore revision"));
        }
        let historic = self.record_version_get(&input.target, &input.version_id)?;
        let compatibility = self.record_compatibility_html(&input.target, &historic.projection)?;
        self.agent_atomic_operation(caller, request_id, "record.version.restore", input, |tx| {
            let historic = version(tx, &input.target, &input.version_id)?;
            let commit = RecordDocumentCommit {
                target: input.target.clone(),
                base_revision: input.base_revision,
                projection: historic.projection,
                origin: RecordVersionOrigin::Restore,
                actor: json!({"kind":"gui"}),
                edit_session_id: None,
            };
            Self::record_commit_transaction(
                tx,
                request_id,
                &commit,
                &compatibility,
                Some(&input.version_id),
            )
        })
    }
    fn record_compatibility_html(
        &self,
        target: &RecordTarget,
        projection: &RecordDocumentProjection,
    ) -> AgentResult<String> {
        let assets = projection.validate()?;
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
    ) -> AgentResult<()> {
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
    ) -> AgentResult<RecordDocumentHead> {
        let compatibility = self.record_compatibility_html(target, projection)?;
        self.agent_atomic_operation(caller,request_id,"record.document.initialize", &(target,expected_source_hash,projection), |tx| {
            let current_source = source(tx,target)?;
            if let Some(current) = head(tx,target)? { return Ok((current,None)); }
            if current_source.source_hash != expected_source_hash { return Err(AgentError::new(ErrorCode::RevisionConflict,"Legacy Record changed before baseline conversion")); }
            let (project,workspace) = match target.scope { Scope::Workspace => (None,Some(target.record_id)),Scope::Project { .. } => (Some(target.record_id),None) };
            tx.execute("INSERT INTO record_document_heads(record_key,project_note_id,workspace_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,code_language,updated_at) VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11)",params![target.key()?,project,workspace,projection.document.to_string(),projection.html,projection.markdown,projection.text,projection.body_hash,projection.schema_version,projection.code_language,Utc::now().to_rfc3339()]).map_err(io_error)?;
            Self::record_write_projection(tx,target,projection,&compatibility)?;
            let initial = head(tx,target)?.ok_or_else(|| AgentError::new(ErrorCode::IoFailed,"Cannot read new Record head"))?;
            snapshot(tx,&initial,&current_source.title,&RecordVersionOrigin::Baseline,&json!({"kind":"gui"}),request_id,None)?;
            Ok((initial,Some(OperationChange{object_key:format!("record:{}",target.key()?),scope:target.scope.clone(),revision:projection.body_hash.clone()})))
        })
    }
    pub(crate) fn record_document_commit(
        &self,
        caller: &str,
        request_id: &str,
        input: &RecordDocumentCommit,
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
        self.agent_atomic_operation(caller, request_id, "record.document.commit", input, |tx| {
            Self::record_commit_transaction(tx, request_id, input, &compatibility, None)
        })
    }
    fn record_commit_transaction(
        tx: &Transaction<'_>,
        request_id: &str,
        input: &RecordDocumentCommit,
        compatibility: &str,
        restored_from: Option<&str>,
    ) -> AgentResult<(RecordCommitResult, Option<OperationChange>)> {
        let manual = matches!(input.origin, RecordVersionOrigin::Manual);
        let current_source = source(tx, &input.target)?;
        let current = head(tx, &input.target)?.ok_or_else(|| {
            AgentError::new(
                ErrorCode::SourceNotReady,
                "Initialize the Record document first",
            )
        })?;
        if current.head_revision != input.base_revision {
            return Err(conflict(&current));
        }
        let latest_version: String = tx.query_row("SELECT id FROM record_versions WHERE record_key=?1 ORDER BY version_number DESC LIMIT 1", [input.target.key()?], |row| row.get(0)).map_err(io_error)?;
        if current.projection.body_hash == input.projection.body_hash {
            return Ok((
                RecordCommitResult {
                    head: current,
                    no_change: true,
                    before_version: latest_version,
                    after_version: None,
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
        Self::record_write_projection(tx, &input.target, p, compatibility)?;
        let updated = head(tx, &input.target)?.ok_or_else(|| {
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
                head: updated,
                no_change: false,
                before_version,
                after_version,
            },
            Some(OperationChange {
                object_key: format!("record:{}", input.target.key()?),
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
            .record_document_commit("run:test", "patch", &input)
            .unwrap();
        assert_eq!(saved.head.head_revision, 2);
        assert!(saved.after_version.is_some());
        assert_eq!(
            database
                .record_document_commit("run:test", "patch", &input)
                .unwrap()
                .head
                .head_revision,
            2
        );
        assert_eq!(
            database
                .record_document_commit("run:test", "stale", &input)
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
            .record_document_commit("gui", "first", &input)
            .unwrap();
        input.base_revision = 2;
        input.projection = changed(&projection, "Second");
        let second = database
            .record_document_commit("gui", "second", &input)
            .unwrap();
        assert_eq!(second.before_version, first.before_version);
        assert_eq!(version_count(&database), 1);
        input.base_revision = 3;
        let unchanged = database
            .record_document_commit("gui", "unchanged", &input)
            .unwrap();
        assert!(unchanged.no_change);
        assert_eq!(unchanged.head.head_revision, 3);
        assert_eq!(version_count(&database), 1);
        assert_eq!(
            unchanged.head.checkpoint_due_at,
            second.head.checkpoint_due_at
        );
        input.origin = RecordVersionOrigin::Agent;
        input.edit_session_id = None;
        input.projection = changed(&projection, "Agent boundary");
        let boundary = database
            .record_document_commit("agent", "boundary", &input)
            .unwrap();
        assert_ne!(boundary.before_version, first.before_version);
        assert_eq!(version_count(&database), 3);
        assert!(boundary.head.edit_session_id.is_none());
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
            .record_document_commit("gui", "draft", &input)
            .unwrap();
        let mut checkpoint = RecordCheckpointInput {
            target: target.clone(),
            base_revision: 2,
            reason: RecordCheckpointReason::Due,
        };
        assert!(
            !database
                .record_document_checkpoint("gui", "early", &checkpoint)
                .unwrap()
                .checkpointed
        );
        checkpoint.reason = RecordCheckpointReason::Recovery;
        let saved = database
            .record_document_checkpoint("system", "recovered", &checkpoint)
            .unwrap();
        assert!(saved.checkpointed);
        assert_eq!(saved.head.head_revision, 2);
        assert!(saved.head.edit_session_id.is_none());
        assert_eq!(version_count(&database), 2);
        assert!(
            database
                .record_document_checkpoint("system", "recovered", &checkpoint)
                .unwrap()
                .checkpointed
        );
        assert!(
            !database
                .record_document_checkpoint("gui", "again", &checkpoint)
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
            .record_version_restore("gui", "restore", &restore)
            .unwrap();
        assert_eq!(restored.head.projection.body_hash, projection.body_hash);
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
                .record_version_restore("gui", "restore", &restore)
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
                .record_version_restore("gui", "same", &no_change)
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
            .record_document_commit("gui", "draft", &input)
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
                .record_document_checkpoint("timer", "due", &checkpoint)
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
                .record_version_restore("gui", "stale-restore", &restore)
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
                .record_version_restore("gui", "damaged-restore", &restore)
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
            .record_document_commit("gui", "first", &input)
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
            .record_document_commit("gui", "last", &input)
            .unwrap();
        let due =
            chrono::DateTime::parse_from_rfc3339(last.head.checkpoint_due_at.as_deref().unwrap())
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
        database
            .record_document_checkpoint("recovery", "after-crash", &pending[0])
            .unwrap();
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
            .record_patch_commit("run:test", &patch, &changed, &metadata)
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
            .record_patch_commit("run:test", &patch, &changed, &metadata)
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
                .record_document_commit("gui", "failed", &input)
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
