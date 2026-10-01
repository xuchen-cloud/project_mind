//! Final persisted Transcript segments remain independent of editable Record bodies.
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, SourceLocator, WorkspaceBinding},
    },
    source_native::NativeSourceSnapshot,
    source_service::SourceReadTarget,
};
use sha2::{Digest, Sha256};
fn io_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot read original Transcript")
}
impl Database {
    pub(crate) fn source_transcript_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<NativeSourceSnapshot> {
        let object = self.source_read_object(request, binding, &input.object)?;
        if object.kind != ObjectKind::Transcript
            || input.record_version.is_some()
            || input.file_version.is_some()
        {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Transcript does not have Record or File versions",
            ));
        }
        let title: String = self.conn.query_row("SELECT COALESCE(n.title,w.title,'Voice') FROM voice_records v LEFT JOIN notes n ON n.id=v.project_note_id LEFT JOIN workspace_notes w ON w.id=v.workspace_note_id WHERE v.id=?1", [&object.id], |row| row.get(0)).map_err(io_error)?;
        // Check aggregate size before allocating rows. This internal snapshot is
        // bounded; oversize raw transcripts require a future segmented reader,
        // rather than silently returning a truncated 'complete' source.
        let (chars, count): (i64,i64) = self.conn.query_row("SELECT COALESCE(SUM(length(t.text)),0),COUNT(*) FROM voice_transcript_segments t JOIN recording_sessions r ON r.id=t.session_id WHERE r.voice_record_id=?1", [&object.id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(io_error)?;
        if chars > 2 * 1024 * 1024 || count > 10000 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Transcript exceeds the internal source snapshot budget",
            ));
        }
        let mut statement = self.conn.prepare("SELECT t.id,t.start_ms,t.end_ms,t.text,t.language,t.created_at FROM voice_transcript_segments t JOIN recording_sessions r ON r.id=t.session_id WHERE r.voice_record_id=?1 ORDER BY t.start_ms,t.id").map_err(io_error)?;
        let segments = statement
            .query_map([&object.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(io_error)?;
        let mut paragraphs = vec![];
        let mut locators = vec![];
        let mut semantic = vec![];
        let mut updated_at = String::new();
        let mut total_chars = 0usize;
        for segment in segments {
            let (id, start, end, text, language, created_at) = segment.map_err(io_error)?;
            total_chars += text.chars().count();
            if total_chars > 2 * 1024 * 1024 || paragraphs.len() >= 10000 {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Transcript exceeds the internal source snapshot budget",
                ));
            }
            let start = u64::try_from(start)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid Transcript time"))?;
            let end = u64::try_from(end)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid Transcript time"))?;
            if start >= end {
                return Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "Invalid Transcript time range",
                ));
            }
            semantic.push(serde_json::json!({"id":id,"startMs":start,"endMs":end,"text":text,"language":language}));
            paragraphs.push(text);
            locators.push(SourceLocator::Time {
                start_ms: start,
                end_ms: end,
            });
            updated_at = updated_at.max(created_at);
        }
        let title = format!("{title} · Transcript");
        let revision = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::json!({"title":title,"segments":semantic}).to_string())
        );
        if input
            .revision
            .as_ref()
            .is_some_and(|expected| expected != &revision)
        {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "Original Transcript changed",
            ));
        }
        Ok(NativeSourceSnapshot {
            object,
            revision,
            title,
            paragraphs,
            locators,
            updated_at,
        })
    }
    pub(super) fn source_prune_transcript_cache(
        &self,
        binding: &WorkspaceBinding,
        scope: &crate::agent::models::Scope,
    ) -> AgentResult<()> {
        let project_id = match scope {
            crate::agent::models::Scope::Project { project_id } => Some(*project_id),
            _ => None,
        };
        self.conn.execute("DELETE FROM source_index_snapshots AS s WHERE s.workspace_id=?1 AND s.scope_key=?2 AND json_extract(s.object_json,'$.kind')='transcript'
            AND (s.version!=0 OR NOT EXISTS(SELECT 1 FROM voice_records v LEFT JOIN notes n ON n.id=v.project_note_id LEFT JOIN workspace_notes w ON w.id=v.workspace_note_id LEFT JOIN projects p ON p.id=n.project_id
                WHERE CAST(v.id AS TEXT)=json_extract(s.object_json,'$.id') AND ((?3 IS NULL AND w.id IS NOT NULL) OR (n.project_id=?3 AND p.is_archived=0)))
                OR EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.object_key AND x.excluded=1))", rusqlite::params![binding.workspace_id,scope.key(),project_id]).map_err(io_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::Database;
    use crate::{
        agent::{
            access::{Caller, RequestContext, ScopeGrant},
            errors::{AgentResult, ErrorCode},
            models::{ObjectKind, ObjectRef, Scope, SourceLocator, WorkspaceBinding},
        },
        committed_changes::{CommittedChangePublisher, CommittedChanges},
        source_service::{
            BoundSourceStore, SourceIndexBudget, SourceReadInput, SourceReadTarget, SourceReadView,
            SourceSearchInput, SourceSelection, SourceService,
        },
    };
    use std::sync::Mutex;
    struct Store {
        binding: WorkspaceBinding,
        db: Mutex<Database>,
    }
    impl CommittedChangePublisher for Store {
        fn publish_committed(&self, _: CommittedChanges) {}
    }
    impl BoundSourceStore for Store {
        fn with_current<T>(
            &self,
            action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
        ) -> AgentResult<T> {
            action(&self.binding, &self.db.lock().unwrap())
        }
    }
    fn setup(
        project: bool,
    ) -> (
        tempfile::TempDir,
        Store,
        RequestContext,
        SourceReadInput,
        String,
        i64,
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
        let scope = if project {
            let project = db
                .project_create(crate::models::ProjectCreateInput {
                    name: "Private".into(),
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
        let voice_target = match scope {
            Scope::Workspace => crate::voice::contracts::RecordTarget::Workspace,
            Scope::Project { project_id } => {
                crate::voice::contracts::RecordTarget::Project { project_id }
            }
        };
        let voice = db
            .voice_session_create(
                &voice_target,
                "transcript-source",
                "transcript-session",
                "会议原话",
            )
            .unwrap();
        let id: i64 = db
            .conn
            .query_row(
                "SELECT voice_record_id FROM recording_sessions WHERE id=?1",
                [&voice.session_id],
                |row| row.get(0),
            )
            .unwrap();
        let record_id: i64 = db
            .conn
            .query_row(
                "SELECT COALESCE(project_note_id,workspace_note_id) FROM voice_records WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        db.voice_transcript_append_final(
            &voice.session_id,
            "first",
            100,
            500,
            "真实原话🙂",
            Some("zh"),
        )
        .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "w".into(),
            generation: "g".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "read".into(),
            scope_grant: ScopeGrant {
                workspace_id: "w".into(),
                workspace_content: true,
                project_ids: match scope {
                    Scope::Project { project_id } => vec![project_id],
                    _ => vec![],
                },
                operations: vec!["source.read".into(), "settings.write".into()],
            },
        };
        let input = SourceReadInput {
            source: SourceReadTarget {
                object: ObjectRef {
                    workspace_id: "w".into(),
                    scope,
                    kind: ObjectKind::Transcript,
                    id: id.to_string(),
                },
                revision: None,
                record_version: None,
                file_version: None,
            },
            view: SourceReadView::Full,
            selection: None,
            cursor: None,
            budget_chars: None,
        };
        (
            root,
            Store {
                binding,
                db: Mutex::new(db),
            },
            request,
            input,
            voice.session_id,
            record_id,
        )
    }
    #[tokio::test]
    async fn source_transcript_reads_final_original_words_and_indexes_real_time_ranges() {
        let (_root, store, request, mut input, session, _) = setup(false);
        let service = SourceService::new(&store);
        let first = service.read(&request, &input).unwrap();
        assert_eq!(first.text, "真实原话🙂");
        assert!(first.complete);
        assert!(first.source_ref.block_id.is_none());
        assert!(first.source_ref.record_version.is_none());
        assert!(matches!(
            first.source_ref.locator,
            Some(SourceLocator::Time {
                start_ms: 100,
                end_ms: 500
            })
        ));
        assert_eq!(first.source_ref.title, "会议原话 · Transcript");
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "真实原话".into(),
            kinds: vec![ObjectKind::Transcript],
            selected: vec![],
            include_history: true,
            limit: None,
            budget_chars: None,
        };
        let found = service.search(&request, &query).await.unwrap();
        assert_eq!(found.items.len(), 1);
        assert!(matches!(
            found.items[0].source_ref.locator,
            Some(SourceLocator::Time {
                start_ms: 100,
                end_ms: 500
            })
        ));
        input.source.revision = Some(first.source_ref.revision);
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(&session, "second", 800, 1200, "后来的原话", None)
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::SourceChanged
        );
        assert!(service
            .search(&request, &query)
            .await
            .unwrap()
            .items
            .is_empty());
        input.source.revision = None;
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Time {
                start_ms: 700,
                end_ms: 1200,
            }),
        });
        let range = service.read(&request, &input).unwrap();
        assert_eq!(range.text, "后来的原话");
        assert!(range.range_complete);
        assert!(!range.complete);
    }
    #[tokio::test]
    async fn source_transcript_enforces_owner_grant_generation_exclusion_and_version_rejection() {
        let (_root, mut store, mut request, input, _, _) = setup(true);
        let mut wrong = input.clone();
        wrong.source.object.scope = Scope::Workspace;
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &wrong)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        request.scope_grant.project_ids.clear();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        let Scope::Project { project_id } = input.source.object.scope else {
            panic!()
        };
        request.scope_grant.project_ids.push(project_id);
        let mut versioned = input.clone();
        versioned.source.record_version = Some(1);
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &versioned)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        SourceService::new(&store)
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        SourceService::new(&store)
            .set_policy(
                &request,
                &crate::source_service::SourcePolicyUpdate {
                    object: input.source.object.clone(),
                    expected_revision: 0,
                    excluded: true,
                },
            )
            .unwrap();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        request.request_id = "unexclude".into();
        SourceService::new(&store)
            .set_policy(
                &request,
                &crate::source_service::SourcePolicyUpdate {
                    object: input.source.object.clone(),
                    expected_revision: 1,
                    excluded: false,
                },
            )
            .unwrap();
        store
            .db
            .lock()
            .unwrap()
            .conn
            .execute(
                "UPDATE projects SET is_archived=1 WHERE id=?1",
                [project_id],
            )
            .unwrap();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        store.binding.generation = "reopened".into();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
    }
    #[tokio::test]
    async fn source_transcript_unicode_paging_budget_and_deletion_preserve_honest_coverage() {
        let (_root, store, request, mut input, session, record_id) = setup(false);
        let long = "🙂中文字".repeat(1000);
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(&session, "long", 1000, 9000, &long, None)
            .unwrap();
        input.budget_chars = Some(1400);
        let service = SourceService::new(&store);
        let mut text = String::new();
        loop {
            let page = service.read(&request, &input).unwrap();
            assert!(serde_json::to_string(&page).unwrap().chars().count() <= 1400);
            text.push_str(&page.text);
            if page.next_cursor.is_none() {
                assert!(page.complete);
                break;
            }
            assert!(!page.complete);
            input.cursor = page.next_cursor;
        }
        assert_eq!(text, format!("真实原话🙂\n\n{long}"));
        service
            .index_native(
                &request,
                &input.source,
                SourceIndexBudget {
                    max_chars: 1000,
                    max_chunks: 10,
                },
            )
            .unwrap();
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "中文字".into(),
            kinds: vec![ObjectKind::Transcript],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        let found = service.search(&request, &query).await.unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].coverage.chars, 1000);
        assert!(!found.items[0].coverage.complete);
        let db = store.db.lock().unwrap();
        let revision: i64 = db
            .conn
            .query_row(
                "SELECT revision FROM recording_sessions WHERE id=?1",
                [&session],
                |row| row.get(0),
            )
            .unwrap();
        db.voice_session_transition(&session, revision as u64, "ended", None, 9000, 1)
            .unwrap();
        db.conn
            .execute("DELETE FROM workspace_notes WHERE id=?1", [record_id])
            .unwrap();
        drop(db);
        assert!(service
            .search(&request, &query)
            .await
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            service
                .cache_capacity(&request, &Scope::Workspace)
                .unwrap()
                .snapshots,
            0
        );
    }
    #[test]
    fn source_transcript_overlapping_segments_keep_the_full_evidence_time_envelope() {
        let (_root, store, request, input, session, _) = setup(false);
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(&session, "long-overlap", 10, 10000, "长时间范围", None)
            .unwrap();
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(&session, "nested", 20, 50, "嵌套范围", None)
            .unwrap();
        let page = SourceService::new(&store).read(&request, &input).unwrap();
        assert!(matches!(
            page.source_ref.locator,
            Some(SourceLocator::Time {
                start_ms: 10,
                end_ms: 10000
            })
        ));
    }
    #[test]
    fn source_transcript_final_fence_rejects_a_segment_committed_after_projection() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (_root, store, request, input, session, _) = setup(false);
        struct Changing<'a> {
            store: &'a Store,
            session: &'a str,
            phase: AtomicUsize,
        }
        impl CommittedChangePublisher for Changing<'_> {
            fn publish_committed(&self, _: CommittedChanges) {}
        }
        impl BoundSourceStore for Changing<'_> {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                let db = self.store.db.lock().unwrap();
                if self.phase.fetch_add(1, Ordering::SeqCst) == 1 {
                    db.voice_transcript_append_final(
                        self.session,
                        "late",
                        1200,
                        1300,
                        "后来提交的原话",
                        None,
                    )
                    .unwrap();
                }
                action(&self.store.binding, &db)
            }
        }
        let changing = Changing {
            store: &store,
            session: &session,
            phase: AtomicUsize::new(0),
        };
        assert_eq!(
            SourceService::new(&changing)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn source_transcript_oversize_snapshot_is_rejected_without_fake_complete_coverage() {
        let (_root, store, request, input, session, _) = setup(false);
        store.db.lock().unwrap().conn.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) SELECT 'budget-'||i,?1,i,i+1,'字','2026-10-01T00:00:00Z' FROM n", [&session]).unwrap();
        let service = SourceService::new(&store);
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            service
                .index_native(&request, &input.source, SourceIndexBudget::default())
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
        );
        assert_eq!(
            service
                .cache_capacity(&request, &Scope::Workspace)
                .unwrap()
                .snapshots,
            0
        );
    }
    #[test]
    fn source_transcript_revision_ignores_editable_body_and_duplicate_final_delivery() {
        let (_root, store, request, input, session, record_id) = setup(false);
        let service = SourceService::new(&store);
        let before = service.read(&request, &input).unwrap();
        let mut db = store.db.lock().unwrap();
        db.workspace_record_upsert(crate::models::WorkspaceRecordUpsertInput {
            note_id: Some(record_id),
            title: Some("会议原话".into()),
            html: "<p>改过的纪要正文</p>".into(),
            markdown: "改过的纪要正文".into(),
            default_code_language: None,
            tag_ids: vec![],
        })
        .unwrap();
        db.voice_transcript_append_final(&session, "first", 100, 500, "真实原话🙂", Some("zh"))
            .unwrap();
        drop(db);
        let after = service.read(&request, &input).unwrap();
        assert_eq!(after.source_ref.revision, before.source_ref.revision);
        assert_eq!(after.text, "真实原话🙂");
        assert!(!after.text.contains("纪要"));
    }
}
