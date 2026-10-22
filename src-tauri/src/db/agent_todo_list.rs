//! Current native actions, independent of full-text indexing. Visibility and
//! filters precede pagination; a cursor pins the grant, filters and change log.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    context::serialized_chars,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    todo_tools::{TodoListInput, TodoListItem, TodoListPage},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::NaiveDate;
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
    todo: i64,
    child: i64,
}
fn encode_cursor(cursor: &Cursor) -> AgentResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(cursor)
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Todo cursor"))?,
    ))
}
fn decode_cursor(raw: &str) -> AgentResult<Cursor> {
    if raw.len() > 2048 {
        return Err(invalid("Invalid Todo cursor"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| invalid("Invalid Todo cursor"))?;
    let cursor: Cursor =
        serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid Todo cursor"))?;
    if cursor.todo <= 0 || cursor.child < 0 || cursor.seq < 0 {
        return Err(invalid("Invalid Todo cursor"));
    }
    Ok(cursor)
}
fn query_hash(request: &RequestContext, input: &TodoListInput) -> AgentResult<String> {
    let bytes = serde_json::to_vec(&json!({
        "binding":request.binding,"caller":request.caller.key(),
        "grant":{"workspace":request.scope_grant.workspace_id,
            "workspaceContent":request.scope_grant.workspace_content,
            "projects":request.scope_grant.project_ids,"operations":request.scope_grant.operations,
            "objects":request.scope_grant.object_keys},
        "scope":input.scope,"status":input.status,"from":input.due_from,"to":input.due_to,
        "undated":input.undated,"children":input.include_children,
    }))
    .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Todo query"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn validate(input: &TodoListInput) -> AgentResult<()> {
    input.scope.validate()?;
    if input
        .status
        .as_deref()
        .is_some_and(|s| !crate::agent::outputs::TODO_STATUSES.contains(&s))
    {
        return Err(invalid("Todo status must be unfinished or finished"));
    }
    for date in [&input.due_from, &input.due_to].into_iter().flatten() {
        if date.len() != 10
            || NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .is_none_or(|parsed| parsed.format("%Y-%m-%d").to_string() != *date)
        {
            return Err(invalid("Todo date bounds must be valid YYYY-MM-DD dates"));
        }
    }
    if input.undated && (input.due_from.is_some() || input.due_to.is_some()) {
        return Err(invalid("undated cannot accompany dueFrom or dueTo"));
    }
    if input
        .due_from
        .as_ref()
        .zip(input.due_to.as_ref())
        .is_some_and(|(a, b)| a > b)
    {
        return Err(invalid("dueFrom must not be later than dueTo"));
    }
    if !(1..=50).contains(&input.limit.unwrap_or(20)) {
        return Err(invalid("Todo list limit must be between 1 and 50"));
    }
    if !(1..=12000).contains(&input.budget_chars.unwrap_or(4000)) {
        return Err(invalid("Todo list budgetChars must be between 1 and 12000"));
    }
    Ok(())
}

impl Database {
    pub(crate) fn agent_todo_list(
        &self,
        request: &RequestContext,
        binding: &WorkspaceBinding,
        input: &TodoListInput,
    ) -> AgentResult<TodoListPage> {
        request.authorize(binding, &input.scope, "source.read")?;
        validate(input)?;
        if self
            .native_workspace_id
            .as_deref()
            .is_some_and(|id| id != binding.workspace_id)
        {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "Todo Workspace is no longer current",
            ));
        }
        self.source_live_scope(&input.scope)?;
        self.source_prepare()?;
        let hash = query_hash(request, input)?;
        let seq = self.committed_change_watermark()?;
        let (after_todo, after_child) = match &input.cursor {
            Some(raw) => {
                let cursor = decode_cursor(raw)?;
                if cursor.query_hash != hash {
                    return Err(invalid(
                        "Todo cursor belongs to different filters or authorization",
                    ));
                }
                if cursor.seq != seq {
                    return Err(AgentError::new(
                        ErrorCode::SourceChanged,
                        "Todo list changed; restart without a cursor",
                    ));
                }
                (cursor.todo, cursor.child)
            }
            None => (0, 0),
        };
        let project_id = match input.scope {
            Scope::Workspace => None,
            Scope::Project { project_id } => Some(project_id),
        };
        let object_keys = request
            .scope_grant
            .object_keys
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot encode Todo object grant"))?;
        let limit = input.limit.unwrap_or(20);
        // Bounded display text keeps one giant Todo from preventing inventory.
        // Full bodies and children remain available from the returned todo.get target.
        let mut statement = self.conn.prepare(r#"
          WITH visible AS (
            SELECT t.*,h.revision FROM agent_visible_todos t
            LEFT JOIN todo_revision_heads h ON h.todo_id=t.id
            WHERE ((?1 IS NULL AND t.scope='workspace' AND t.project_id IS NULL)
                OR (t.scope='project' AND t.project_id=?1))
              AND (?2 IS NULL OR ?3||'/'||?4||'/todo/'||t.id IN (SELECT value FROM json_each(?2)))
              AND NOT EXISTS(SELECT 1 FROM source_access_policies p
                  WHERE p.object_key=?3||'/'||?4||'/todo/'||t.id AND p.excluded=1)
          ), actions(todo,child,content,truncated,parent,status,priority,due,revision) AS (
            SELECT id,0,substr(content,1,240),length(content)>240,NULL,status,priority,due_date,revision FROM visible
            UNION ALL
            SELECT t.id,c.id,substr(c.content,1,240),length(c.content)>240,substr(t.content,1,240),c.status,t.priority,c.due_date,t.revision
              FROM visible t JOIN todo_progresses c ON c.todo_id=t.id WHERE ?5
          )
          SELECT todo,child,content,truncated,parent,status,priority,due,revision FROM actions
           WHERE (todo>?6 OR (todo=?6 AND child>?7))
             AND (?8 IS NULL OR status=?8)
             AND (NOT ?9 OR due IS NULL)
             AND (?10 IS NULL OR due>=?10) AND (?11 IS NULL OR due<=?11)
           ORDER BY todo,child LIMIT ?12
        "#).map_err(io_error)?;
        let candidates = statement
            .query_map(
                params![
                    project_id,
                    object_keys,
                    binding.workspace_id,
                    input.scope.key(),
                    input.include_children,
                    after_todo,
                    after_child,
                    input.status,
                    input.undated,
                    input.due_from,
                    input.due_to,
                    (limit + 1) as i64
                ],
                |row| {
                    let todo: i64 = row.get(0)?;
                    let child: i64 = row.get(1)?;
                    Ok(TodoListItem {
                        object: ObjectRef {
                            workspace_id: binding.workspace_id.clone(),
                            scope: input.scope.clone(),
                            kind: ObjectKind::Todo,
                            id: todo.to_string(),
                        },
                        child_id: (child != 0).then_some(child),
                        revision: row.get::<_, i64>(8)? as u64,
                        content: row.get(2)?,
                        content_truncated: row.get(3)?,
                        parent_content: row.get(4)?,
                        status: row.get(5)?,
                        priority: row.get(6)?,
                        due_date: row.get(7)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let mut page = TodoListPage {
            scope: input.scope.clone(),
            items: vec![],
            next_cursor: None,
            has_more: false,
        };
        let count = candidates.len();
        for (index, item) in candidates.into_iter().take(limit).enumerate() {
            self.source_read_object(request, binding, &item.object)?;
            page.items.push(item);
            page.has_more = index + 1 < count;
            page.next_cursor = if page.has_more {
                Some(next_cursor(&page.items, &hash, seq)?)
            } else {
                None
            };
            let required = serialized_chars(&page)?;
            if required > input.budget_chars.unwrap_or(4000) {
                page.items.pop();
                if page.items.is_empty() {
                    return Err(AgentError::new(
                        ErrorCode::BudgetExceeded,
                        "Todo list budget cannot fit one action",
                    )
                    .with_details(json!({"minimumBudgetChars":required})));
                }
                page.has_more = true;
                page.next_cursor = Some(next_cursor(&page.items, &hash, seq)?);
                break;
            }
        }
        if serialized_chars(&page)? > input.budget_chars.unwrap_or(4000) {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Todo list budget cannot fit the response",
            ));
        }
        Ok(page)
    }
}
fn next_cursor(items: &[TodoListItem], hash: &str, seq: i64) -> AgentResult<String> {
    let item = items
        .last()
        .expect("a continuation follows a returned action");
    encode_cursor(&Cursor {
        query_hash: hash.into(),
        seq,
        todo: item.object.id.parse().expect("native Todo identity"),
        child: item.child_id.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::access::{Caller, ScopeGrant},
        models::{
            ProjectCreateInput, TodoAddProgressInput, TodoCreateInput, TodoScope,
            TodoUpdateStatusInput,
        },
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
        fn create(&mut self, project: bool, content: &str, due: Option<&str>) -> i64 {
            self.db
                .todo_create(TodoCreateInput {
                    scope: if project {
                        TodoScope::Project
                    } else {
                        TodoScope::Workspace
                    },
                    project_id: project.then_some(self.project),
                    content: content.into(),
                    priority: "urgent_important".into(),
                    due_date: due.map(str::to_owned),
                    tag_ids: vec![],
                })
                .unwrap()
                .id
        }
        fn child(&mut self, todo: i64, content: &str, due: Option<&str>) -> i64 {
            let revision = self.db.todo_record(todo).unwrap().revision;
            self.db
                .todo_add_progress(TodoAddProgressInput {
                    todo_id: todo,
                    content: content.into(),
                    progress_date: "2026-10-22".into(),
                    due_date: due.map(str::to_owned),
                    expected_revision: revision,
                })
                .unwrap()
                .id
        }
        fn input(&self) -> TodoListInput {
            serde_json::from_value(json!({"scope":{"kind":"project","projectId":self.project}}))
                .unwrap()
        }
        fn list(&self, input: &TodoListInput) -> AgentResult<TodoListPage> {
            self.db
                .agent_todo_list(&self.request, &self.request.binding, input)
        }
        fn object(&self, id: i64) -> ObjectRef {
            ObjectRef {
                workspace_id: "todo-list".into(),
                scope: Scope::Project {
                    project_id: self.project,
                },
                kind: ObjectKind::Todo,
                id: id.to_string(),
            }
        }
    }

    #[test]
    fn deadlines_status_and_children_are_independent_and_reads_do_not_write() {
        let mut f = Fixture::new();
        let parent = f.create(true, "Undated parent", None);
        let today = f.child(parent, "Child due today", Some("2026-10-22"));
        f.child(parent, "Undated child", None);
        let tomorrow = f.create(true, "Tomorrow", Some("2026-10-23"));
        f.create(false, "Workspace today", Some("2026-10-22"));
        f.db.todo_update_status(TodoUpdateStatusInput {
            todo_id: tomorrow,
            expected_revision: 1,
            status: "finished".into(),
        })
        .unwrap();
        let before = f.db.conn.total_changes();
        let mut input = f.input();
        input.status = Some("unfinished".into());
        input.due_from = Some("2026-10-22".into());
        input.due_to = input.due_from.clone();
        let result = f.list(&input).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].child_id, Some(today));
        assert_eq!(
            result.items[0].parent_content.as_deref(),
            Some("Undated parent")
        );
        assert_eq!(
            result.items[0].revision,
            f.db.todo_record(parent).unwrap().revision
        );
        input.include_children = false;
        assert!(f.list(&input).unwrap().items.is_empty());
        input.include_children = true;
        input.due_from = None;
        input.due_to = None;
        input.undated = true;
        assert_eq!(f.list(&input).unwrap().items.len(), 2);
        input.undated = false;
        input.status = Some("finished".into());
        assert_eq!(
            f.list(&input).unwrap().items[0].object.id,
            tomorrow.to_string()
        );
        input.scope = Scope::Workspace;
        input.status = None;
        assert_eq!(f.list(&input).unwrap().items.len(), 1);
        assert_eq!(
            f.db.conn.total_changes(),
            before,
            "list must not write business data, indexes or receipts"
        );
    }

    #[test]
    fn page_all_actions_without_indexing_and_bind_cursor_to_filters_grant_and_changes() {
        let mut f = Fixture::new();
        let a = f.create(true, "First", None);
        let child = f.child(a, "Child", None);
        let b = f.create(true, "Second", None);
        let mut input = f.input();
        input.limit = Some(1);
        let first = f.list(&input).unwrap();
        assert!(first.has_more);
        input.cursor = first.next_cursor.clone();
        let second = f.list(&input).unwrap();
        assert_eq!(second.items[0].child_id, Some(child));
        input.cursor = second.next_cursor;
        let third = f.list(&input).unwrap();
        assert_eq!(third.items[0].object.id, b.to_string());
        assert!(!third.has_more);
        assert!(third.next_cursor.is_none());
        input.cursor = first.next_cursor.clone();
        input.status = Some("unfinished".into());
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::InvalidArgument);
        input.status = None;
        f.request.scope_grant.object_keys = Some(vec![f.object(a).key().unwrap()]);
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::InvalidArgument);
        f.request.scope_grant.object_keys = None;
        f.db.todo_update_status(TodoUpdateStatusInput {
            todo_id: a,
            expected_revision: f.db.todo_record(a).unwrap().revision,
            status: "finished".into(),
        })
        .unwrap();
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::SourceChanged);
    }

    #[test]
    fn scope_policy_object_grant_withdrawal_archive_and_generation_are_enforced() {
        let mut f = Fixture::new();
        let visible = f.create(true, "Visible", None);
        let excluded = f.create(true, "Excluded", None);
        let withdrawn = f.create(true, "Withdrawn", None);
        f.child(excluded, "Secret child", None);
        f.db.source_policy_update(
            &f.request,
            &f.request.binding,
            &SourcePolicyUpdate {
                object: f.object(excluded),
                expected_revision: 0,
                excluded: true,
            },
        )
        .unwrap();
        f.db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'fixture','now',1)",[f.object(withdrawn).key().unwrap()]).unwrap();
        let input = f.input();
        let result = f.list(&input).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].object.id, visible.to_string());
        f.request.scope_grant.object_keys = Some(vec![]);
        assert!(f.list(&input).unwrap().items.is_empty());
        f.request.scope_grant.object_keys = None;
        f.request.scope_grant.project_ids.clear();
        assert_eq!(f.list(&input).unwrap_err().code, ErrorCode::ScopeDenied);
        f.request.scope_grant.project_ids.push(f.project);
        let mut stale = f.request.binding.clone();
        stale.generation = "other".into();
        assert_eq!(
            f.db.agent_todo_list(&f.request, &stale, &input)
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
    fn validates_filters_and_bounds_and_paginates_large_display_text() {
        let mut f = Fixture::new();
        let id = f.create(true, &"长".repeat(1000), None);
        f.create(true, &"Next".repeat(100), None);
        let input = f.input();
        let page = f.list(&input).unwrap();
        assert!(page.items[0].content_truncated);
        assert_eq!(page.items[0].content.chars().count(), 240);
        assert_eq!(page.items[0].object.id, id.to_string());
        for extra in [
            json!({"status":"done"}),
            json!({"dueFrom":"2026-02-30"}),
            json!({"dueFrom":"2026-11-01","dueTo":"2026-10-22"}),
            json!({"undated":true,"dueTo":"2026-10-22"}),
            json!({"limit":0}),
            json!({"limit":51}),
            json!({"budgetChars":12001}),
            json!({"cursor":"invalid"}),
        ] {
            let mut value = serde_json::to_value(&input).unwrap();
            for (k, v) in extra.as_object().unwrap() {
                value[k] = v.clone();
            }
            let invalid: TodoListInput = serde_json::from_value(value).unwrap();
            assert_eq!(
                f.list(&invalid).unwrap_err().code,
                ErrorCode::InvalidArgument
            );
        }
        let mut small = input.clone();
        small.budget_chars = Some(1);
        assert_eq!(f.list(&small).unwrap_err().code, ErrorCode::BudgetExceeded);
        // Find the exact first-page budget: this must return a usable cursor,
        // rather than an empty page which could make an Agent loop forever.
        let mut single = input.clone();
        single.limit = Some(1);
        let budget = serialized_chars(&f.list(&single).unwrap()).unwrap();
        assert!(serialized_chars(&page).unwrap() > budget);
        small.budget_chars = Some(budget);
        let one = f.list(&small).unwrap();
        assert_eq!(one.items.len(), 1);
        assert!(one.has_more);
        assert!(serialized_chars(&one).unwrap() <= budget);
        small.cursor = one.next_cursor;
        let two = f.list(&small).unwrap();
        assert!(two.items[0].content.starts_with("Next"));
        assert!(!two.has_more);
    }
}
