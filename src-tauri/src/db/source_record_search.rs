//! Search the persisted current Record projection, without waiting for extraction jobs.
use super::Database;
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, SourceRef, WorkspaceBinding},
    },
    source_search_index::{IndexCoverage, SearchCandidate, SearchPage},
    source_service::{SourceReadTarget, SourceSearchInput},
};
use rusqlite::params;

fn storage_error(_: rusqlite::Error) -> AgentError {
    AgentError::new(ErrorCode::IoFailed, "Cannot search saved Records")
}

impl Database {
    pub(crate) fn source_search_current_records(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &SourceSearchInput,
    ) -> AgentResult<SearchPage> {
        // The caller has validated the query, selected identities and live scope
        // through the shared search path. SQL applies visibility before LIMIT.
        request.authorize(binding, &input.scope, "source.read")?;
        let (table, column, predicate, project) = match input.scope {
            Scope::Workspace => (
                "agent_visible_workspace_notes",
                "workspace_note_id",
                "n.note_kind='workspace_note' AND ?1 IS NULL",
                None,
            ),
            Scope::Project { project_id } => (
                "agent_visible_notes",
                "project_note_id",
                "n.project_id=?1",
                Some(project_id),
            ),
        };
        let terms: Vec<_> = input.query.split_whitespace().collect();
        let terms_json = serde_json::to_string(&terms).expect("string array");
        let allowed = request
            .scope_grant
            .object_keys
            .as_ref()
            .map(|keys| serde_json::to_string(keys).expect("string array"));
        let selected = serde_json::to_string(
            &input
                .selected
                .iter()
                .map(ObjectRef::key)
                .collect::<AgentResult<Vec<_>>>()?,
        )
        .expect("string array");
        let sql = format!(
            r#"
            SELECT n.id, substr(h.markdown, max(1,coalesce((SELECT min(nullif(instr(lower(h.markdown),lower(t.value)),0)) FROM json_each(?5) t),1)-80),320), length(h.markdown)
            FROM {table} n JOIN record_document_heads h ON h.{column}=n.id
            WHERE {predicate}
              AND (?2 IS NULL OR ?3||'/'||?4||'/record/'||n.id IN (SELECT value FROM json_each(?2)))
              AND NOT EXISTS (SELECT 1 FROM source_access_policies p
                  WHERE p.object_key=?3||'/'||?4||'/record/'||n.id AND p.excluded=1)
              AND NOT EXISTS (SELECT 1 FROM json_each(?5) term
                  WHERE instr(lower(COALESCE(n.title,'')),lower(term.value))=0
                    AND instr(lower(h.markdown),lower(term.value))=0)
              AND (?9 IS NULL OR (
                1-(COALESCE(n.title,'')=?6 COLLATE NOCASE),
                1-(?3||'/'||?4||'/record/'||n.id IN (SELECT value FROM json_each(?7))))>(?10,?11)
                OR ((1-(COALESCE(n.title,'')=?6 COLLATE NOCASE),
                     1-(?3||'/'||?4||'/record/'||n.id IN (SELECT value FROM json_each(?7))))=(?10,?11)
                    AND (n.updated_at<?13 OR (n.updated_at=?13 AND (?3||'/'||?4||'/record/'||n.id,0)>(?9,?12)))))
            ORDER BY (COALESCE(n.title,'')=?6 COLLATE NOCASE) DESC,
                (?3||'/'||?4||'/record/'||n.id IN (SELECT value FROM json_each(?7))) DESC,
                n.updated_at DESC,?3||'/'||?4||'/record/'||n.id LIMIT ?8
        "#
        );
        let limit = input.limit.unwrap_or(8);
        let after = crate::source_search_index::cursor::position(input)?;
        let mut stmt = self.conn.prepare(&sql).map_err(storage_error)?;
        let rows = stmt
            .query_map(
                params![
                    project,
                    allowed,
                    binding.workspace_id,
                    input.scope.key(),
                    terms_json,
                    input.query.trim(),
                    selected,
                    limit as i64 + 1,
                    after.as_ref().map(|p| p.key.as_str()), after.as_ref().map(|p| p.exact),
                    after.as_ref().map(|p| p.selected), after.as_ref().map(|p| p.version),
                    after.as_ref().map(|p| p.updated_at.as_str())
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u32>(2)?,
                    ))
                },
            )
            .map_err(storage_error)?;
        let mut page = SearchPage {
            items: vec![],
            has_more: false,
        };
        for row in rows {
            let (id, markdown, chars) = row.map_err(storage_error)?;
            if page.items.len() == limit {
                page.has_more = true;
                break;
            }
            let fingerprint = self.source_record_fingerprint(
                request,
                binding,
                &SourceReadTarget {
                    object: ObjectRef {
                        workspace_id: binding.workspace_id.clone(),
                        scope: input.scope.clone(),
                        kind: ObjectKind::Record,
                        id: id.to_string(),
                    },
                    revision: None,
                    record_version: None,
                    file_version: None,
                },
            )?;
            let excerpt = matching_excerpt(&markdown, &terms);
            let title: String = fingerprint.title.chars().take(1000).collect();
            page.items.push(SearchCandidate {
                object_key: fingerprint.object.key()?,
                title: title.clone(),
                excerpt: excerpt.clone(),
                score: 0.0,
                updated_at: fingerprint.updated_at,
                source_ref: SourceRef {
                    object: fingerprint.object,
                    revision: fingerprint.revision,
                    file_version: None,
                    record_version: None,
                    block_id: None,
                    locator: None,
                    title,
                    excerpt,
                },
                coverage: IndexCoverage {
                    chars,
                    complete: true,
                },
            });
        }
        Ok(page)
    }
}

