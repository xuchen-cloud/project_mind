//! Read-only GUI source destinations resolved from actual storage ownership.
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, SourceLocator, SourceRef, WorkspaceBinding},
        source_navigation::{SourceLocationStatus, SourceNavigation, SourceNavigationStatus},
    },
    record_documents::{document_block_ids, RecordTarget},
    source_service::SourceReadTarget,
};
use rusqlite::params;
fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot resolve source navigation")
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn validate(source: &SourceRef) -> AgentResult<()> {
    source.object.key()?;
    if source.revision.len() != 71
        || !source.revision.starts_with("sha256:")
        || !source.revision.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        || source.title.chars().count() > 1000
        || source.excerpt.chars().count() > 2000
        || source.file_version.is_some()
        || source.record_version == Some(0)
        || source.block_id.as_ref().is_some_and(|id| {
            id.len() != 32
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return Err(invalid("Invalid cited source identity or version"));
    }
    match source.object.kind {
        ObjectKind::Record => {
            if source.locator.as_ref().is_some_and(|locator| !matches!(locator, SourceLocator::Paragraph { start, end } if *start > 0 && end >= start)) {
                return Err(invalid("Record navigation requires a paragraph locator"));
            }
        }
        ObjectKind::Transcript => {
            if source.record_version.is_some() || source.block_id.is_some()
                || source.locator.as_ref().is_some_and(|locator| !matches!(locator, SourceLocator::Time { start_ms, end_ms } if start_ms < end_ms && *end_ms <= crate::agent::models::MAX_SAFE_SOURCE_TIME_MS)) {
                return Err(invalid("Transcript navigation requires a valid time range"));
            }
        }
        _ => return Err(AgentError::new(ErrorCode::ToolCallUnsupported, "This source uses its existing native navigation entry")),
    }
    Ok(())
}
impl Database {
    pub(crate) fn agent_source_resolve(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        source: &SourceRef,
    ) -> AgentResult<SourceNavigation> {
        validate(source)?;
        // Authorize the current binding before disclosing even an unavailable
        // destination. The source reader then checks actual ownership/policy.
        request.authorize(binding, &source.object.scope, "source.read")?;
        let object = match self.source_read_object(request, binding, &source.object) {
            Ok(object) => object,
            Err(error) if error.code == ErrorCode::NotFound => {
                return Ok(SourceNavigation::unavailable(
                    source,
                    SourceNavigationStatus::NotFound,
                ))
            }
            Err(error) => return Err(error),
        };
        let selected = SourceReadTarget {
            object: object.clone(),
            revision: None,
            record_version: source.record_version,
            file_version: None,
        };
        let mut result = SourceNavigation::unavailable(source, SourceNavigationStatus::Current);
        match object.kind {
            ObjectKind::Record => {
                let target = RecordTarget {
                    scope: object.scope.clone(),
                    record_id: object
                        .id
                        .parse()
                        .map_err(|_| invalid("Invalid Record identity"))?,
                };
                result.record_target = Some(target.clone());
                let fingerprint = match self.source_record_fingerprint(request, binding, &selected)
                {
                    Ok(fingerprint) => fingerprint,
                    Err(error) if error.code == ErrorCode::NotFound => {
                        result.status = SourceNavigationStatus::NotFound;
                        return Ok(result);
                    }
                    Err(error) if error.code == ErrorCode::SourceNotReady => {
                        result.status = SourceNavigationStatus::NotReady;
                        return Ok(result);
                    }
                    Err(error) => return Err(error),
                };
                let (document, revision) = if let Some(number) = source.record_version {
                    let id: String = self.conn.query_row("SELECT id FROM record_versions WHERE record_key=?1 AND version_number=?2", params![target.key()?,number], |row|row.get(0)).map_err(io_error)?;
                    let version = self.record_version_get(&target, &id)?;
                    result.record_version_id = Some(version.id);
                    (version.projection.document, version.head_revision)
                } else {
                    let head = self.record_document_head(&target)?.ok_or_else(|| {
                        AgentError::new(
                            ErrorCode::SourceNotReady,
                            "Record document is not initialized",
                        )
                    })?;
                    (head.projection.document, head.head_revision)
                };
                result.head_revision = Some(revision);
                if let Some(id) = &source.block_id {
                    if document_block_ids(&document)
                        .iter()
                        .any(|block| block == id)
                    {
                        result.block_id = Some(id.clone());
                        result.block_status = SourceLocationStatus::Available;
                    }
                }
                result.current_revision = Some(fingerprint.revision);
            }
            ObjectKind::Transcript => {
                let snapshot = self.source_transcript_snapshot(request, binding, &selected)?;
                let (project_note_id, workspace_note_id): (Option<i64>, Option<i64>) = self
                    .conn
                    .query_row(
                        "SELECT project_note_id,workspace_note_id FROM voice_records WHERE id=?1",
                        [&object.id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(io_error)?;
                let record_id = project_note_id.or(workspace_note_id).ok_or_else(|| {
                    AgentError::new(ErrorCode::NotFound, "Transcript owning Record is missing")
                })?;
                result.record_target = Some(RecordTarget {
                    scope: object.scope.clone(),
                    record_id,
                });
                result.voice_record_id = Some(
                    object
                        .id
                        .parse()
                        .map_err(|_| invalid("Invalid Voice Record identity"))?,
                );
                if let Some(SourceLocator::Time { start_ms, end_ms }) = source.locator {
                    let range: (Option<i64>, Option<i64>) = self.conn.query_row("SELECT MIN(t.start_ms),MAX(t.end_ms) FROM voice_transcript_segments t JOIN recording_sessions r ON r.id=t.session_id WHERE r.voice_record_id=?1 AND t.end_ms>?2 AND t.start_ms<?3", params![&object.id,start_ms as i64,end_ms as i64], |row|Ok((row.get(0)?,row.get(1)?))).map_err(io_error)?;
                    if let (Some(first), Some(last)) = range {
                        result.start_ms = Some(start_ms.max(first as u64));
                        result.end_ms = Some(end_ms.min(last as u64));
                        result.time_status = SourceLocationStatus::Available;
                    }
                }
                result.current_revision = Some(snapshot.revision);
            }
            _ => unreachable!("validate only accepts Record or Transcript"),
        }
        let matches = result.current_revision.as_deref() == Some(source.revision.as_str());
        result.revision_matches = Some(matches);
        result.status = if !matches {
            SourceNavigationStatus::Changed
        } else if source.record_version.is_some() {
            SourceNavigationStatus::Historical
        } else {
            SourceNavigationStatus::Current
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            models::{ObjectRef, Scope},
        },
        models::{ProjectCreateInput, ProjectRecordUpsertInput, WorkspaceRecordUpsertInput},
        record_documents::{
            body_hash, RecordDocumentCommit, RecordDocumentProjection, RecordVersionOrigin,
        },
    };
    use serde_json::json;
    const FIRST_BLOCK: &str = "1234567890abcdef1234567890abcdef";
    const SECOND_BLOCK: &str = "abcdef1234567890abcdef1234567890";
    fn setup(project: bool) -> (tempfile::TempDir, Database, RequestContext, Scope) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("navigation.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("navigation-workspace").unwrap();
        let scope = if project {
            let project = db
                .project_create(ProjectCreateInput {
                    name: "Owned project".into(),
                    summary: None,
                    status: None,
                })
                .unwrap();
            Scope::Project {
                project_id: project.id,
            }
        } else {
            Scope::Workspace
        };
        let binding = WorkspaceBinding {
            workspace_id: "navigation-workspace".into(),
            generation: "generation-1".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "resolve-source".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id,
                workspace_content: scope == Scope::Workspace,
                project_ids: match scope {
                    Scope::Project { project_id } => vec![project_id],
                    _ => vec![],
                },
                operations: vec!["source.read".into()],
            },
        };
        (root, db, request, scope)
    }
    fn add_record(db: &mut Database, scope: &Scope) -> RecordTarget {
        let record_id = match scope {
            Scope::Workspace => {
                db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                    note_id: None,
                    title: Some("Owned record".into()),
                    html: "<p>evidence</p>".into(),
                    markdown: "evidence".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap()
                .id
            }
            Scope::Project { project_id } => {
                db.project_record_upsert(ProjectRecordUpsertInput {
                    project_id: *project_id,
                    note_id: None,
                    title: Some("Owned record".into()),
                    html: "<p>evidence</p>".into(),
                    markdown: "evidence".into(),
                    default_code_language: None,
                    tag_ids: vec![],
                })
                .unwrap()
                .id
            }
        };
        RecordTarget {
            scope: scope.clone(),
            record_id,
        }
    }
    fn projection(block: &str) -> RecordDocumentProjection {
        let document = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":block},"content":[{"type":"text","text":"evidence"}]}]});
        RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: "<p>evidence</p>".into(),
            markdown: "evidence".into(),
            text: "evidence".into(),
            code_language: None,
        }
    }
    fn target(
        request: &RequestContext,
        record: &RecordTarget,
        version: Option<u32>,
    ) -> SourceReadTarget {
        SourceReadTarget {
            object: ObjectRef {
                workspace_id: request.binding.workspace_id.clone(),
                scope: record.scope.clone(),
                kind: ObjectKind::Record,
                id: record.record_id.to_string(),
            },
            revision: None,
            record_version: version,
            file_version: None,
        }
    }
    fn record_ref(db: &Database, request: &RequestContext, target: &SourceReadTarget) -> SourceRef {
        let fingerprint = db
            .source_record_fingerprint(request, &request.binding, target)
            .unwrap();
        SourceRef {
            object: fingerprint.object,
            revision: fingerprint.revision,
            file_version: None,
            record_version: target.record_version,
            block_id: Some(FIRST_BLOCK.into()),
            locator: Some(SourceLocator::Paragraph { start: 1, end: 1 }),
            title: "Evidence".into(),
            excerpt: "evidence".into(),
        }
    }
    #[test]
    fn source_navigation_resolves_owned_record_blocks_and_historical_revision_without_rebasing() {
        for project in [false, true] {
            let (_root, mut db, request, scope) = setup(project);
            let record = add_record(&mut db, &scope);
            db.record_document_initialize(
                "gui",
                "initialize-navigation",
                &record,
                &db.record_document_source(&record).unwrap().source_hash,
                &projection(FIRST_BLOCK),
                &request.binding.workspace_id,
            )
            .unwrap();
            let current_source = record_ref(&db, &request, &target(&request, &record, None));
            let current = db
                .agent_source_resolve(&request, &request.binding, &current_source)
                .unwrap();
            assert_eq!(current.status, SourceNavigationStatus::Current);
            assert_eq!(current.record_target.unwrap().record_id, record.record_id);
            assert_eq!(current.block_status, SourceLocationStatus::Available);
            assert_eq!(current.block_id.as_deref(), Some(FIRST_BLOCK));
            assert_eq!(current.head_revision, Some(1));

            let old_source = record_ref(&db, &request, &target(&request, &record, Some(1)));
            db.record_document_commit(
                "gui",
                "change-navigation",
                &RecordDocumentCommit {
                    target: record.clone(),
                    base_revision: 1,
                    projection: projection(SECOND_BLOCK),
                    origin: RecordVersionOrigin::Manual,
                    actor: json!({"kind":"gui"}),
                    edit_session_id: Some("abcdefabcdefabcdefabcdefabcdefab".into()),
                },
                &request.binding.workspace_id,
            )
            .unwrap();
            let changed = db
                .agent_source_resolve(&request, &request.binding, &current_source)
                .unwrap();
            assert_eq!(changed.status, SourceNavigationStatus::Changed);
            assert_eq!(changed.revision_matches, Some(false));
            assert_eq!(changed.block_status, SourceLocationStatus::Missing);
            assert!(changed.block_id.is_none());
            let old = db
                .agent_source_resolve(&request, &request.binding, &old_source)
                .unwrap();
            assert_eq!(old.status, SourceNavigationStatus::Historical);
            assert_eq!(old.head_revision, Some(1));
            assert_eq!(old.block_id.as_deref(), Some(FIRST_BLOCK));
            let version = db
                .record_version_get(&record, old.record_version_id.as_deref().unwrap())
                .unwrap();
            assert_eq!(version.version_number, 1);

            let mut unavailable = old_source.clone();
            unavailable.record_version = Some(99);
            let missing = db
                .agent_source_resolve(&request, &request.binding, &unavailable)
                .unwrap();
            assert_eq!(missing.status, SourceNavigationStatus::NotFound);
            assert!(missing.head_revision.is_none());
            unavailable.record_version = None;
            unavailable.object.id = "99999".into();
            let missing = db
                .agent_source_resolve(&request, &request.binding, &unavailable)
                .unwrap();
            assert_eq!(missing.status, SourceNavigationStatus::NotFound);
            assert!(missing.record_target.is_none());
            let mut switched = request.binding.clone();
            switched.generation = "generation-2".into();
            assert_eq!(
                db.agent_source_resolve(&request, &switched, &current_source)
                    .unwrap_err()
                    .code,
                ErrorCode::WorkspaceChanged
            );
        }
    }
    #[test]
    fn source_navigation_transcript_resolves_real_owning_record_when_voice_id_differs() {
        for project in [false, true] {
            let (_root, mut db, request, scope) = setup(project);
            add_record(&mut db, &scope);
            add_record(&mut db, &scope);
            let voice_target = match scope {
                Scope::Workspace => crate::voice::contracts::RecordTarget::Workspace,
                Scope::Project { project_id } => {
                    crate::voice::contracts::RecordTarget::Project { project_id }
                }
            };
            let session = db
                .voice_session_create(
                    &voice_target,
                    "navigation-voice",
                    "navigation-session",
                    "Voice evidence",
                )
                .unwrap();
            db.voice_transcript_append_final(
                &session.session_id,
                "segment-1",
                1000,
                3000,
                "Original evidence",
                None,
            )
            .unwrap();
            let (voice_id, record_id): (i64,i64) = db.conn.query_row("SELECT v.id,COALESCE(v.project_note_id,v.workspace_note_id) FROM voice_records v JOIN recording_sessions r ON r.voice_record_id=v.id WHERE r.id=?1", [&session.session_id], |row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            assert_ne!(voice_id, record_id);
            let read = SourceReadTarget {
                object: ObjectRef {
                    workspace_id: request.binding.workspace_id.clone(),
                    scope: scope.clone(),
                    kind: ObjectKind::Transcript,
                    id: voice_id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            };
            let fingerprint = db
                .source_transcript_snapshot(&request, &request.binding, &read)
                .unwrap();
            let mut source = SourceRef {
                object: fingerprint.object,
                revision: fingerprint.revision,
                file_version: None,
                record_version: None,
                block_id: None,
                locator: Some(SourceLocator::Time {
                    start_ms: 1500,
                    end_ms: 2500,
                }),
                title: "Voice evidence".into(),
                excerpt: "Original evidence".into(),
            };
            let resolved = db
                .agent_source_resolve(&request, &request.binding, &source)
                .unwrap();
            assert_eq!(resolved.status, SourceNavigationStatus::Current);
            assert_eq!(resolved.record_target.unwrap().record_id, record_id);
            assert_eq!(resolved.voice_record_id, Some(voice_id));
            assert_eq!(resolved.start_ms, Some(1500));
            assert_eq!(resolved.end_ms, Some(2500));
            assert_eq!(resolved.time_status, SourceLocationStatus::Available);
            source.locator = Some(SourceLocator::Time {
                start_ms: 5000,
                end_ms: 6000,
            });
            let missing = db
                .agent_source_resolve(&request, &request.binding, &source)
                .unwrap();
            assert_eq!(missing.time_status, SourceLocationStatus::Missing);
            assert!(missing.start_ms.is_none());
            db.voice_transcript_append_final(
                &session.session_id,
                "segment-2",
                4000,
                4500,
                "Later evidence",
                None,
            )
            .unwrap();
            assert_eq!(
                db.agent_source_resolve(&request, &request.binding, &source)
                    .unwrap()
                    .status,
                SourceNavigationStatus::Changed
            );
            let mut denied = request.clone();
            denied.scope_grant.workspace_content = false;
            denied.scope_grant.project_ids.clear();
            assert_eq!(
                db.agent_source_resolve(&denied, &request.binding, &source)
                    .unwrap_err()
                    .code,
                ErrorCode::ScopeDenied
            );
        }
    }
    #[test]
    fn source_navigation_preserves_actual_ownership_and_uninitialized_record_state() {
        let (_root, mut db, request, scope) = setup(true);
        let record = add_record(&mut db, &scope);
        let mut source = SourceRef {
            object: target(&request, &record, None).object,
            revision: format!("sha256:{}", "a".repeat(64)),
            file_version: None,
            record_version: None,
            block_id: Some(FIRST_BLOCK.into()),
            locator: None,
            title: "Legacy record".into(),
            excerpt: "".into(),
        };
        let legacy = db
            .agent_source_resolve(&request, &request.binding, &source)
            .unwrap();
        assert_eq!(legacy.status, SourceNavigationStatus::NotReady);
        assert_eq!(legacy.record_target.unwrap().record_id, record.record_id);
        assert!(legacy.head_revision.is_none());
        let foreign = db
            .project_create(ProjectCreateInput {
                name: "Other project".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        source.object.scope = Scope::Project {
            project_id: foreign.id,
        };
        let mut forged = request;
        forged.scope_grant.project_ids.push(foreign.id);
        assert_eq!(
            db.agent_source_resolve(&forged, &forged.binding, &source)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
