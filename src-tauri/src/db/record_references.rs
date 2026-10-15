//! Record references are resolved from storage and written with the body CAS.
//! The shared edge table uses canonical ObjectRef keys, never unscoped numeric IDs.
use super::agent_operations::io_error;
use crate::{
    agent::{
        errors::{AgentError, AgentResult, ErrorCode},
        models::{ObjectKind, ObjectRef, Scope, SourceRef},
    },
    record_documents::{invalid, positive_object_id, validate_file_source_ref, RecordTarget},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

struct Reference {
    kind: &'static str,
    id: i64,
    block_id: Option<String>,
    source_ref: Option<SourceRef>,
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
            let source_ref = node
                .pointer("/attrs/sourceRef")
                .filter(|value| !value.is_null())
                .map(validate_file_source_ref)
                .transpose()?;
            if source_ref
                .as_ref()
                .is_some_and(|source| kind != "document" || source.object.id != id.to_string())
            {
                return Err(invalid("Fixed File reference identity differs"));
            }
            output.push(Reference {
                kind,
                id,
                block_id: block.map(str::to_string),
                source_ref,
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
type ReferenceIdentity = (&'static str, i64, Option<String>);
fn identity(reference: &Reference) -> ReferenceIdentity {
    (
        reference.kind,
        reference.id,
        reference
            .source_ref
            .as_ref()
            .map(|source| serde_json::to_string(source).expect("SourceRef serializes")),
    )
}
pub(super) fn reference_identities(document: &Value) -> AgentResult<HashSet<ReferenceIdentity>> {
    Ok(references(document)?
        .into_iter()
        .map(|reference| identity(&reference))
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
            "SELECT project_id FROM agent_visible_todos WHERE id=?1",
            Some(ObjectKind::Todo),
        ),
        "document" => (
            "SELECT project_id FROM agent_visible_files WHERE id=?1",
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
pub(super) fn resolve_reference_object(
    conn: &Connection,
    kind: &str,
    id: i64,
    workspace_id: &str,
) -> AgentResult<Option<ObjectRef>> {
    Ok(resolve(conn, kind, id)?.and_then(|resolved| {
        Some(ObjectRef {
            workspace_id: workspace_id.into(),
            scope: resolved.scope?,
            kind: resolved.kind?,
            id: id.to_string(),
        })
    }))
}
impl super::Database {
    /// Resolve the concrete source objects using the same parser and native
    /// identity lookup as the reference edge writer. Missing references remain
    /// the responsibility of validate_references, which knows retained history.
    pub(crate) fn record_reference_objects(
        &self,
        document: &Value,
        workspace_id: &str,
    ) -> AgentResult<Vec<ObjectRef>> {
        let mut objects = Vec::new();
        for reference in references(document)? {
            let object = if let Some(source) = reference.source_ref {
                Some(source.object)
            } else {
                resolve_reference_object(&self.conn, reference.kind, reference.id, workspace_id)?
            };
            if let Some(object) = object {
                if !objects.contains(&object) {
                    objects.push(object);
                }
            }
        }
        objects.sort_by(|a, b| {
            a.scope
                .key()
                .cmp(&b.scope.key())
                .then_with(|| format!("{:?}", a.kind).cmp(&format!("{:?}", b.kind)))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(objects)
    }
    pub(crate) fn record_reference_scopes(&self, document: &Value) -> AgentResult<Vec<Scope>> {
        let mut scopes = Vec::new();
        for reference in references(document)? {
            let scope = if let Some(source) = reference.source_ref {
                Some(source.object.scope)
            } else {
                resolve(&self.conn, reference.kind, reference.id)?.and_then(|target| target.scope)
            };
            if let Some(scope) = scope {
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
    retained: &HashSet<ReferenceIdentity>,
    workspace_id: &str,
) -> AgentResult<Vec<(String, String, Option<String>)>> {
    let mut resolved = HashMap::new();
    let mut edges = Vec::new();
    for reference in references(document)? {
        let identity = identity(&reference);
        let lookup = (reference.kind, reference.id);
        if let Some(source) = &reference.source_ref {
            if source.object.workspace_id != workspace_id
                || (matches!(scope, Scope::Project { .. }) && &source.object.scope != scope)
            {
                return Err(denied());
            }
        }
        if !resolved.contains_key(&lookup) {
            resolved.insert(lookup, resolve(conn, reference.kind, reference.id)?);
        }
        let Some(target) = resolved.get(&lookup).and_then(Option::as_ref) else {
            if retained.contains(&identity) {
                if let Some(source) = &reference.source_ref {
                    edges.push((
                        source.object.key()?,
                        json!({"blockId": reference.block_id, "sourceRef": source}).to_string(),
                        Some(source.revision.clone()),
                    ));
                }
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
                let (locator, revision) = if let Some(source) = &reference.source_ref {
                    if source.object != object {
                        return Err(denied());
                    }
                    let hash: Option<Option<String>> = conn.query_row(
                        "SELECT h.content_hash FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=?1 AND v.version_number=?2",
                        params![reference.id,source.file_version], |row| row.get(0)).optional().map_err(io_error)?;
                    match hash {
                        Some(Some(hash)) if hash == source.revision => {}
                        None | Some(None) if retained.contains(&identity) => {}
                        _ => return Err(denied()),
                    }
                    (
                        json!({"blockId": reference.block_id, "sourceRef": source}).to_string(),
                        Some(source.revision.clone()),
                    )
                } else {
                    (json!({"blockId": reference.block_id}).to_string(), None)
                };
                edges.push((object.key()?, locator, revision));
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
    for (object, locator, revision) in edges {
        conn.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES (?1,?2,'internal_reference',?3,?4)", params![source,object,locator,revision]).map_err(io_error)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "record_references_tests.rs"]
mod tests;
