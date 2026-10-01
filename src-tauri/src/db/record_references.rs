//! Record references are resolved from storage and written with the body CAS.
//! The shared edge table uses canonical ObjectRef keys, never unscoped numeric IDs.
use super::agent_operations::io_error;
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope},
    },
    record_documents::{invalid, positive_object_id, RecordTarget},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

struct Reference {
    kind: &'static str,
    id: i64,
    block_id: Option<String>,
}
fn references(document: &Value) -> AgentResult<Vec<Reference>> {
    fn visit(
        node: &Value,
        block: Option<&str>,
        output: &mut Vec<Reference>,
        depth: usize,
        count: &mut usize,
    ) -> AgentResult<()> {
        *count += 1;
        if depth > 64 || *count > 50_000 {
            return Err(invalid("Record reference tree exceeds limits"));
        }
        let block = node
            .pointer("/attrs/blockId")
            .and_then(Value::as_str)
            .or(block);
        let (kind, attribute) = match node.get("type").and_then(Value::as_str) {
            Some("internalReference") => (
                match node
                    .pointer("/attrs/refKind")
                    .and_then(Value::as_str)
                    .unwrap_or("note")
                {
                    "note" => "note",
                    "workspace_record" => "workspace_record",
                    "todo" => "todo",
                    "document" => "document",
                    _ => return Err(invalid("Invalid internal reference kind")),
                },
                "refId",
            ),
            Some("tagMention") => ("tag", "tagId"),
            Some("contactMention") => ("contact", "contactId"),
            Some("image" | "attachment")
                if node
                    .pointer("/attrs/documentId")
                    .is_some_and(|id| !id.is_null()) =>
            {
                ("document", "documentId")
            }
            _ => ("", ""),
        };
        if !kind.is_empty() {
            let id = node
                .get("attrs")
                .and_then(|attrs| attrs.get(attribute))
                .and_then(positive_object_id)
                .ok_or_else(|| invalid("Invalid Record reference identity"))?
                as i64;
            output.push(Reference {
                kind,
                id,
                block_id: block.map(str::to_string),
            });
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                visit(child, block, output, depth + 1, count)?;
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(document, None, &mut output, 0, &mut 0)?;
    Ok(output)
}
pub(super) fn reference_identities(document: &Value) -> AgentResult<HashSet<(&'static str, i64)>> {
    Ok(references(document)?
        .into_iter()
        .map(|reference| (reference.kind, reference.id))
        .collect())
}
fn denied() -> AgentError {
    AgentError::new(
        ErrorCode::ScopeDenied,
        "Record contains an unavailable or out-of-scope reference",
    )
}
#[derive(Clone)]
struct Resolved {
    scope: Option<Scope>,
    kind: Option<ObjectKind>,
}
fn resolve(conn: &Connection, kind: &str, id: i64) -> AgentResult<Option<Resolved>> {
    let (sql, object_kind) = match kind {
        // Historical note:<id> tokens always denote Project Records. They must
        // never be guessed as Workspace Records with a colliding numeric ID.
        "note" => (
            "SELECT project_id FROM notes WHERE id=?1",
            Some(ObjectKind::Record),
        ),
        "workspace_record" => (
            "SELECT NULL FROM workspace_notes WHERE id=?1 AND note_kind='workspace_note'",
            Some(ObjectKind::Record),
        ),
        "todo" => (
            "SELECT project_id FROM todos WHERE id=?1",
            Some(ObjectKind::Todo),
        ),
        "document" => (
            "SELECT project_id FROM documents WHERE id=?1",
            Some(ObjectKind::File),
        ),
        "tag" => ("SELECT project_id FROM file_tag_options WHERE id=?1", None),
        "contact" => ("SELECT NULL FROM contacts WHERE id=?1", None),
        _ => return Err(invalid("Unsupported Record reference")),
    };
    Ok(conn
        .query_row(sql, [id], |row| row.get::<_, Option<i64>>(0))
        .optional()
        .map_err(io_error)?
        .map(|project| Resolved {
            scope: if kind == "contact" {
                None
            } else {
                Some(project.map_or(Scope::Workspace, |project_id| Scope::Project { project_id }))
            },
            kind: object_kind,
        }))
}
impl super::Database {
    pub(crate) fn record_reference_scopes(&self, document: &Value) -> AgentResult<Vec<Scope>> {
        let identities = reference_identities(document)?;
        let mut scopes = Vec::new();
        for (kind, id) in identities {
            if let Some(scope) = resolve(&self.conn, kind, id)?.and_then(|target| target.scope) {
                if !scopes.contains(&scope) {
                    scopes.push(scope);
                }
            }
        }
        scopes.sort_by_key(Scope::key);
        Ok(scopes)
    }
}
/// Preserve an already committed missing source without allowing newly invented IDs.
/// Restores explicitly include the selected immutable version's identities.
pub(super) fn validate_references(
    conn: &Connection,
    scope: &Scope,
    document: &Value,
    retained: &HashSet<(&'static str, i64)>,
    workspace_id: &str,
) -> AgentResult<Vec<(String, String)>> {
    let mut resolved = HashMap::new();
    let mut edges = Vec::new();
    for reference in references(document)? {
        let identity = (reference.kind, reference.id);
        if !resolved.contains_key(&identity) {
            resolved.insert(identity, resolve(conn, reference.kind, reference.id)?);
        }
        let Some(target) = resolved.get(&identity).and_then(Option::as_ref) else {
            if retained.contains(&identity) {
                continue;
            }
            return Err(denied());
        };
        if let Some(target_scope) = &target.scope {
            if (matches!(scope, Scope::Project { .. }) && target_scope != scope)
                || (reference.kind == "tag" && target_scope != scope)
            {
                return Err(denied());
            }
            if let Scope::Project { project_id } = target_scope {
                let archived: bool = conn
                    .query_row(
                        "SELECT is_archived FROM projects WHERE id=?1",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(io_error)?;
                if archived && !retained.contains(&identity) {
                    return Err(denied());
                }
            }
            if let Some(kind) = target.kind {
                let object = ObjectRef {
                    workspace_id: workspace_id.into(),
                    scope: target_scope.clone(),
                    kind,
                    id: reference.id.to_string(),
                };
                let locator = json!({"blockId": reference.block_id}).to_string();
                edges.push((object.key()?, locator));
            }
        }
    }
    Ok(edges)
}
pub(super) fn write_reference_edges(
    conn: &Connection,
    target: &RecordTarget,
    document: &Value,
    workspace_id: &str,
) -> AgentResult<()> {
    let retained = reference_identities(document)?;
    let edges = validate_references(conn, &target.scope, document, &retained, workspace_id)?;
    let source = ObjectRef {
        workspace_id: workspace_id.into(),
        scope: target.scope.clone(),
        kind: ObjectKind::Record,
        id: target.record_id.to_string(),
    }
    .key()?;
    conn.execute("DELETE FROM content_reference_edges WHERE source_object_key=?1 AND relation='internal_reference'", [&source]).map_err(io_error)?;
    for (object, locator) in edges {
        conn.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES (?1,?2,'internal_reference',?3,NULL)", params![source,object,locator]).map_err(io_error)?;
    }
    Ok(())
}
