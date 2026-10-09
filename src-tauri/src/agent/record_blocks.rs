//! Bounded canonical Record nodes for revision-bound patch preparation.
//! This reader never converts or initializes legacy content and never truncates nodes.
use super::{
    access::RequestContext,
    context::serialized_chars,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use crate::{
    db::Database,
    record_documents::{record_block_hash, RecordTarget},
    source_service::BoundSourceStore,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordBlocksInput {
    pub record: ObjectRef,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub revision: Option<u64>,
    pub block_id: Option<String>,
    #[schemars(length(max = 2048))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 12000))]
    pub budget_chars: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordBlockIdentity {
    pub block_id: String,
    pub parent_block_id: Option<String>,
    #[serde(rename = "type")]
    pub node_type: String,
    pub block_hash: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordBlock {
    pub node: Value,
    /// Hashes include the complete node/subtree, using the patch CAS algorithm.
    pub tree: Vec<RecordBlockIdentity>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordBlocksPage {
    pub record: ObjectRef,
    pub head_revision: u64,
    pub body_hash: String,
    pub schema_version: u32,
    pub code_language: Option<String>,
    pub items: Vec<RecordBlock>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u8,
    key: String,
    revision: u64,
    hash: String,
    block_id: Option<String>,
    offset: usize,
    #[serde(default)]
    children: bool,
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn changed() -> AgentError {
    AgentError::new(
        ErrorCode::SourceChanged,
        "Record changed; read its current block revision again",
    )
}
fn block_id(node: &Value) -> Option<&str> {
    node.pointer("/attrs/blockId").and_then(Value::as_str)
}
fn stable_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn tree(
    node: &Value,
    parent: Option<&str>,
    result: &mut Vec<RecordBlockIdentity>,
) -> AgentResult<()> {
    let id = block_id(node);
    if let Some(id) = id {
        result.push(RecordBlockIdentity {
            block_id: id.into(),
            parent_block_id: parent.map(String::from),
            node_type: node
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            block_hash: record_block_hash(node)?,
        });
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            tree(child, id.or(parent), result)?;
        }
    }
    Ok(())
}
fn find<'a>(
    node: &'a Value,
    target: &str,
    parent: Option<&'a str>,
) -> Option<(&'a Value, Option<&'a str>)> {
    let id = block_id(node);
    if id == Some(target) {
        return Some((node, parent));
    }
    node.get("content")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|child| find(child, target, id.or(parent)))
}
fn cursor(
    key: &str,
    revision: u64,
    hash: &str,
    block_id: &Option<String>,
    offset: usize,
    children: bool,
) -> AgentResult<String> {
    serde_json::to_vec(&Cursor {
        version: 1,
        key: key.into(),
        revision,
        hash: hash.into(),
        block_id: block_id.clone(),
        offset,
        children,
    })
    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
    .map_err(|_| invalid("Cannot encode block cursor"))
}

pub(crate) struct RecordBlocksService<'a, S> {
    store: &'a S,
}
impl<'a, S: BoundSourceStore> RecordBlocksService<'a, S> {
    pub(crate) fn new(store: &'a S) -> Self {
        Self { store }
    }
    pub(crate) fn get(
        &self,
        request: &RequestContext,
        input: &RecordBlocksInput,
    ) -> AgentResult<RecordBlocksPage> {
        self.store
            .with_current(|binding, db| get_record_blocks(db, request, binding, input))
    }
}

pub(crate) fn get_record_blocks(
    db: &Database,
    request: &RequestContext,
    binding: &WorkspaceBinding,
    input: &RecordBlocksInput,
) -> AgentResult<RecordBlocksPage> {
    let budget = input.budget_chars.unwrap_or(4000);
    if !(1..=12000).contains(&budget)
        || input
            .revision
            .is_some_and(|revision| revision == 0 || revision > 9_007_199_254_740_991)
        || input.block_id.as_ref().is_some_and(|id| !stable_id(id))
        || input
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > 2048)
    {
        return Err(invalid("Invalid Record block selection or bounds"));
    }
    if input.record.kind != ObjectKind::Record {
        return Err(invalid("Block reads require a Record"));
    }
    // Checks current binding, resolved ownership, exclusion, archive status and
    // withdrawal before the reader returns any title, node or stable block ID.
    let record = db.source_read_object(request, binding, &input.record)?;
    let target = RecordTarget {
        scope: record.scope.clone(),
        record_id: record
            .id
            .parse()
            .map_err(|_| invalid("Invalid Record identity"))?,
    };
    let head=db.record_document_head(&target)?.ok_or_else(||AgentError::new(ErrorCode::SourceNotReady,"Record has no canonical committed document; initialize it through its explicit native entry"))?;
    if input
        .revision
        .is_some_and(|revision| revision != head.head_revision)
    {
        return Err(changed());
    }
    head.projection.validate()?;
    let key = record.key()?;
    let (offset, children) = if let Some(raw) = &input.cursor {
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| invalid("Invalid block cursor"))?;
        let selected: Cursor =
            serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid block cursor"))?;
        if selected.version != 1 || selected.key != key || selected.block_id != input.block_id {
            return Err(invalid("Block cursor belongs to another selection"));
        }
        if selected.revision != head.head_revision || selected.hash != head.projection.body_hash {
            return Err(changed());
        }
        (selected.offset, selected.children)
    } else {
        (0, false)
    };
    let selected: Vec<(&Value, Option<&str>)> = if let Some(id) = &input.block_id {
        let found = find(&head.projection.document, id, None).ok_or_else(|| {
            AgentError::new(ErrorCode::NotFound, "Block is not in this committed Record")
        })?;
        if children {
            found
                .0
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|node| block_id(node).is_some())
                .map(|node| (node, block_id(found.0)))
                .collect()
        } else {
            vec![found]
        }
    } else {
        if children {
            return Err(invalid("Child cursor requires its parent blockId"));
        }
        head.projection
            .document
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| AgentError::new(ErrorCode::IoFailed, "Record document is damaged"))?
            .iter()
            .map(|node| (node, None))
            .collect()
    };
    if offset > selected.len() || (input.cursor.is_some() && offset == selected.len()) {
        return Err(invalid("Block cursor is outside this selection"));
    }
    let mut page = RecordBlocksPage {
        record,
        head_revision: head.head_revision,
        body_hash: head.projection.body_hash.clone(),
        schema_version: head.projection.schema_version,
        code_language: head.projection.code_language.clone(),
        items: vec![],
        next_cursor: None,
    };
    for (index, (node, parent)) in selected.iter().enumerate().skip(offset).take(100) {
        let mut identities = vec![];
        tree(node, *parent, &mut identities)?;
        page.items.push(RecordBlock {
            node: (*node).clone(),
            tree: identities,
        });
        page.next_cursor = if index + 1 < selected.len() {
            Some(cursor(
                &key,
                head.head_revision,
                &page.body_hash,
                &input.block_id,
                index + 1,
                children,
            )?)
        } else {
            None
        };
        if serialized_chars(&page)? > budget {
            page.items.pop();
            if page.items.is_empty() {
                let child_ids: Vec<_> = node
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(block_id)
                    .take(10)
                    .collect();
                let children_cursor = if child_ids.is_empty() {
                    None
                } else {
                    Some(cursor(
                        &key,
                        head.head_revision,
                        &page.body_hash,
                        &block_id(node).map(String::from),
                        0,
                        true,
                    )?)
                };
                return Err(AgentError::new(ErrorCode::BudgetExceeded,"Complete block does not fit this read budget; select a child blockId, or use this parent blockId with childrenCursor for complete child pagination").with_details(json!({"headRevision":page.head_revision,"bodyHash":page.body_hash,"blockId":block_id(node),"blockHash":record_block_hash(node)?,"childBlockIds":child_ids,"childrenCursor":children_cursor,"hasMoreChildren":node.get("content").and_then(Value::as_array).is_some_and(|children|children.iter().filter_map(block_id).count()>10)})));
            }
            page.next_cursor = Some(cursor(
                &key,
                head.head_revision,
                &page.body_hash,
                &input.block_id,
                index,
                children,
            )?);
            break;
        }
    }
    if serialized_chars(&page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "Record block metadata does not fit this budget",
        ));
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            access::{Caller, ScopeGrant},
            outputs::{BlockEdit, RecordPatch},
        },
        models::WorkspaceRecordUpsertInput,
        record_documents::{body_hash, RecordCreate, RecordDocumentProjection},
    };
    struct Fixture {
        _root: tempfile::TempDir,
        db: Database,
        request: RequestContext,
        binding: WorkspaceBinding,
        input: RecordBlocksInput,
        target: RecordTarget,
    }
    impl Fixture {
        fn sql(&self) -> rusqlite::Connection {
            rusqlite::Connection::open(self._root.path().join("blocks.sqlite")).unwrap()
        }
    }
    fn fixture(document: Value) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("blocks.sqlite"), root.path(), None).unwrap();
        db.bind_native_workspace("blocks-workspace").unwrap();
        let projection = RecordDocumentProjection {
            schema_version: 1,
            body_hash: body_hash(&document, &None),
            document: document.clone(),
            html: "<p>Canonical fixture</p>".into(),
            markdown: "Canonical fixture".into(),
            text: "Canonical fixture".into(),
            code_language: None,
        };
        let head = db
            .record_create(
                "gui",
                "blocks-create",
                &RecordCreate {
                    scope: super::super::models::Scope::Workspace,
                    title: Some("Block fixture".into()),
                    tag_ids: vec![],
                    document,
                    code_language: None,
                },
                &projection,
                "blocks-workspace",
            )
            .unwrap();
        let binding = WorkspaceBinding {
            workspace_id: "blocks-workspace".into(),
            generation: "one".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "blocks-read".into(),
            scope_grant: ScopeGrant {
                workspace_id: binding.workspace_id.clone(),
                workspace_content: true,
                project_ids: vec![],
                operations: vec!["source.read".into()],
            },
        };
        let input = RecordBlocksInput {
            record: ObjectRef {
                workspace_id: binding.workspace_id.clone(),
                scope: head.target.scope.clone(),
                kind: ObjectKind::Record,
                id: head.target.record_id.to_string(),
            },
            revision: None,
            block_id: None,
            cursor: None,
            budget_chars: Some(1600),
        };
        Fixture {
            _root: root,
            db,
            request,
            binding,
            input,
            target: head.target,
        }
    }
    fn paragraph(number: usize, text: &str) -> Value {
        json!({"type":"paragraph","attrs":{"blockId":format!("{number:032x}")},"content":[{"type":"text","text":text}]})
    }
    #[test]
    fn record_blocks_pages_complete_nodes_and_reuses_native_patch_hashes() {
        let mut f = fixture(
            json!({"type":"doc","content":(1..=5).map(|number|paragraph(number,&"中".repeat(300))).collect::<Vec<_>>()}),
        );
        let mut ids = vec![];
        loop {
            let page = get_record_blocks(&f.db, &f.request, &f.binding, &f.input).unwrap();
            assert!(serialized_chars(&page).unwrap() <= 1600);
            for item in &page.items {
                assert_eq!(
                    item.node["content"][0]["text"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .count(),
                    300
                );
                let root = &item.tree[0];
                ids.push(root.block_id.clone());
                let patch = RecordPatch {
                    record: page.record.clone(),
                    base_revision: page.head_revision,
                    request_id: "hash-check".into(),
                    operations: vec![BlockEdit::AppendInline {
                        block_id: root.block_id.clone(),
                        expected_block_hash: root.block_hash.clone(),
                        text: "more".into(),
                    }],
                };
                crate::record_documents::validate_record_patch(
                    &patch,
                    &f.db.record_document_head(&f.target).unwrap().unwrap(),
                )
                .unwrap();
            }
            let Some(cursor) = page.next_cursor else {
                break;
            };
            f.input.cursor = Some(cursor);
            f.input.revision = Some(page.head_revision);
        }
        assert_eq!(
            ids,
            (1..=5)
                .map(|number| format!("{number:032x}"))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn record_blocks_cursor_binds_revision_and_selection() {
        let mut f = fixture(
            json!({"type":"doc","content":[paragraph(1,&"a".repeat(300)),paragraph(2,&"b".repeat(300)),paragraph(3,&"c".repeat(300))]}),
        );
        f.input.cursor = get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
            .unwrap()
            .next_cursor;
        assert!(f.input.cursor.is_some());
        f.input.block_id = Some(format!("{:032x}", 1));
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        f.input.block_id = None;
        f.sql()
            .execute(
                "UPDATE record_document_heads SET head_revision=head_revision+1",
                [],
            )
            .unwrap();
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
    #[test]
    fn record_blocks_oversized_container_names_real_children_without_truncating() {
        let mut f = fixture(
            json!({"type":"doc","content":[{"type":"blockquote","attrs":{"blockId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"content":(1..=18).map(|number|paragraph(number,&"中".repeat(300))).collect::<Vec<_>>()}]}),
        );
        let error = get_record_blocks(&f.db, &f.request, &f.binding, &f.input).unwrap_err();
        assert_eq!(error.code, ErrorCode::BudgetExceeded);
        assert_eq!(
            error.details.as_ref().unwrap()["childBlockIds"]
                .as_array()
                .unwrap()
                .len(),
            10
        );
        f.input.block_id = Some(format!("{:032x}", 1));
        let page = get_record_blocks(&f.db, &f.request, &f.binding, &f.input).unwrap();
        assert_eq!(
            page.items[0].tree[0].parent_block_id.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            page.items[0].node["content"][0]["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            300
        );
        f.input.block_id = Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        f.input.cursor = Some(
            error.details.as_ref().unwrap()["childrenCursor"]
                .as_str()
                .unwrap()
                .into(),
        );
        let mut ids = vec![];
        loop {
            let page = get_record_blocks(&f.db, &f.request, &f.binding, &f.input).unwrap();
            for item in page.items {
                assert_eq!(
                    item.tree[0].parent_block_id.as_deref(),
                    Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                );
                ids.push(item.tree[0].block_id.clone());
            }
            let Some(cursor) = page.next_cursor else {
                break;
            };
            f.input.cursor = Some(cursor);
        }
        assert_eq!(
            ids,
            (1..=18)
                .map(|number| format!("{number:032x}"))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn record_blocks_authorizes_policy_scope_withdrawal_and_keeps_legacy_uninitialized() {
        let mut f = fixture(json!({"type":"doc","content":[paragraph(1,"visible")]}));
        f.request.binding.generation = "old".into();
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::WorkspaceChanged
        );
        f.request.binding = f.binding.clone();
        f.input.record.scope = super::super::models::Scope::Project { project_id: 1 };
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.input.record.scope = super::super::models::Scope::Workspace;
        get_record_blocks(&f.db, &f.request, &f.binding, &f.input).unwrap();
        let key = f.input.record.key().unwrap();
        f.sql()
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES (?1,1,1)",
                [&key],
            )
            .unwrap();
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::ScopeDenied
        );
        f.sql()
            .execute("DELETE FROM source_access_policies", [])
            .unwrap();
        f.sql().execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES (?1,'fixture','now',1)",[&key]).unwrap();
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::ObjectWithdrawn
        );
        let legacy =
            f.db.workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("Legacy".into()),
                html: "<p>Legacy</p>".into(),
                markdown: "Legacy".into(),
                default_code_language: None,
                tag_ids: vec![],
            })
            .unwrap();
        f.input.record.id = legacy.id.to_string();
        assert_eq!(
            get_record_blocks(&f.db, &f.request, &f.binding, &f.input)
                .unwrap_err()
                .code,
            ErrorCode::SourceNotReady
        );
        assert!(f
            .db
            .record_document_head(&RecordTarget {
                scope: f.input.record.scope,
                record_id: legacy.id
            })
            .unwrap()
            .is_none());
    }
}
