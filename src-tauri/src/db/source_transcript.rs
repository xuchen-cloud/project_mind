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
    // Metadata-only semantic fingerprint: never allocate the full Transcript.
    pub(crate) fn source_transcript_snapshot(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
    ) -> AgentResult<NativeSourceSnapshot> {
        self.source_transcript_prefix(request, binding, input, 0, 0)
            .map(|(snapshot, _)| snapshot)
    }
    pub(crate) fn source_transcript_prefix(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
        max_chars: usize,
        max_segments: usize,
    ) -> AgentResult<(NativeSourceSnapshot, bool)> {
        self.source_transcript_scan(request, binding, input, max_chars, max_segments, None)
            .map(|(snapshot, complete, _, _)| (snapshot, complete))
    }
    pub(crate) fn source_transcript_window(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &crate::source_service::SourceReadInput,
        offset: usize,
    ) -> AgentResult<(
        NativeSourceSnapshot,
        String,
        Vec<crate::source_text_page::TextSpan>,
        bool,
    )> {
        let (snapshot, complete, text, spans) = self.source_transcript_scan(
            request,
            binding,
            &input.source,
            0,
            0,
            Some((input, offset)),
        )?;
        Ok((snapshot, text, spans, !complete))
    }
    fn source_transcript_scan(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceReadTarget,
        max_chars: usize,
        max_segments: usize,
        window: Option<(&crate::source_service::SourceReadInput, usize)>,
    ) -> AgentResult<(
        NativeSourceSnapshot,
        bool,
        String,
        Vec<crate::source_text_page::TextSpan>,
    )> {
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
        let title = format!("{title} · Transcript");
        let mut digest = Sha256::new();
        digest.update(b"{\"segments\":[");
        let mut statement = self.conn.prepare("SELECT t.id,t.start_ms,t.end_ms,t.text,t.language,t.created_at FROM voice_transcript_segments t JOIN recording_sessions r ON r.id=t.session_id WHERE r.voice_record_id=?1 ORDER BY t.start_ms,t.id").map_err(io_error)?;
        let mut rows = statement.query([&object.id]).map_err(io_error)?;
        let mut paragraphs = vec![];
        let mut locators = vec![];
        let mut updated_at = String::new();
        let mut total_chars = 0usize;
        let mut complete = true;
        let mut first = true;
        let mut window_text = String::new();
        let mut window_spans = vec![];
        let mut selected_bytes = 0usize;
        let mut selected_chars = 0usize;
        let mut selected_nonempty = false;
        let mut selected_any = false;
        let mut window_more = false;
        let mut invalid_offset = false;
        while let Some(row) = rows.next().map_err(io_error)? {
            // The final-segment writer enforces 16 KiB. Check the borrowed
            // value before copying text from a corrupt or legacy oversized row.
            if let rusqlite::types::ValueRef::Text(bytes) = row.get_ref(3).map_err(io_error)? {
                if bytes.len() > 16384 {
                    return Err(AgentError::new(
                        ErrorCode::BudgetExceeded,
                        "Persisted Transcript segment exceeds its byte budget",
                    ));
                }
            }
            let id: String = row.get(0).map_err(io_error)?;
            let start: i64 = row.get(1).map_err(io_error)?;
            let end: i64 = row.get(2).map_err(io_error)?;
            let text: String = row.get(3).map_err(io_error)?;
            let language: Option<String> = row.get(4).map_err(io_error)?;
            let created_at: String = row.get(5).map_err(io_error)?;
            let start = u64::try_from(start)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid Transcript time"))?;
            let end = u64::try_from(end)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid Transcript time"))?;
            if start >= end || end > crate::agent::models::MAX_SAFE_SOURCE_TIME_MS {
                return Err(AgentError::new(
                    ErrorCode::IoFailed,
                    "Invalid Transcript time range",
                ));
            }
            if !first {
                digest.update(b",");
            }
            first = false;
            digest.update(serde_json::json!({"id":id,"startMs":start,"endMs":end,"text":text,"language":language}).to_string().as_bytes());
            if let Some((read, offset)) = window {
                let selected = match read.selection.as_ref().and_then(|s| s.locator.as_ref()) {
                    Some(SourceLocator::Time { start_ms, end_ms }) => {
                        end > *start_ms && start < *end_ms
                    }
                    _ => true,
                };
                if selected {
                    selected_any = true;
                    let separator = if selected_nonempty { "\n\n" } else { "" };
                    for (part, evidence) in [(separator, false), (text.as_str(), true)] {
                        let part_end = selected_bytes + part.len();
                        if offset < part_end && selected_chars < 12000 {
                            let local = offset.saturating_sub(selected_bytes);
                            if !part.is_char_boundary(local) {
                                invalid_offset = true;
                                selected_bytes = part_end;
                                continue;
                            }
                            let remaining = 12000 - selected_chars;
                            let tail = &part[local..];
                            let bytes = tail
                                .char_indices()
                                .nth(remaining)
                                .map(|(byte, _)| byte)
                                .unwrap_or(tail.len());
                            let span_start = selected_chars;
                            window_text.push_str(&tail[..bytes]);
                            selected_chars += tail[..bytes].chars().count();
                            if evidence && selected_chars > span_start {
                                window_spans.push(crate::source_text_page::TextSpan {
                                    start: span_start,
                                    end: selected_chars,
                                    block_id: None,
                                    locator: SourceLocator::Time {
                                        start_ms: start,
                                        end_ms: end,
                                    },
                                });
                            }
                            if local + bytes < part.len() {
                                window_more = true;
                            }
                        } else if offset < part_end {
                            window_more = true;
                        }
                        selected_bytes = part_end;
                    }
                    selected_nonempty = selected_nonempty || !text.is_empty();
                }
            }
            let chars = text.chars().count();
            if complete && total_chars < max_chars && paragraphs.len() < max_segments {
                let allowed = chars.min(max_chars - total_chars);
                total_chars += allowed;
                paragraphs.push(text.chars().take(allowed).collect());
                locators.push(SourceLocator::Time {
                    start_ms: start,
                    end_ms: end,
                });
                complete = allowed == chars;
            } else {
                complete = false;
            }
            updated_at = updated_at.max(created_at);
        }
        digest.update(b"],\"title\":");
        digest.update(
            serde_json::to_vec(&title)
                .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot hash Transcript"))?,
        );
        digest.update(b"}");
        let revision = format!("sha256:{:x}", digest.finalize());
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
        if let Some((read, _)) = window {
            if crate::source_text_page::decode_cursor(read)?
                .is_some_and(|cursor| cursor.revision != revision)
            {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Original Transcript changed",
                ));
            }
        }
        if let Some((read, offset)) = window {
            if invalid_offset
                || offset > selected_bytes
                || (read.cursor.is_some() && offset == selected_bytes)
                || (read.selection.is_some() && !selected_any)
            {
                return Err(AgentError::new(
                    ErrorCode::InvalidArgument,
                    "Source cursor or range is outside the selected text",
                ));
            }
            complete = !window_more;
        }
        Ok((
            NativeSourceSnapshot {
                object,
                revision,
                title,
                paragraphs,
                locators,
                updated_at,
            },
            complete,
            window_text,
            window_spans,
        ))
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
                WHERE v.id=CAST(json_extract(s.object_json,'$.id') AS INTEGER) AND CAST(v.id AS TEXT)=json_extract(s.object_json,'$.id') AND ((?3 IS NULL AND w.id IS NOT NULL) OR (n.project_id=?3 AND p.is_archived=0)))
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
                object_keys: None,
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
    #[tokio::test]
    async fn source_transcript_over_ten_thousand_segments_are_readable_and_partial_index_searchable(
    ) {
        let (_root, store, request, mut input, session, _) = setup(false);
        store.db.lock().unwrap().conn.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) SELECT 'budget-'||i,?1,i,i+1,'检索字','2026-10-01T00:00:00Z' FROM n", [&session]).unwrap();
        let service = SourceService::new(&store);
        let first = service.read(&request, &input).unwrap();
        assert!(!first.complete);
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Time {
                start_ms: 10000,
                end_ms: 10002,
            }),
        });
        assert_eq!(
            service.read(&request, &input).unwrap().text,
            "检索字\n\n检索字"
        );
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let query = SourceSearchInput {
            scope: Scope::Workspace,
            query: "检索字".into(),
            kinds: vec![ObjectKind::Transcript],
            selected: vec![],
            include_history: false,
            limit: None,
            budget_chars: None,
        };
        let found = service.search(&request, &query).await.unwrap();
        assert_eq!(found.items.len(), 1);
        assert!(!found.items[0].coverage.complete);
    }
    #[test]
    fn source_transcript_over_two_mebi_chars_reads_tail_without_loading_all_text() {
        let (_root, store, request, mut input, session, _) = setup(false);
        let text = "🙂字".repeat(2048);
        let db = store.db.lock().unwrap();
        db.conn.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<513) INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) SELECT 'large-'||i,?1,i*10000,i*10000+1000,?2,'2026-10-01T00:00:00Z' FROM n", rusqlite::params![session, text]).unwrap();
        drop(db);
        let service = SourceService::new(&store);
        assert!(service
            .read(&request, &input)
            .unwrap()
            .next_cursor
            .is_some());
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Time {
                start_ms: 5130000,
                end_ms: 5131000,
            }),
        });
        input.budget_chars = Some(12000);
        let page = service.read(&request, &input).unwrap();
        assert_eq!(page.text, text);
        assert!(page.range_complete);
        service
            .index_native(&request, &input.source, SourceIndexBudget::default())
            .unwrap();
        let (snapshot, complete) = store
            .db
            .lock()
            .unwrap()
            .source_transcript_prefix(
                &request,
                &store.binding,
                &input.source,
                2 * 1024 * 1024,
                10000,
            )
            .unwrap();
        assert!(!complete);
        assert_eq!(
            snapshot
                .paragraphs
                .iter()
                .map(|p| p.chars().count())
                .sum::<usize>(),
            2 * 1024 * 1024
        );
    }
    #[test]
    fn source_transcript_range_pages_stitch_unicode_separators_and_keep_original_times() {
        let (_root, store, request, mut input, session, _) = setup(false);
        let db = store.db.lock().unwrap();
        db.voice_transcript_append_final(
            &session,
            "range-a",
            1000,
            9000,
            &"🙂中文\"\\".repeat(500),
            None,
        )
        .unwrap();
        db.voice_transcript_append_final(
            &session,
            "range-b",
            8000,
            10000,
            &"第二原段🙂".repeat(600),
            None,
        )
        .unwrap();
        // Empty legacy finals keep the established double-newline semantics.
        db.conn.execute("INSERT INTO voice_transcript_segments(id,session_id,start_ms,end_ms,text,created_at) VALUES ('empty',?1,9500,9600,'','2026-10-01')", [&session]).unwrap();
        let expected = format!(
            "{}\n\n{}\n\n",
            "🙂中文\"\\".repeat(500),
            "第二原段🙂".repeat(600)
        );
        drop(db);
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Time {
                start_ms: 2000,
                end_ms: 9800,
            }),
        });
        input.budget_chars = Some(1400);
        let service = SourceService::new(&store);
        let mut collected = String::new();
        loop {
            let page = service.read(&request, &input).unwrap();
            assert!(serde_json::to_string(&page).unwrap().chars().count() <= 1400);
            assert!(!page.complete);
            for span in &page.spans {
                assert!(span.end <= page.text.chars().count());
                assert!(matches!(
                    span.locator,
                    SourceLocator::Time {
                        start_ms: 1000,
                        end_ms: 9000
                    } | SourceLocator::Time {
                        start_ms: 8000,
                        end_ms: 10000
                    }
                ));
            }
            collected.push_str(&page.text);
            if page.next_cursor.is_none() {
                assert!(page.range_complete);
                break;
            }
            input.cursor = page.next_cursor;
        }
        assert_eq!(collected, expected);
    }
    #[test]
    fn source_transcript_stream_hash_matches_original_json_and_old_cursor_rejects_mutation() {
        use sha2::{Digest, Sha256};
        let (_root, store, request, mut input, session, _) = setup(false);
        let expected = format!("sha256:{:x}", Sha256::digest(serde_json::json!({"title":"会议原话 · Transcript","segments":[{"id":format!("{session}:first"),"startMs":100,"endMs":500,"text":"真实原话🙂","language":"zh"}]}).to_string()));
        let service = SourceService::new(&store);
        assert_eq!(
            service.read(&request, &input).unwrap().source_ref.revision,
            expected
        );
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(
                &session,
                "long",
                1000,
                9000,
                &"🙂中文字".repeat(1000),
                None,
            )
            .unwrap();
        input.budget_chars = Some(1400);
        input.cursor = service.read(&request, &input).unwrap().next_cursor;
        store
            .db
            .lock()
            .unwrap()
            .conn
            .execute(
                "UPDATE voice_transcript_segments SET text='修订原话' WHERE provider_key='first'",
                [],
            )
            .unwrap();
        assert_eq!(
            service.read(&request, &input).unwrap_err().code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn source_transcript_abnormal_persisted_segment_rejected_before_owned_allocation() {
        let (_root, store, request, input, _, _) = setup(false);
        store.db.lock().unwrap().conn.execute("UPDATE voice_transcript_segments SET text=replace(hex(zeroblob(20000)), '00', '字') WHERE provider_key='first'", []).unwrap();
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::BudgetExceeded
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
    #[test]
    fn source_transcript_does_not_return_or_accept_unsafe_numeric_time_locators() {
        let (_root, store, request, mut input, session, _) = setup(false);
        input.view = SourceReadView::Range;
        input.selection = Some(SourceSelection {
            block_id: None,
            locator: Some(SourceLocator::Time {
                start_ms: 100,
                end_ms: 9_007_199_254_740_992,
            }),
        });
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        store
            .db
            .lock()
            .unwrap()
            .voice_transcript_append_final(
                &session,
                "too-long",
                1000,
                9_007_199_254_740_992,
                "不能安全表示的时间",
                None,
            )
            .unwrap();
        input.view = SourceReadView::Full;
        input.selection = None;
        assert_eq!(
            SourceService::new(&store)
                .read(&request, &input)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
    }
}
