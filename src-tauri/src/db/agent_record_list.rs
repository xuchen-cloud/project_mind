//! Native metadata and counts share the same visibility/filter predicate.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    context::serialized_chars,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    record_list::{RecordListInput, RecordListItem, RecordListPage},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

fn invalid(message: &'static str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    query_hash: String,
    seq: i64,
    record: i64,
}

fn cursor(hash: &str, seq: i64, record: i64) -> AgentResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            query_hash: hash.into(),
            seq,
            record,
        })
        .map_err(|_| invalid("Cannot encode Record cursor"))?,
    ))
}

impl Database {
    pub(crate) fn agent_record_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &RecordListInput,
    ) -> AgentResult<RecordListPage> {
        request.authorize(binding, &input.scope, "source.read")?;
        input.scope.validate()?;
        crate::agent::listing::validate_filters(
            &input.ids,
            input.title_query.as_deref(),
            input.content_query.as_deref(),
        )?;
        if input.ids.iter().any(|id| {
            id.parse::<i64>()
                .ok()
                .filter(|n| *n > 0 && n.to_string() == *id)
                .is_none()
        }) {
            return Err(invalid("Invalid Record ID"));
        }
        let limit = input.limit.unwrap_or(20);
        let budget = input.budget_chars.unwrap_or(4000);
        if limit > 50
            || !(1..=12000).contains(&budget)
            || input.tag_ids.len() > 50
            || input.tag_ids.iter().any(|id| *id <= 0)
            || input
                .tag
                .as_ref()
                .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 240)
        {
            return Err(invalid("Invalid Record list limit, budget or tag filter"));
        }
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Record Workspace is no longer current",
            ));
        }
        self.source_live_scope(&input.scope)?;
        self.source_prepare()?;
        let mut tag_ids = input.tag_ids.clone();
        tag_ids.sort_unstable();
        tag_ids.dedup();
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&json!({
            "method":"record.list", "binding":request.binding,"caller":request.caller.key(),
            "grant":{"workspace":request.scope_grant.workspace_id,
                "workspaceContent":request.scope_grant.workspace_content,
                "projects":request.scope_grant.project_ids,"operations":request.scope_grant.operations,
                "objects":request.scope_grant.object_keys},
            "scope":input.scope,"tag":input.tag,"tagIds":tag_ids,"mode":input.mode,
            "ids":input.ids,"titleQuery":input.title_query,"contentQuery":input.content_query,
        })).map_err(|_| invalid("Cannot encode Record query"))?));
        let seq: i64 = self
            .conn
            .query_row(
                "SELECT total_changes() + data_version FROM pragma_data_version",
                [],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        let after = if let Some(raw) = &input.cursor {
            if raw.len() > 2048 {
                return Err(invalid("Invalid Record cursor"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(raw)
                .map_err(|_| invalid("Invalid Record cursor"))?;
            let c: Cursor =
                serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid Record cursor"))?;
            if c.record <= 0 || c.seq < 0 || c.query_hash != hash {
                return Err(invalid(
                    "Record cursor belongs to different filters or authorization",
                ));
            }
            if c.seq != seq {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Record list changed; restart without a cursor",
                ));
            }
            c.record
        } else {
            0
        };
        // These identifiers are internal constants, never caller-supplied SQL.
        let (table, links, id_column, head_column, scope_filter, project) = match input.scope {
            Scope::Workspace => (
                "agent_visible_workspace_notes",
                "workspace_note_tag_links",
                "workspace_note_id",
                "workspace_note_id",
                "n.note_kind='workspace_note' AND ?1 IS NULL",
                None,
            ),
            Scope::Project { project_id } => (
                "agent_visible_notes",
                "note_tag_links",
                "note_id",
                "project_note_id",
                "n.project_id=?1",
                Some(project_id),
            ),
        };
        let body = format!("COALESCE((SELECT h.markdown FROM record_document_heads h WHERE h.{head_column}=n.id),n.content_markdown)");
        let predicate = format!(
            r#"
            FROM {table} n WHERE {scope_filter}
            AND (?2 IS NULL OR ?3||'/'||?4||'/record/'||n.id IN (SELECT value FROM json_each(?2)))
            AND NOT EXISTS(SELECT 1 FROM source_access_policies p
                WHERE p.object_key=?3||'/'||?4||'/record/'||n.id AND p.excluded=1)
            AND (?5 IS NULL OR EXISTS(SELECT 1 FROM {links} l JOIN file_tag_options t ON t.id=l.tag_id
                WHERE l.{id_column}=n.id AND t.label=?5))
            AND NOT EXISTS(SELECT 1 FROM json_each(?6) wanted WHERE NOT EXISTS(
                SELECT 1 FROM {links} l WHERE l.{id_column}=n.id AND l.tag_id=wanted.value))
            AND (json_array_length(?7)=0 OR CAST(n.id AS TEXT) IN (SELECT value FROM json_each(?7)))
            AND (?8 IS NULL OR instr(lower(COALESCE(n.title,'')),lower(?8))>0)
            AND (?9 IS NULL OR instr(lower({body}),lower(?9))>0)
        "#
        );
        let objects = request
            .scope_grant
            .object_keys
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| invalid("Cannot encode Record grant"))?;
        let tags = serde_json::to_string(&tag_ids).map_err(|_| invalid("Cannot encode tags"))?;
        let ids =
            serde_json::to_string(&input.ids).map_err(|_| invalid("Cannot encode Record IDs"))?;
        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(*) {predicate}"),
                params![
                    project,
                    objects,
                    binding.workspace_id,
                    input.scope.key(),
                    input.tag,
                    tags,
                    ids,
                    input.title_query,
                    input.content_query
                ],
                |r| r.get(0),
            )
            .map_err(io_error)?;
        let mut page = RecordListPage {
            scope: input.scope.clone(),
            items: vec![],
            total_count: total as usize,
            stale_count: 0,
            next_cursor: None,
            has_more: false,
        };
        if limit == 0 {
            if serialized_chars(&page)? > budget {
                return Err(AgentError::new(
                    ErrorCode::BudgetExceeded,
                    "Record count budget cannot fit the response",
                ));
            }
            return Ok(page);
        }
        let mut statement = self
            .conn
            .prepare(&format!(
                r#"
            SELECT n.id,n.title,n.created_at,n.updated_at,
                (SELECT h.updated_at FROM record_document_heads h WHERE h.{head_column}=n.id),
                EXISTS(SELECT 1 FROM voice_records v WHERE v.{head_column}=n.id),
                CASE WHEN ?12 THEN {body} END
            {predicate} AND n.id>?10 ORDER BY n.id LIMIT ?11
        "#
            ))
            .map_err(io_error)?;
        let candidates = statement
            .query_map(
                params![
                    project,
                    objects,
                    binding.workspace_id,
                    input.scope.key(),
                    input.tag,
                    tags,
                    ids,
                    input.title_query,
                    input.content_query,
                    after,
                    (limit + 1) as i64,
                    input.mode == crate::agent::listing::ListMode::Detail
                ],
                |row| {
                    Ok(RecordListItem {
                        object: ObjectRef {
                            workspace_id: binding.workspace_id.clone(),
                            scope: input.scope.clone(),
                            kind: ObjectKind::Record,
                            id: row.get::<_, i64>(0)?.to_string(),
                        },
                        title: row.get(1)?,
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        last_edited_at: row.get(4)?,
                        record_type: if row.get::<_, bool>(5)? {
                            "voice"
                        } else {
                            "text"
                        },
                        tags: vec![],
                        content: row.get(6)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let count = candidates.len();
        for (index, mut item) in candidates.into_iter().take(limit).enumerate() {
            self.source_read_object(request, binding, &item.object)?;
            let id = item.object.id.parse::<i64>().expect("native Record ID");
            item.tags = match input.scope {
                Scope::Workspace => self.fetch_workspace_note_tags(id),
                Scope::Project { .. } => self.fetch_note_tags(id),
            }
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot read Record tags"))?;
            page.items.push(item);
            page.has_more = index + 1 < count;
            page.next_cursor = if page.has_more {
                Some(cursor(&hash, seq, id)?)
            } else {
                None
            };
            let required = serialized_chars(&page)?;
            if required > budget {
                page.items.pop();
                let Some(last) = page.items.last() else {
                    return Err(AgentError::new(
                        ErrorCode::BudgetExceeded,
                        "Record list budget cannot fit one item",
                    )
                    .with_details(json!({"minimumBudgetChars":required})));
                };
                page.has_more = true;
                page.next_cursor = Some(cursor(
                    &hash,
                    seq,
                    last.object.id.parse().expect("native Record ID"),
                )?);
                break;
            }
        }
        if serialized_chars(&page)? > budget {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Record list budget cannot fit the response",
            ));
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::access::{Caller, ScopeGrant},
        models::{ProjectCreateInput, ProjectRecordUpsertInput, WorkspaceRecordUpsertInput},
        source_service::SourcePolicyUpdate,
    };

    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        request: RequestContext,
        project: i64,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let mut db =
                Database::open(&root.path().join("todo-list.sqlite"), root.path(), None).unwrap();
            db.bind_native_workspace("todo-list").unwrap();
            let project = db
                .project_create(ProjectCreateInput {
                    name: "List fixture".into(),
                    summary: None,
                    status: None,
                })
                .unwrap()
                .id;
            let binding = WorkspaceBinding {
                workspace_id: "todo-list".into(),
                generation: "one".into(),
            };
            let request = RequestContext {
                binding: binding.clone(),
                caller: Caller::Gui,
                request_id: "read-list".into(),
                scope_grant: ScopeGrant {
                    workspace_id: binding.workspace_id.clone(),
                    workspace_content: true,
                    project_ids: vec![project],
                    operations: vec!["source.read".into(), "settings.write".into()],
                    object_keys: None,
                },
            };
            Self {
                _root: root,
                db,
                request,
                project,
            }
        }

        fn create(&mut self, project: bool, title: &str) -> i64 {
            if project {
                self.db
                    .project_record_upsert(ProjectRecordUpsertInput {
                        project_id: self.project,
                        note_id: None,
                        title: Some(title.into()),
                        markdown: "SECRET BODY".repeat(10000),
                        html: "<p>SECRET BODY</p>".into(),
                        default_code_language: None,
                        tag_ids: vec![],
                    })
                    .unwrap()
                    .id
            } else {
                self.db
                    .workspace_record_upsert(WorkspaceRecordUpsertInput {
                        note_id: None,
                        title: Some(title.into()),
                        markdown: "SECRET BODY".into(),
                        html: "<p>SECRET BODY</p>".into(),
                        default_code_language: None,
                        tag_ids: vec![],
                    })
                    .unwrap()
                    .id
            }
        }
        fn input(&self) -> RecordListInput {
            serde_json::from_value(
                json!({"scope":{"kind":"project","projectId":self.project},"limit":1}),
            )
            .unwrap()
        }
        fn list(&self, input: &RecordListInput) -> AgentResult<RecordListPage> {
            self.db
                .agent_record_list(&self.request, &self.request.binding, input)
        }
        fn object(&self, id: i64) -> ObjectRef {
            ObjectRef {
                workspace_id: "todo-list".into(),
                scope: Scope::Project {
                    project_id: self.project,
                },
                kind: ObjectKind::Record,
                id: id.to_string(),
            }
        }
    }
    #[test]
    fn metadata_counts_and_pagination_do_not_read_bodies_or_search_index() {
        let mut f = Fixture::new();
        let first = f.create(true, "First");
        let second = f.create(true, "Second");
        f.create(false, "Workspace");
        f.db.conn
            .execute(
                "INSERT INTO voice_records(project_note_id,created_at) VALUES (?1,'now')",
                [second],
            )
            .unwrap();
        let mut input = f.input();
        let page = f.list(&input).unwrap();
        assert_eq!(page.total_count, 2);
        assert_eq!(page.stale_count, 0);
        assert!(page.has_more);
        assert_eq!(page.items[0].object, f.object(first));
        assert_eq!(page.items[0].title.as_deref(), Some("First"));
        assert_eq!(page.items[0].record_type, "text");
        let raw = serde_json::to_string(&page).unwrap();
        assert!(!raw.contains("SECRET BODY"));
        assert!(!raw.contains("markdown"));
        assert!(!raw.contains("content"));
        let mut counts = input.clone();
        counts.limit = Some(0);
        counts.budget_chars = Some(200);
        let counted = f.list(&counts).unwrap();
        assert_eq!(counted.total_count, 2);
        assert!(counted.items.is_empty() && !counted.has_more && counted.next_cursor.is_none());
        input.cursor = page.next_cursor;
        let page = f.list(&input).unwrap();
        assert_eq!(page.total_count, 2);
        assert!(!page.has_more);
        assert!(page.next_cursor.is_none());
        assert_eq!(page.items[0].record_type, "voice");
        input.scope = Scope::Workspace;
        input.cursor = None;
        assert_eq!(f.list(&input).unwrap().total_count, 1);
        input.tag = Some("missing".into());
        let empty = f.list(&input).unwrap();
        assert_eq!(empty.total_count, 0);
        assert!(empty.items.is_empty());
    }
    #[test]
    fn tags_filter_before_counts_and_pagination() {
        let mut f = Fixture::new();
        f.create(true, "Unmatched");
        let id = f.create(true, "Tagged");
        let tag =
            f.db.upsert_project_tag_by_label(f.project, "Topic", "blue", "now")
                .unwrap();
        f.db.replace_note_tags(id, &[tag], "now").unwrap();
        let mut input = f.input();
        input.tag = Some("Topic".into());
        input.tag_ids = vec![tag, tag];
        let page = f.list(&input).unwrap();
        assert_eq!(page.total_count, 1);
        assert_eq!(page.items[0].object, f.object(id));
        assert_eq!(page.items[0].tags[0].label, "Topic");
        input.tag = Some("topic".into());
        assert_eq!(f.list(&input).unwrap().total_count, 1);
        input.tag = None;
        input.tag_ids.push(999999);
        assert_eq!(f.list(&input).unwrap().total_count, 0);
    }
    #[test]
    fn visibility_counts_scope_and_cursor_authorization_are_enforced() {
        let mut f = Fixture::new();
        let a = f.create(true, "Visible");
        let b = f.create(true, "Excluded");
        let c = f.create(true, "Withdrawn");
        f.db.source_policy_update(
            &f.request,
            &f.request.binding,
            &SourcePolicyUpdate {
                object: f.object(b),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        f.db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'fixture','now',1)",[f.object(c).key().unwrap()]).unwrap();
        let mut input = f.input();
        assert_eq!(f.list(&input).unwrap().total_count, 1);
        f.request.scope_grant.object_keys = Some(vec![]);
        assert_eq!(f.list(&input).unwrap().total_count, 0);
        f.request.scope_grant.object_keys = Some(vec![f.object(a).key().unwrap()]);
        assert_eq!(f.list(&input).unwrap().total_count, 1);
        f.request.scope_grant.object_keys = None;
        f.create(true, "Another");
        input.cursor = f.list(&input).unwrap().next_cursor;
        input.tag = Some("different".into());
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::InvalidArgument);
        input.tag = None;
        f.create(true, "Change");
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::SourceChanged);
        input.cursor = None;
        f.request.scope_grant.project_ids.clear();
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::ScopeDenied);
        f.request.scope_grant.project_ids.push(f.project);
        let mut stale = f.request.binding.clone();
        stale.generation = "other".into();
        assert_eq!(
            f.db.agent_record_list(&f.request, &stale, &input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        f.db.conn
            .execute("UPDATE projects SET is_archived=1 WHERE id=?1", [f.project])
            .unwrap();
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::ScopeDenied);
    }
    #[test]
    fn bounds_and_response_budget_are_enforced() {
        let mut f = Fixture::new();
        f.create(true, "Title");
        let input = f.input();
        for extra in [
            json!({"limit":51}),
            json!({"budgetChars":12001}),
            json!({"tagIds":[-1]}),
            json!({"tag":" "}),
            json!({"cursor":"bad"}),
        ] {
            let mut value = serde_json::to_value(&input).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(
                f.list(&serde_json::from_value(value).unwrap())
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidArgument
            );
        }
        let mut input = input;
        input.budget_chars = Some(1);
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::BudgetExceeded);
    }
    #[test]
    fn ids_title_content_filters_and_detail_mode_share_exact_counts() {
        let mut f = Fixture::new();
        let a = f.create(true, "Plan% Alpha");
        f.create(true, "Other");
        f.db.conn
            .execute(
                "UPDATE notes SET content_markdown='A committed Needle' WHERE id=?1",
                [a],
            )
            .unwrap();
        let mut input = f.input();
        input.ids = vec![a.to_string()];
        input.title_query = Some("% alpha".into());
        input.content_query = Some("needle".into());
        let metadata = f.list(&input).unwrap();
        assert_eq!(metadata.total_count, 1);
        assert!(metadata.items[0].content.is_none());
        input.mode = crate::agent::listing::ListMode::Detail;
        let details = f.list(&input).unwrap();
        assert_eq!(
            details.items[0].content.as_deref(),
            Some("A committed Needle")
        );
        input.content_query = Some("absent".into());
        assert_eq!(f.list(&input).unwrap().total_count, 0);
        input.content_query = None;
        input.title_query = Some("_".into());
        assert_eq!(f.list(&input).unwrap().total_count, 0);
    }
}
