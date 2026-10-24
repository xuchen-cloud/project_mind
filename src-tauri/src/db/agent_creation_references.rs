//! Incoming uses of native creations, resolved to the visible owning object.
use super::agent_operations::io_error;
use crate::agent::{
    errors::AgentResult,
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

fn object_key(
    binding: &WorkspaceBinding,
    scope: Scope,
    kind: ObjectKind,
    id: i64,
) -> AgentResult<String> {
    ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope,
        kind,
        id: id.to_string(),
    }
    .key()
}

fn source_visible(conn: &Connection, binding: &WorkspaceBinding, key: &str) -> AgentResult<bool> {
    let withdrawn: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_object_withdrawals WHERE object_key=?1 AND withdrawn_at IS NOT NULL)",
            [key],
            |row| row.get(0),
        )
        .map_err(io_error)?;
    if withdrawn {
        return Ok(false);
    }
    let Some(source) = super::committed_changes::object_from_key(key, &binding.workspace_id) else {
        // Published overview and knowledge owners also write shared edges.
        // They are outside ObjectRef's public kinds and have no withdrawal path.
        let parts: Vec<_> = key.split('/').collect();
        return Ok(
            matches!(parts.as_slice(), [workspace, _, "overview" | "knowledge", _]
            if *workspace == binding.workspace_id),
        );
    };
    let id = source.id.parse::<i64>().ok();
    let present = match (&source.scope, source.kind, id) {
        (Scope::Project { project_id }, ObjectKind::Record, Some(id)) => conn
            .query_row("SELECT 1 FROM agent_visible_notes WHERE id=?1 AND project_id=?2", params![id, project_id], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (Scope::Workspace, ObjectKind::Record, Some(id)) => conn
            .query_row("SELECT 1 FROM agent_visible_workspace_notes WHERE id=?1 AND note_kind='workspace_note'", [id], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (scope, ObjectKind::Todo, Some(id)) => conn
            .query_row("SELECT 1 FROM agent_visible_todos WHERE id=?1 AND scope=?2 AND (project_id=?3 OR (?3 IS NULL AND project_id IS NULL))",
                params![id, if matches!(scope, Scope::Workspace) { "workspace" } else { "project" }, match scope { Scope::Workspace => None, Scope::Project { project_id } => Some(*project_id) }], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (scope, ObjectKind::File, Some(id)) => conn
            .query_row("SELECT 1 FROM agent_visible_files WHERE id=?1 AND project_id IS ?2", params![id, super::file_scope::owner(scope)], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (Scope::Project { project_id }, ObjectKind::QuickNote, Some(id)) if *project_id == id => conn
            .query_row("SELECT 1 FROM projects WHERE id=?1", [id], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (Scope::Workspace, ObjectKind::QuickNote, Some(id)) => conn
            .query_row("SELECT 1 FROM workspace_notes WHERE id=?1 AND note_kind!='workspace_note'", [id], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (Scope::Project { project_id }, ObjectKind::Project, Some(id)) if *project_id == id => conn
            .query_row("SELECT 1 FROM projects WHERE id=?1", [id], |_| Ok(true))
            .optional().map_err(io_error)?.unwrap_or(false),
        (_, ObjectKind::Record | ObjectKind::Todo | ObjectKind::File | ObjectKind::QuickNote | ObjectKind::Project, _) => false,
        // Non-creation source kinds have no visibility withdrawal ledger.
        _ => true,
    };
    Ok(present)
}

/// Returns the visible owners of references to `target`, keyed exactly as the
/// creation batch keys its candidates. Edges remain stored across withdrawal.
pub(super) fn incoming_sources(
    conn: &Connection,
    binding: &WorkspaceBinding,
    target: &ObjectRef,
) -> AgentResult<HashSet<String>> {
    let target_key = target.key()?;
    let (token_kind, target_id) = match target.kind {
        ObjectKind::Record => (
            if matches!(target.scope, Scope::Workspace) {
                "workspace_record"
            } else {
                "note"
            },
            target.id.parse::<i64>().ok(),
        ),
        ObjectKind::Todo => ("todo", target.id.parse::<i64>().ok()),
        ObjectKind::File => ("document", target.id.parse::<i64>().ok()),
        _ => ("", None),
    };
    let mut sources = HashSet::new();
    let mut edges = conn.prepare("SELECT DISTINCT source_object_key FROM content_reference_edges WHERE target_object_key=?1 AND source_object_key!=?1").map_err(io_error)?;
    for row in edges
        .query_map([&target_key], |row| row.get::<_, String>(0))
        .map_err(io_error)?
    {
        let key = row.map_err(io_error)?;
        if source_visible(conn, binding, &key)? {
            sources.insert(key);
        }
    }
    let Some(target_id) = target_id else {
        return Ok(sources);
    };
    // Progress belongs to its parent Todo; project summaries and the Today
    // note have QuickNote owners rather than synthetic text-row identities.
    let mut legacy = conn.prepare("SELECT 'todo',t.id,t.scope,t.project_id,t.content FROM agent_visible_todos t \
        UNION ALL SELECT 'todo',t.id,t.scope,t.project_id,p.content FROM todo_progresses p JOIN agent_visible_todos t ON t.id=p.todo_id \
        UNION ALL SELECT 'project',p.id,'project',p.id,p.summary_markdown FROM projects p \
        UNION ALL SELECT 'record',n.id,'project',n.project_id,n.content_markdown FROM agent_visible_notes n \
        UNION ALL SELECT CASE WHEN n.note_kind='workspace_note' THEN 'record' ELSE 'quick_note' END,n.id,'workspace',NULL,n.content_markdown FROM agent_visible_workspace_notes n").map_err(io_error)?;
    let rows = legacy
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(io_error)?;
    for row in rows {
        let (kind, id, scope, project_id, content) = row.map_err(io_error)?;
        if !super::parse_internal_reference_tokens(&content)
            .iter()
            .any(|(kind, id)| kind == token_kind && *id == target_id)
        {
            continue;
        }
        let scope = if scope == "workspace" {
            Scope::Workspace
        } else {
            Scope::Project {
                project_id: project_id.expect("project content has a project owner"),
            }
        };
        let kind = match kind.as_str() {
            "todo" => ObjectKind::Todo,
            "record" => ObjectKind::Record,
            _ => ObjectKind::QuickNote,
        };
        let key = object_key(binding, scope, kind, id)?;
        if key != target_key && source_visible(conn, binding, &key)? {
            sources.insert(key);
        }
    }
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn record(binding: &WorkspaceBinding, id: i64) -> ObjectRef {
        ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Record,
            id: id.to_string(),
        }
    }

    #[test]
    fn structured_edges_respect_source_visibility_and_self_reference() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("refs.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("refs").unwrap();
        db.ensure_agent_output_schema().unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "refs".into(),
            generation: "one".into(),
        };
        for id in 1..=3 {
            db.conn.execute("INSERT INTO workspace_notes(id,note_kind,content_markdown,content_html,created_at,updated_at) VALUES (?1,'workspace_note','','<p></p>','now','now')", [id]).unwrap();
        }
        db.conn.execute("INSERT INTO todos(id,scope,content,status,priority,created_at,updated_at) VALUES (7,'workspace','','unfinished','normal','now','now')", []).unwrap();
        let target = record(&binding, 1);
        let same_kind = record(&binding, 2).key().unwrap();
        let withdrawn = record(&binding, 3).key().unwrap();
        let cross_kind = object_key(&binding, Scope::Workspace, ObjectKind::Todo, 7).unwrap();
        let target_key = target.key().unwrap();
        for source in [&same_kind, &withdrawn, &cross_kind, &target_key] {
            db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation) VALUES (?1,?2,'internal_reference')", params![source, target_key]).unwrap();
        }
        db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'creation','now',1)", [&withdrawn]).unwrap();
        assert_eq!(
            incoming_sources(&db.conn, &binding, &target).unwrap(),
            HashSet::from([same_kind, cross_kind])
        );
    }

    #[test]
    fn legacy_tokens_report_real_owners_and_ignore_hidden_todo_progress() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("refs.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("refs").unwrap();
        db.ensure_agent_output_schema().unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "refs".into(),
            generation: "one".into(),
        };
        db.conn.execute("INSERT INTO workspace_notes(id,note_kind,content_markdown,content_html,created_at,updated_at) VALUES (1,'workspace_note','[[workspace_record:1|self]]','<p></p>','now','now')", []).unwrap();
        db.conn.execute("INSERT INTO workspace_notes(id,note_kind,content_markdown,content_html,created_at,updated_at) VALUES (2,'workspace_note','[[workspace_record:1|same]]','<p></p>','now','now')", []).unwrap();
        db.conn.execute("INSERT INTO todos(id,scope,content,status,priority,created_at,updated_at) VALUES (7,'workspace','','unfinished','normal','now','now')", []).unwrap();
        db.conn.execute("INSERT INTO todo_progresses(id,todo_id,content,status,progress_date,created_at) VALUES (8,7,'[[workspace_record:1|progress]]','unfinished','now','now')", []).unwrap();
        let target = record(&binding, 1);
        let todo = object_key(&binding, Scope::Workspace, ObjectKind::Todo, 7).unwrap();
        let same_kind = record(&binding, 2).key().unwrap();
        assert_eq!(
            incoming_sources(&db.conn, &binding, &target).unwrap(),
            HashSet::from([todo.clone(), same_kind.clone()])
        );
        db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'creation','now',1)", [&todo]).unwrap();
        assert_eq!(
            incoming_sources(&db.conn, &binding, &target).unwrap(),
            HashSet::from([same_kind])
        );
    }

    #[test]
    fn project_and_workspace_quick_notes_block_todo_creation_withdrawal() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("refs.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("refs").unwrap();
        db.ensure_agent_output_schema().unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "refs".into(),
            generation: "one".into(),
        };
        db.conn.execute("INSERT INTO todos(id,scope,content,status,priority,created_at,updated_at) VALUES (1,'workspace','','unfinished','normal','now','now')", []).unwrap();
        db.conn.execute("INSERT INTO projects(id,name,root_path,summary_markdown,created_at,updated_at) VALUES (4,'Project','/tmp','[[todo:1|link]]','now','now')", []).unwrap();
        db.conn.execute("INSERT INTO workspace_notes(id,note_kind,content_markdown,content_html,created_at,updated_at) VALUES (5,'today_quick_note','[[todo:1|link]]','<p></p>','now','now')", []).unwrap();
        let target = ObjectRef {
            workspace_id: binding.workspace_id.clone(),
            scope: Scope::Workspace,
            kind: ObjectKind::Todo,
            id: "1".into(),
        };
        let project = object_key(
            &binding,
            Scope::Project { project_id: 4 },
            ObjectKind::QuickNote,
            4,
        )
        .unwrap();
        let quick_note = object_key(&binding, Scope::Workspace, ObjectKind::QuickNote, 5).unwrap();
        assert_eq!(
            incoming_sources(&db.conn, &binding, &target).unwrap(),
            HashSet::from([project, quick_note])
        );
    }
}
