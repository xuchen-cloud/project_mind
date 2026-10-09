//! Authoritative source ownership and immutable/current Record snapshots.
use super::Database;
use crate::{
    agent::{
        access::{Caller, RequestContext},
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    record_documents::RecordTarget,
    source_service::{
        SourceFingerprint, SourcePolicy, SourcePolicyUpdate, SourceReadTarget, SourceSnapshot,
    },
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};
fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot read source storage")
}
impl Database {
    pub(super) fn source_resolve_business(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        operation: &str,
    ) -> AgentResult<ObjectRef> {
        object.key()?;
        request.authorize(binding, &object.scope, operation)?;
        if object.workspace_id != binding.workspace_id {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Source is outside this Workspace",
            ));
        }
        if matches!(object.kind, ObjectKind::SessionMessage | ObjectKind::SessionSummary) {
            request.authorize(binding, &object.scope, "session.read")?;
            let resolved = self
                .agent_resolve_object(object, &binding.workspace_id)?
                .ok_or_else(|| {
                    AgentError::new(ErrorCode::NotFound, "Source is no longer present")
                })?;
            request.authorize_object(binding, object, &resolved, operation)?;
            return Ok(resolved);
        }
        if !matches!(
            object.kind,
            ObjectKind::Record
                | ObjectKind::File
                | ObjectKind::Project
                | ObjectKind::Todo
                | ObjectKind::QuickNote
                | ObjectKind::Transcript
                | ObjectKind::SessionSummary
        ) {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "This source kind is not ready for reading",
            ));
        }
        let id = object
            .id
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0 && id.to_string() == object.id)
            .ok_or_else(|| {
                AgentError::new(ErrorCode::InvalidArgument, "Invalid source identity")
            })?;
        let resolved_scope=match (&object.kind,&object.scope) {
            (ObjectKind::Record,Scope::Workspace)=> self.conn.query_row("SELECT 1 FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'",[id],|_|Ok(Scope::Workspace)).optional(),
            (ObjectKind::Record,Scope::Project { .. })=>self.conn.query_row("SELECT n.project_id FROM notes n JOIN projects p ON p.id=n.project_id WHERE n.id=?1",[id],|row| Ok(Scope::Project { project_id:row.get(0)? })).optional(),
            (ObjectKind::File,_)=>self.conn.query_row("SELECT d.project_id FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=?1 AND d.storage_mode!='managed_note_image'",[id],|row|Ok(Scope::Project {project_id:row.get(0)?})).optional(),
            (ObjectKind::Project,_)=>self.conn.query_row("SELECT id FROM projects WHERE id=?1",[id],|row|Ok(Scope::Project {project_id:row.get(0)?})).optional(),
            (ObjectKind::QuickNote,Scope::Workspace)=>self.conn.query_row("SELECT 1 FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'",[id],|_|Ok(Scope::Workspace)).optional(),
            (ObjectKind::QuickNote,Scope::Project {..})=>self.conn.query_row("SELECT id FROM projects WHERE id=?1",[id],|row|Ok(Scope::Project {project_id:row.get(0)?})).optional(),
            (ObjectKind::Transcript,_)=>self.conn.query_row("SELECT n.project_id FROM voice_records v LEFT JOIN notes n ON n.id=v.project_note_id LEFT JOIN workspace_notes w ON w.id=v.workspace_note_id WHERE v.id=?1 AND (n.id IS NOT NULL OR w.id IS NOT NULL)",[id],|row| Ok(match row.get::<_,Option<i64>>(0)? { Some(project_id)=>Scope::Project {project_id},None=>Scope::Workspace })).optional(),
            (ObjectKind::Todo,_)=>self.conn.query_row("SELECT scope,project_id FROM todos WHERE id=?1",[id],|row| {
                let kind: String = row.get(0)?;
                Ok(if kind == "workspace" { Scope::Workspace } else { Scope::Project {project_id: row.get(1)?} })
            }).optional(),
            _=>return Err(AgentError::new(ErrorCode::SourceNotReady,"This source kind is not ready for reading")),
        }.map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Source is no longer present"))?;
        let resolved = ObjectRef {
            scope: resolved_scope,
            ..object.clone()
        };
        request.authorize_object(binding, object, &resolved, operation)?;
        Ok(resolved)
    }
    pub(crate) fn source_policy_update(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourcePolicyUpdate,
    ) -> AgentResult<SourcePolicy> {
        if !matches!(request.caller, Caller::Gui) {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Source policy requires the local settings interface",
            ));
        }
        let object =
            self.source_resolve_business(request, binding, &input.object, "settings.write")?;
        if input.expected_revision > i64::MAX as u64 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid source policy revision",
            ));
        }
        crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        self.agent_atomic_operation(&request.caller.key(),&request.request_id,"source.policy.update",input,|tx| {
            let key=object.key()?;
            let previous=tx.query_row("SELECT excluded,revision FROM source_access_policies WHERE object_key=?1",[&key],|row|Ok((row.get::<_,bool>(0)?,row.get::<_,i64>(1)? as u64))).optional().map_err(io_error)?.unwrap_or((false,0));
            if input.expected_revision!=previous.1 {return Err(AgentError::new(ErrorCode::RevisionConflict,"Source policy changed; reload it before saving"));}
            if input.excluded==previous.0 {return Ok((SourcePolicy {object:object.clone(),revision:previous.1,excluded:previous.0},None));}
            let revision=previous.1.checked_add(1).filter(|revision|*revision<=i64::MAX as u64).ok_or_else(||AgentError::new(ErrorCode::BudgetExceeded,"Source policy revision exhausted"))?;
            tx.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,?2,?3) ON CONFLICT(object_key) DO UPDATE SET excluded=excluded.excluded,revision=excluded.revision",params![key,input.excluded,revision as i64]).map_err(io_error)?;
            if input.excluded {
                tx.execute("DELETE FROM source_index_snapshots WHERE object_key=?1",[&key]).map_err(io_error)?;
                tx.execute("UPDATE agent_jobs SET state='cancelled',error=NULL WHERE kind='extract' AND dedupe_key=?1 AND state IN ('queued','running')",[format!("source-index:{key}")]).map_err(io_error)?;
            }
            let policy=SourcePolicy {object:object.clone(),revision,excluded:input.excluded};
            let change=super::agent_operations::OperationChange {object_key:key,scope:object.scope.clone(),revision:format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(&policy).map_err(|_|AgentError::new(ErrorCode::IoFailed,"Invalid source policy"))?))};
            Ok((policy,Some(change)))
        })
    }
    pub(crate) fn source_read_object(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<ObjectRef> {
        self.source_read_object_inner(request, binding, object, false)
    }
    pub(crate) fn source_read_historical_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<ObjectRef> {
        // User-directed native history may outlive a withdrawal. Model and
        // connection source reads still require the Record to be visible.
        self.source_read_object_inner(request, binding, object, matches!(request.caller, Caller::Gui))
    }
    /// For an already authorized, connection-owned operation receipt only.
    /// Rechecks source.read, actual ownership, live scope, and exclusion while
    /// allowing its withdrawn target to remain visible for recovery.
    pub(crate) fn source_read_recovery_object(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<ObjectRef> {
        if !matches!(object.kind, ObjectKind::Record | ObjectKind::Todo | ObjectKind::File) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Unsupported recovery source kind",
            ));
        }
        self.source_read_object_inner(request, binding, object, true)
    }
    pub(crate) fn source_read_historical_file(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
    ) -> AgentResult<ObjectRef> {
        if object.kind != ObjectKind::File {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Expected a historical File target",
            ));
        }
        // User-directed native history is distinct from active AI context.
        // It still resolves the actual owner and checks the bound read grant.
        if matches!(request.caller, Caller::Gui) {
            return self.source_resolve_business(request, binding, object, "source.read");
        }
        // A fixed version supplied by a model remains an AI source access;
        // withdrawal does not grant a historical read capability to that caller.
        self.source_read_object_inner(request, binding, object, false)
    }
    fn source_read_object_inner(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        object: &ObjectRef,
        allow_withdrawn: bool,
    ) -> AgentResult<ObjectRef> {
        let resolved = self.source_resolve_business(request, binding, object, "source.read")?;
        self.source_live_scope(&resolved.scope)?;
        if resolved.kind == ObjectKind::Record && !allow_withdrawn {
            super::agent_record_withdrawals::require_record_visible(
                &self.conn,
                &RecordTarget {
                    scope: resolved.scope.clone(),
                    record_id: resolved.id.parse().map_err(|_| {
                        AgentError::new(ErrorCode::InvalidArgument, "Invalid Record identity")
                    })?,
                },
            )?;
        }
        if resolved.kind == ObjectKind::Todo && !allow_withdrawn {
            super::agent_todo_undo::require_todo_visible(
                &self.conn,
                resolved.id.parse().map_err(|_| {
                    AgentError::new(ErrorCode::InvalidArgument, "Invalid Todo identity")
                })?,
            )?;
        }
        if resolved.kind == ObjectKind::File && !allow_withdrawn {
            super::agent_file_undo::require_file_visible(
                &self.conn,
                resolved.id.parse().map_err(|_| {
                    AgentError::new(ErrorCode::InvalidArgument, "Invalid File identity")
                })?,
            )?;
        }
        self.source_prepare()?;
        let excluded: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM source_access_policies WHERE object_key=?1 AND excluded=1)",
            [resolved.key()?],|row|row.get(0),
        ).map_err(io_error)?;
        if excluded {
            return Err(AgentError::new(
                ErrorCode::ScopeDenied,
                "Source is excluded from AI access",
            ));
        }
        Ok(resolved)
    }
    pub(super) fn source_live_scope(&self, scope: &Scope) -> AgentResult<()> {
        if let Scope::Project { project_id } = scope {
            let archived: bool = self
                .conn
                .query_row(
                    "SELECT is_archived FROM projects WHERE id=?1",
                    [project_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(io_error)?
                .ok_or_else(|| {
                    AgentError::new(ErrorCode::NotFound, "Source scope is no longer present")
                })?;
            if archived {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Archived Project sources are outside the active AI scope",
                ));
            }
        }
        Ok(())
    }
    pub(super) fn source_prepare(&self) -> AgentResult<()> {
        if !self.table_exists("source_access_policies").map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Cannot inspect source policy schema")
        })? {
            crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        }
        Ok(())
    }
    pub(crate) fn source_record_fingerprint(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<SourceFingerprint> {
        let resolved = if input.record_version.is_some_and(|version| version > 0) {
            self.source_read_historical_record(request, binding, &input.object)?
        } else {
            self.source_read_object(request, binding, &input.object)?
        };
        if resolved.kind != ObjectKind::Record {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "This source kind is not a Record",
            ));
        }
        if input.file_version.is_some() || input.record_version == Some(0) {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Record source version",
            ));
        }
        let target = RecordTarget {
            scope: resolved.scope.clone(),
            record_id: resolved.id.parse().map_err(|_| {
                AgentError::new(ErrorCode::InvalidArgument, "Invalid Record source identity")
            })?,
        };
        let (body_hash, title, metadata, updated_at) = if let Some(number) = input.record_version {
            let (hash,title,created):(String,Option<String>,String)=self.conn.query_row("SELECT body_hash,title_snapshot,created_at FROM record_versions WHERE record_key=?1 AND version_number=?2",params![target.key()?,number],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Record source version is no longer retained"))?;
            let title = title.unwrap_or_default();
            (hash, title.clone(), json!({"title":title}), created)
        } else {
            let hash: String = self
                .conn
                .query_row(
                    "SELECT body_hash FROM record_document_heads WHERE record_key=?1",
                    [target.key()?],
                    |row| row.get(0),
                )
                .optional()
                .map_err(io_error)?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Record committed document has not been initialized",
                    )
                })?;
            let (sql,tags)=match resolved.scope {
                Scope::Workspace=>("SELECT title,updated_at FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'","SELECT tag_id FROM workspace_note_tag_links WHERE workspace_note_id=?1 ORDER BY tag_id"),
                Scope::Project {..}=>("SELECT title,updated_at FROM notes WHERE id=?1","SELECT tag_id FROM note_tag_links WHERE note_id=?1 ORDER BY tag_id"),
            };
            let (title, updated): (Option<String>, String) = self
                .conn
                .query_row(sql, [target.record_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .map_err(io_error)?;
            let mut statement = self.conn.prepare(tags).map_err(io_error)?;
            let tag_ids: Vec<i64> = statement
                .query_map([target.record_id], |row| row.get(0))
                .map_err(io_error)?
                .collect::<Result<_, _>>()
                .map_err(io_error)?;
            let revision = format!(
                "sha256:{:x}",
                Sha256::digest(json!({"title":title,"tagIds":tag_ids}).to_string())
            );
            (
                hash,
                title.unwrap_or_default(),
                json!({"metadataRevision":revision}),
                updated,
            )
        };
        let revision = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({"bodyHash":body_hash,"metadata":metadata}))
                    .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid source revision"))?
            )
        );
        if input
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &revision)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Source revision changed; read its current reference again",
            ));
        }
        Ok(SourceFingerprint {
            object: resolved,
            revision,
            title,
            record_version: input.record_version,
            updated_at,
        })
    }
    pub(crate) fn source_record_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<SourceSnapshot> {
        let fingerprint = self.source_record_fingerprint(request, binding, input)?;
        let target = RecordTarget {
            scope: fingerprint.object.scope.clone(),
            record_id: fingerprint.object.id.parse().map_err(|_| {
                AgentError::new(ErrorCode::InvalidArgument, "Invalid Record source identity")
            })?,
        };
        let document = if let Some(number) = input.record_version {
            let id: String = self
                .conn
                .query_row(
                    "SELECT id FROM record_versions WHERE record_key=?1 AND version_number=?2",
                    params![target.key()?, number],
                    |row| row.get(0),
                )
                .map_err(io_error)?;
            self.record_version_get(&target, &id)?.projection.document
        } else {
            self.record_document_head(&target)?
                .ok_or_else(|| {
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Record committed document has not been initialized",
                    )
                })?
                .projection
                .document
        };
        Ok(SourceSnapshot {
            object: fingerprint.object,
            revision: fingerprint.revision,
            title: fingerprint.title,
            record_version: fingerprint.record_version,
            updated_at: fingerprint.updated_at,
            document,
        })
    }
    pub(crate) fn source_record_baseline(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<Option<(RecordTarget, crate::record_documents::RecordLegacySource)>> {
        match self.source_record_fingerprint(request, binding, input) {
            Ok(_) => Ok(None),
            Err(error)
                if error.code == ErrorCode::SourceNotReady
                    && input.object.kind == ObjectKind::Record
                    && input.revision.is_none()
                    && input.record_version.is_none()
                    && input.file_version.is_none() =>
            {
                // Fingerprinting has already confirmed ownership, current
                // binding, live scope and policy before reporting a missing head.
                let target = RecordTarget {
                    scope: input.object.scope.clone(),
                    record_id: input.object.id.parse().map_err(|_| {
                        AgentError::new(
                            ErrorCode::InvalidArgument,
                            "Invalid Record source identity",
                        )
                    })?,
                };
                let source = self.record_document_source(&target)?;
                Ok(Some((target, source)))
            }
            Err(error) => Err(error),
        }
    }
    /// Prune derived bodies whose business object/version is gone, moved, or
    /// excluded before counts/pagination are computed. Policies remain durable.
    fn source_prune_cache(&self, binding: &WorkspaceBinding, scope: &Scope) -> AgentResult<()> {
        let ownership=match scope {
            Scope::Workspace=>"EXISTS(SELECT 1 FROM workspace_notes n WHERE CAST(n.id AS TEXT)=json_extract(s.object_json,'$.id') AND n.note_kind='workspace_note')",
            Scope::Project {..}=>"EXISTS(SELECT 1 FROM notes n JOIN projects p ON p.id=n.project_id WHERE CAST(n.id AS TEXT)=json_extract(s.object_json,'$.id') AND n.project_id=?3)",
        };
        let sql=format!("DELETE FROM source_index_snapshots AS s WHERE s.workspace_id=?1 AND s.scope_key=?2 AND json_extract(s.object_json,'$.kind')='record' AND (NOT ({ownership}) OR (s.version>0 AND NOT EXISTS(SELECT 1 FROM record_versions v WHERE v.record_key=s.scope_key||':'||json_extract(s.object_json,'$.id') AND v.version_number=s.version)) OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))");
        match scope {
            Scope::Workspace => self
                .conn
                .execute(&sql, params![binding.workspace_id, scope.key()]),
            Scope::Project { project_id } => self
                .conn
                .execute(&sql, params![binding.workspace_id, scope.key(), project_id]),
        }
        .map_err(io_error)?;
        self.source_prune_file_cache(binding, scope)?;
        self.source_prune_native_cache(binding, scope)?;
        Ok(())
    }
    pub(crate) fn source_index_record(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceReadTarget,
        cached: &crate::source_search_index::IndexSource,
    ) -> AgentResult<()> {
        let current = self.source_record_fingerprint(request, binding, source)?;
        if current.revision != cached.revision {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Record changed before indexing",
            ));
        }
        if cached.object != current.object
            || cached.version != source.record_version
            || cached.current != source.record_version.is_none()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid Record index ownership",
            ));
        }
        let index = crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        self.source_prune_cache(binding, &source.object.scope)?;
        index.replace(cached)
    }
    pub(crate) fn source_search_candidates(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::source_service::SourceSearchInput,
    ) -> AgentResult<crate::source_search_index::SearchPage> {
        request.authorize(binding, &input.scope, "source.read")?;
        self.source_live_scope(&input.scope)?;
        let supported = [
            ObjectKind::Record,
            ObjectKind::File,
            ObjectKind::Project,
            ObjectKind::Todo,
            ObjectKind::QuickNote,
            ObjectKind::Transcript,
        ];
        if input.kinds.iter().any(|kind| !supported.contains(kind)) {
            return Err(AgentError::new(
                ErrorCode::SourceNotReady,
                "Requested source kind is not ready for search",
            ));
        }
        let mut selected = vec![];
        for object in &input.selected {
            if object.workspace_id != binding.workspace_id || object.scope != input.scope {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Selected source is outside this search scope",
                ));
            }
            selected.push(object.key()?);
        }
        let index = crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        self.source_prune_cache(binding, &input.scope)?;
        index.search(
            request,
            binding,
            &input.scope,
            &input.query,
            &selected,
            input.include_history,
            input.limit.unwrap_or(8),
            Some(if input.kinds.is_empty() {
                &supported
            } else {
                &input.kinds
            }),
        )
    }
    pub(crate) fn source_verify_search_page(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::source_service::SourceSearchInput,
        page: &crate::source_service::SourceSearchPage,
    ) -> AgentResult<()> {
        request.authorize(binding, &input.scope, "source.read")?;
        self.source_live_scope(&input.scope)?;
        for candidate in &page.items {
            let target = SourceReadTarget {
                object: candidate.source_ref.object.clone(),
                revision: Some(candidate.source_ref.revision.clone()),
                record_version: candidate.source_ref.record_version,
                file_version: candidate.source_ref.file_version,
            };
            match target.object.kind {
                ObjectKind::Project
                | ObjectKind::Todo
                | ObjectKind::QuickNote
                | ObjectKind::Transcript => {
                    self.source_native_snapshot(request, binding, &target)?;
                }
                ObjectKind::Record => {
                    self.source_record_fingerprint(request, binding, &target)?;
                }
                ObjectKind::File => {
                    self.source_file_search_plan(
                        request,
                        binding,
                        &target,
                        input.include_history,
                        &candidate.title,
                    )?;
                }
                ObjectKind::SessionSummary => {
                    let node = self.agent_knowledge_get(&target.object.scope, &target.object.id, None)?
                        .ok_or_else(|| AgentError::new(ErrorCode::SourceChanged, "Session summary changed"))?;
                    if node.revision.to_string() != target.revision.as_deref().unwrap_or_default()
                        || !crate::source_session_summary::visible(self, request, binding, &node)? {
                        return Err(AgentError::new(ErrorCode::SourceChanged, "Session summary changed"));
                    }
                }
                _ => {
                    return Err(AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Unsupported source search candidate",
                    ))
                }
            }
        }
        Ok(())
    }
    pub(crate) fn source_cache_capacity(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        scope: &Scope,
    ) -> AgentResult<crate::source_search_index::SourceCacheCapacity> {
        request.authorize(binding, scope, "source.read")?;
        self.source_live_scope(scope)?;
        let index = crate::source_search_index::SourceIndex::prepare(&self.conn)?;
        self.source_prune_cache(binding, scope)?;
        index.capacity(request, binding, scope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::access::{Caller, ScopeGrant},
        models::{ProjectCreateInput, ProjectRecordUpsertInput},
        record_documents::{body_hash, RecordDocumentProjection},
        source_search_index::{IndexChunk, IndexCoverage, IndexSource, SourceIndex},
        source_service::{BoundSourceStore, SourceIndexBudget, SourceSearchInput, SourceService},
    };
    struct Store {
        db: Database,
        binding: WorkspaceBinding,
    }
    impl crate::committed_changes::CommittedChangePublisher for Store {
        fn publish_committed(&self, _changes: crate::committed_changes::CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db)
        }
    }
    #[test]
    fn explicit_record_version_respects_withdrawal_for_non_gui_callers() {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(&directory.path().join("source.sqlite"), directory.path(), None).unwrap();
        let project = db.project_create(ProjectCreateInput {
            name: "Historical Record".into(), summary: None, status: None,
        }).unwrap();
        let record = db.project_record_upsert(ProjectRecordUpsertInput {
            project_id: project.id, note_id: None, title: Some("Retained".into()),
            markdown: "evidence".into(), html: "<p>evidence</p>".into(),
            default_code_language: None, tag_ids: vec![],
        }).unwrap();
        let binding = WorkspaceBinding { workspace_id: "source-workspace".into(), generation: "opened".into() };
        let target = RecordTarget { scope: Scope::Project { project_id: project.id }, record_id: record.id };
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":"evidence"}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1, body_hash: body_hash(&document, &None), document,
            html: "<p>evidence</p>".into(), markdown: "evidence".into(), text: "evidence".into(),
            code_language: None,
        };
        db.record_document_initialize(
            "gui", "record-baseline", &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection, &binding.workspace_id,
        ).unwrap();
        assert_eq!(db.record_versions_list(&target, None, 20).unwrap().versions[0].version_number, 1);
        let source = SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(), scope: target.scope.clone(),
                kind: ObjectKind::Record, id: record.id.to_string(),
            },
            revision: None, record_version: Some(1), file_version: None,
        };
        let grant = ScopeGrant {
            workspace_id: binding.workspace_id.clone(), workspace_content: false,
            project_ids: vec![project.id], operations: vec!["source.read".into()],
        };
        let mut request = RequestContext {
            binding: binding.clone(), caller: Caller::Connection { grant_id: "owned".into() },
            request_id: "historical-read".into(), scope_grant: grant,
        };
        assert!(db.source_record_fingerprint(&request, &binding, &source).is_ok());
        request.caller = Caller::BuiltinRun { run_id: "a".repeat(32) };
        assert!(db.source_record_fingerprint(&request, &binding, &source).is_ok());
        db.conn.execute(
            "INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,?2,'2026-01-02',1)",
            rusqlite::params![source.object.key().unwrap(), "b".repeat(32)],
        ).unwrap();
        request.caller = Caller::Connection { grant_id: "owned".into() };
        assert_eq!(db.source_record_fingerprint(&request, &binding, &source).err().unwrap().code, ErrorCode::ObjectWithdrawn);
        request.caller = Caller::BuiltinRun { run_id: "a".repeat(32) };
        assert_eq!(db.source_record_fingerprint(&request, &binding, &source).err().unwrap().code, ErrorCode::ObjectWithdrawn);
        request.caller = Caller::Gui;
        assert!(db.source_record_fingerprint(&request, &binding, &source).is_ok());
    }
    #[tokio::test]
    async fn source_reads_search_and_indexing_reject_an_archived_project() {
        use crate::{
            models::ProjectArchiveInput,
            source_service::{SourceReadInput, SourceReadView},
        };
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &directory.path().join("source.sqlite"),
            directory.path(),
            None,
        )
        .unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Archive policy".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let record = db
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("Archived source".into()),
                markdown: "evidence".into(),
                html: "<p>evidence</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "source-workspace".into(),
            generation: "opened".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "archive-source".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec!["source.read".into()],
            },
        };
        let target = SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: Scope::Project {
                    project_id: project.id,
                },
                kind: ObjectKind::Record,
                id: record.id.to_string(),
            },
            revision: None,
            record_version: None,
            file_version: None,
        };
        let input = SourceReadInput {
            source: target.clone(),
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        let search = SourceSearchInput {
            scope: target.object.scope.clone(),
            query: "evidence".into(),
            kinds: vec![],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        {
            let active = Store {
                db,
                binding: binding.clone(),
            };
            assert_eq!(
                SourceService::new(&active)
                    .read(&request, &input)
                    .unwrap_err()
                    .code,
                ErrorCode::SourceNotReady
            );
            assert!(SourceService::new(&active)
                .search(&request, &search)
                .await
                .unwrap()
                .items
                .is_empty());
            db = active.db;
        }
        db.project_set_archive(ProjectArchiveInput {
            project_id: project.id,
            is_archived: true,
        })
        .unwrap();
        let store = Store { db, binding };
        let service = SourceService::new(&store);
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            service.search(&request, &search).await.unwrap_err().code,
            ErrorCode::ScopeDenied
        );
        assert_eq!(
            service
                .index_record(&request, &target, SourceIndexBudget::default())
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let mut historical = input;
        historical.source.record_version = Some(1);
        assert_eq!(
            service.read(&request, &historical).unwrap_err().code,
            ErrorCode::ScopeDenied
        );
    }
    #[tokio::test]
    async fn source_search_prunes_foreign_cache_before_ranking_pagination_or_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &directory.path().join("source.sqlite"),
            directory.path(),
            None,
        )
        .unwrap();
        let visible = db
            .project_create(ProjectCreateInput {
                name: "Visible".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let private = db
            .project_create(ProjectCreateInput {
                name: "Private".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let mut private_ids = vec![];
        for _ in 0..2 {
            private_ids.push(
                db.project_record_upsert(ProjectRecordUpsertInput {
                    project_id: private.id,
                    note_id: None,
                    title: Some("private title".into()),
                    markdown: "private evidence".into(),
                    html: "<p>private evidence</p>".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap()
                .id,
            );
        }
        let record = db
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: visible.id,
                note_id: None,
                title: Some("Visible".into()),
                markdown: "visible evidence".into(),
                html: "<p>visible evidence</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "source-workspace".into(),
            generation: "opened".into(),
        };
        let target = RecordTarget {
            scope: Scope::Project {
                project_id: visible.id,
            },
            record_id: record.id,
        };
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":[{"type":"text","text":"visible evidence"}]}]});
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: "<p>visible evidence</p>".into(),
            markdown: "visible evidence".into(),
            text: "visible evidence".into(),
            code_language: None,
        };
        db.record_document_initialize(
            "gui",
            "visible-source",
            &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection,
            &binding.workspace_id,
        )
        .unwrap();
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "scope-search".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![visible.id],
                operations: vec!["source.read".into()],
            },
        };
        let source = SourceReadTarget {
            object: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: target.scope.clone(),
                kind: ObjectKind::Record,
                id: record.id.to_string(),
            },
            revision: None,
            record_version: None,
            file_version: None,
        };
        let store = Store { db, binding };
        let service = SourceService::new(&store);
        service
            .index_record(&request, &source, SourceIndexBudget::default())
            .unwrap();
        // Model an earlier cache with a wrong claimed Project. Its exact-title
        // hits would otherwise take the first page away from the visible object.
        let cache = SourceIndex::prepare(&store.db.conn).unwrap();
        for id in private_ids {
            cache
                .replace(&IndexSource {
                    object: ObjectRef {
                        workspace_id: store.binding.workspace_id.clone(),
                        scope: target.scope.clone(),
                        kind: ObjectKind::Record,
                        id: id.to_string(),
                    },
                    revision: format!("sha256:{}", "a".repeat(64)),
                    title: "evidence".into(),
                    chunks: vec![IndexChunk {
                        text: "private evidence".into(),
                        locator: crate::agent::models::SourceLocator::Paragraph {
                            start: 1,
                            end: 1,
                        },
                        block_id: None,
                    }],
                    version: None,
                    updated_at: "2026-10-01T00:00:00Z".into(),
                    current: true,
                    coverage: IndexCoverage {
                        chars: 16,
                        complete: true,
                    },
                })
                .unwrap();
        }
        let page = service
            .search(
                &request,
                &SourceSearchInput {
                    scope: target.scope.clone(),
                    query: "evidence".into(),
                    kinds: vec![],
                    selected: vec![],
                    include_history: false,
                    limit: Some(1),
                    budget_chars: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "Visible");
        assert_eq!(page.items[0].source_ref.object, source.object);
        assert_eq!(page.stale_count, 0);
        assert!(!page.has_more);
        assert_eq!(
            service
                .cache_capacity(&request, &target.scope)
                .unwrap()
                .objects,
            1
        );
        assert_eq!(
            service
                .cache_capacity(
                    &request,
                    &Scope::Project {
                        project_id: private.id
                    }
                )
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