fn matching_excerpt(markdown: &str, terms: &[&str]) -> String {
    let lower_terms: Vec<_> = terms.iter().map(|s| s.to_lowercase()).collect();
    // Prefer a matching line, rather than an unrelated document preamble.
    let mut result = String::new();
    for text in markdown.lines() {
        let lower = text.to_lowercase();
        if lower_terms.iter().any(|term| lower.contains(term)) {
            if !result.is_empty() {
                result.push('\n');
            }
            result.push_str(text);
            if result.chars().count() >= 240 {
                break;
            }
        }
    }
    if result.is_empty() {
        result.extend(markdown.chars().take(240));
    }
    result.chars().take(240).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::access::{Caller, ScopeGrant},
        models::{ProjectCreateInput, ProjectRecordUpsertInput},
        record_documents::{
            body_hash, RecordDocumentCommit, RecordDocumentProjection, RecordTarget,
            RecordVersionOrigin,
        },
    };
    use serde_json::json;

    fn projection(text: &str) -> RecordDocumentProjection {
        let document = json!({"type":"doc","content":text.split('\n').enumerate().map(|(i,t)|
            json!({"type":"paragraph","attrs":{"blockId":format!("{:032x}",i+1)},"content":[{"type":"text","text":t}]})).collect::<Vec<_>>()});
        RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document,
            html: text.split('\n').map(|t| format!("<p>{t}</p>")).collect(),
            markdown: text.into(),
            text: text.into(),
            code_language: None,
        }
    }

    #[test]
    fn source_search_prepare_and_prune_preserve_epoch_and_install_all_existing_triggers() {
        let root=tempfile::tempdir().unwrap();
        let db=Database::open(&root.path().join("search.sqlite"),root.path(),None).unwrap();
        let binding=WorkspaceBinding {workspace_id:"search-epoch".into(),generation:"open".into()};
        let before=db.source_search_epoch(&binding,&Scope::Workspace).unwrap();
        // Runtime tables are prepared before Database::open returns; cache tables
        // are prepared by source_search_epoch before the marker is installed.
        for table in ["source_index_snapshots","source_index_chunks","source_access_policies",
            "source_file_version_hashes","record_document_heads","record_versions","notes","workspace_notes",
            "projects","documents","document_versions","todos","voice_records","recording_sessions",
            "voice_transcript_segments","note_tag_links","workspace_note_tag_links","document_tag_links",
            "todo_tag_links","agent_object_withdrawals","agent_knowledge_nodes","agent_knowledge_versions",
            "agent_source_policies"] {
            let exists:bool=db.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",[table],|r|r.get(0)).unwrap();
            if !exists {continue;}
            for event in ["INSERT","UPDATE","DELETE"] {
                let name=format!("source_search_epoch_{table}_{event}");
                let installed:bool=db.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",[&name],|r|r.get(0)).unwrap();
                assert!(installed,"missing {name}");
            }
        }
        for table in ["agent_session_search_rows","agent_run_provenance","agent_run_source_dependencies"] {
            for event in ["UPDATE","DELETE"] {
                let name=format!("source_search_epoch_{table}_{event}");
                let installed:bool=db.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?1)",[&name],|r|r.get(0)).unwrap();
                assert!(installed,"missing {name}");
            }
        }
        for _ in 0..4 {
            assert_eq!(db.source_search_epoch(&binding,&Scope::Workspace).unwrap(),before,
                "prepare/prune must not invalidate the next CLI page");
        }
    }

    #[test]
    fn cold_record_search_matches_across_title_and_paragraphs_and_tracks_commits() {
        let directory = tempfile::tempdir().unwrap();
        let mut db = Database::open(
            &directory.path().join("search.sqlite"),
            directory.path(),
            None,
        )
        .unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "search".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let record = db
            .project_record_upsert(ProjectRecordUpsertInput {
                project_id: project.id,
                note_id: None,
                title: Some("云商店火车时刻表".into()),
                markdown: "11月\n排期\n100% _literal".into(),
                html: "<p>11月</p><p>排期</p><p>100% _literal</p>".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "search-workspace".into(),
            generation: "opened".into(),
        };
        let scope = Scope::Project {
            project_id: project.id,
        };
        let target = RecordTarget {
            scope: scope.clone(),
            record_id: record.id,
        };
        db.record_document_initialize(
            "gui",
            "initialize",
            &target,
            &db.record_document_source(&target).unwrap().source_hash,
            &projection("11月\n排期\n100% _literal"),
            &binding.workspace_id,
        )
        .unwrap();
        let mut request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Connection {
                grant_id: "search".into(),
            },
            request_id: "query".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec!["source.read".into()],
                object_keys: None,
            },
        };
        let mut input = SourceSearchInput {
            scope: scope.clone(),
            query: "火车 11月 排期".into(),
            kinds: vec![ObjectKind::Record],
            selected: vec![],
            include_history: false,
            limit: Some(8),
            budget_chars: None,
            cursor: None,
        };
        let page = db
            .source_search_candidates(&request, &binding, &input)
            .unwrap();
        assert_eq!(
            page.items.len(),
            1,
            "new saved Record is searchable with no background index"
        );
        assert_eq!(page.items[0].source_ref.object.id, record.id.to_string());
        assert!(page.items[0].excerpt.contains("11月\n排期"));
        assert!(page.items[0].coverage.complete);
        let old_revision = page.items[0].source_ref.revision.clone();
        let key = page.items[0].object_key.clone();
        request.scope_grant.object_keys = Some(vec![]);
        assert!(db
            .source_search_candidates(&request, &binding, &input)
            .unwrap()
            .items
            .is_empty());
        request.scope_grant.object_keys = Some(vec![key.clone()]);
        assert_eq!(
            db.source_search_candidates(&request, &binding, &input)
                .unwrap()
                .items
                .len(),
            1
        );
        db.conn
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",
                [&key],
            )
            .unwrap();
        assert!(db
            .source_search_candidates(&request, &binding, &input)
            .unwrap()
            .items
            .is_empty());
        db.conn
            .execute(
                "DELETE FROM source_access_policies WHERE object_key=?1",
                [&key],
            )
            .unwrap();
        input.query = "% _literal".into();
        assert_eq!(
            db.source_search_candidates(&request, &binding, &input)
                .unwrap()
                .items
                .len(),
            1
        );
        input.query = "% not-present".into();
        assert!(db
            .source_search_candidates(&request, &binding, &input)
            .unwrap()
            .items
            .is_empty());
        db.record_document_commit(
            "gui",
            "commit",
            &RecordDocumentCommit {
                target: target.clone(),
                base_revision: 1,
                projection: projection("12月\n新排期"),
                origin: RecordVersionOrigin::Manual,
                actor: json!({"kind":"gui"}),
                edit_session_id: Some("a".repeat(32)),
            },
            &binding.workspace_id,
        )
        .unwrap();
        input.query = "11月".into();
        assert!(db
            .source_search_candidates(&request, &binding, &input)
            .unwrap()
            .items
            .is_empty());
        input.query = "火车 12月 排期".into();
        let updated = db
            .source_search_candidates(&request, &binding, &input)
            .unwrap();
        assert_eq!(updated.items.len(), 1);
        assert_ne!(updated.items[0].source_ref.revision, old_revision);
        // A realistic cold catalogue: 3,000 saved 4 KiB bodies, with no source-index jobs.
        let filler = projection(&"ordinary project detail ".repeat(180));
        db.conn.execute("WITH RECURSIVE n(i) AS (SELECT 10000 UNION ALL SELECT i+1 FROM n WHERE i<12999) INSERT INTO notes(id,project_id,title,created_at,updated_at) SELECT i,?1,'Other record','2026-10-01','2026-10-01' FROM n",[project.id]).unwrap();
        db.conn.execute("INSERT INTO record_document_heads(record_key,project_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,updated_at) SELECT 'project:'||project_id||':'||id,id,1,?1,?2,?3,?4,?5,1,'2026-10-01' FROM notes WHERE id BETWEEN 10000 AND 12999",params![filler.document.to_string(),filler.html,filler.markdown,filler.text,filler.body_hash]).unwrap();
        request.scope_grant.object_keys = None;
        let start = std::time::Instant::now();
        let measured = db
            .source_search_candidates(&request, &binding, &input)
            .unwrap();
        assert_eq!(measured.items.len(), 1);
        eprintln!(
            "cold saved-Record search (3,001 records, ~12 MiB body text): {:?}",
            start.elapsed()
        );
        db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,?2,'2026-10-29',1)",params![key,"b".repeat(32)]).unwrap();
        assert!(db
            .source_search_candidates(&request, &binding, &input)
            .unwrap()
            .items
            .is_empty());
        request.scope_grant.project_ids.clear();
        assert_eq!(
            db.source_search_candidates(&request, &binding, &input)
                .err()
                .unwrap()
                .code,
            ErrorCode::ScopeDenied
        );
    }
}
