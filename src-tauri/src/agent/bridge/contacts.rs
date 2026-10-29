//! Workspace address-book operations. Contact authority is independent of
//! Project content scopes and is granted explicitly by the trusted Host.
use super::{connection_store::ConnectionStore, registry};
use crate::{
    agent::{
        access::RequestContext,
        errors::{AgentError, AgentResult, ErrorCode},
        models::{Scope, WorkspaceBinding},
        tools::BoundReadContextStore,
    },
    committed_changes::{capture_committed, CommittedChangePublisher},
    db::{contacts::ContactFields, OperationChange},
    models::ContactRecord,
    record_document_service::DocumentUtility,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContactListInput {
    #[schemars(length(max = 1000))]
    pub query: Option<String>,
    #[schemars(range(min = 1, max = 200))]
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContactGetInput {
    #[schemars(range(min = 1, max = 9007199254740991_i64))]
    pub id: i64,
}
#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContactCreateInput {
    #[schemars(length(min = 1, max = 128))]
    pub request_id: String,
    pub fields: ContactFields,
}
#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContactUpdateInput {
    #[schemars(range(min = 1, max = 9007199254740991_i64))]
    pub id: i64,
    #[schemars(range(min = 1, max = 9007199254740991_u64))]
    pub base_revision: u64,
    #[schemars(length(min = 1, max = 128))]
    pub request_id: String,
    pub fields: ContactFields,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactReceipt {
    operation_id: String,
    request_id: String,
    method: String,
    undo_available: bool,
}
#[derive(Debug, Serialize, Deserialize)]
struct ContactMutation {
    contact: ContactRecord,
    operation: ContactReceipt,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContactPinyin {
    pinyin_full: String,
    pinyin_abbr: String,
    nickname_pinyin: String,
}
fn with_pinyin(fields: &ContactFields, derived: Option<&ContactPinyin>) -> ContactFields {
    let mut result = fields.clone();
    if let Some(derived) = derived {
        if fields.name.is_some() {
            result
                .pinyin_full
                .get_or_insert_with(|| derived.pinyin_full.clone());
            result
                .pinyin_abbr
                .get_or_insert_with(|| derived.pinyin_abbr.clone());
        }
        if fields.nicknames.is_some() {
            result.nickname_pinyin = Some(derived.nickname_pinyin.clone());
        }
    }
    result
}
fn invalid(message: &str) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> AgentResult<T> {
    serde_json::from_value(value).map_err(|_| invalid("Invalid contact command input"))
}
fn authorize(
    request: &RequestContext,
    binding: &WorkspaceBinding,
    operation: &str,
) -> AgentResult<()> {
    if &request.binding != binding {
        return Err(AgentError::new(
            ErrorCode::WorkspaceChanged,
            "Workspace changed; reconnect",
        ));
    }
    if request.scope_grant.workspace_id != binding.workspace_id
        || !request
            .scope_grant
            .operations
            .iter()
            .any(|value| value == operation)
        || request.scope_grant.object_keys.is_some()
    {
        return Err(AgentError::new(ErrorCode::ScopeDenied,
            "This connection has no access to the Workspace address book; enable its contact permission"));
    }
    Ok(())
}
fn mutation_result(
    contact: ContactRecord,
    request: &RequestContext,
    method: &str,
    changed: bool,
) -> (ContactMutation, Option<OperationChange>) {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let change = changed.then(|| OperationChange {
        object_key: format!(
            "{}/workspace/contact/{}",
            request.binding.workspace_id, contact.id
        ),
        scope: Scope::Workspace,
        revision: contact.revision.to_string(),
    });
    (
        ContactMutation {
            contact,
            operation: ContactReceipt {
                operation_id: bytes.iter().map(|value| format!("{value:02x}")).collect(),
                request_id: request.request_id.clone(),
                method: method.into(),
                undo_available: false,
            },
        },
        change,
    )
}
pub(crate) async fn execute<
    S: BoundReadContextStore + CommittedChangePublisher,
    W: DocumentUtility,
>(
    connection: &ConnectionStore<'_, S>,
    worker: &W,
    method: &str,
    params: Value,
) -> AgentResult<Value> {
    registry::validate(method, &params)?;
    // Derive search text only when a supplied name/alias changes. The existing
    // GUI and this utility share pinyin-pro; nothing is transliterated on reads.
    // Keep original input as the receipt identity, independently of derived data.
    let pinyin = if matches!(method, "contact.create" | "contact.update")
        && (params["fields"].get("name").is_some() || params["fields"].get("nicknames").is_some())
    {
        let (request_id, previous) = connection.with_authenticated(|binding, db, _, request| {
            authorize(&request, binding, "contact.write")?;
            let previous: Option<ContactMutation> = if method == "contact.create" {
                let input: ContactCreateInput = decode(params.clone())?;
                if input.request_id != request.request_id {
                    return Err(invalid("Contact requestId differs from request identity"));
                }
                db.agent_operation_replay(&request.caller.key(), &input.request_id, method, &input)?
            } else {
                let input: ContactUpdateInput = decode(params.clone())?;
                if input.request_id != request.request_id {
                    return Err(invalid("Contact requestId differs from request identity"));
                }
                db.agent_operation_replay(&request.caller.key(), &input.request_id, method, &input)?
            };
            Ok((request.request_id, previous))
        })?;
        if let Some(previous) = previous {
            return Ok(json!(previous));
        }
        let value = worker
            .request(
                &request_id,
                "contact.pinyin",
                json!({
                    "name":params["fields"]["name"].as_str().unwrap_or(""),
                    "nicknames":params["fields"]["nicknames"].as_str().unwrap_or(""),
                }),
            )
            .await?;
        let result: ContactPinyin = serde_json::from_value(value).map_err(|_| {
            AgentError::new(ErrorCode::IoFailed, "Invalid contact pinyin conversion")
        })?;
        Some(result)
    } else {
        None
    };
    let (result, changes) = connection.with_authenticated(|binding, db, _, request| {
        let write = matches!(method, "contact.create" | "contact.update");
        authorize(
            &request,
            binding,
            if write {
                "contact.write"
            } else {
                "contact.read"
            },
        )?;
        let action = || match method {
            "contact.list" | "contact.search" => {
                let input: ContactListInput = decode(params)?;
                let query = input.query.as_deref().unwrap_or("");
                let limit = input.limit.unwrap_or(50);
                if query.chars().count() > 1000 || !(1..=200).contains(&limit) {
                    return Err(invalid(
                        "Contact query must be at most 1000 characters and limit between 1 and 200",
                    ));
                }
                Ok(json!(db.contact_cli_list(
                    query,
                    limit,
                    input.offset.unwrap_or(0)
                )?))
            }
            "contact.get" => {
                let input: ContactGetInput = decode(params)?;
                Ok(json!(db.contact_cli_get(input.id)?))
            }
            "contact.create" => {
                let input: ContactCreateInput = decode(params)?;
                if input.request_id != request.request_id {
                    return Err(invalid("Contact requestId differs from request identity"));
                }
                let result = db.agent_atomic_operation(
                    &request.caller.key(),
                    &input.request_id,
                    method,
                    &input,
                    |tx| {
                        let fields = with_pinyin(&input.fields, pinyin.as_ref());
                        let contact = crate::db::contacts::create(tx, &fields)?;
                        Ok(mutation_result(contact, &request, method, true))
                    },
                )?;
                Ok(json!(result))
            }
            "contact.update" => {
                let input: ContactUpdateInput = decode(params)?;
                if input.request_id != request.request_id {
                    return Err(invalid("Contact requestId differs from request identity"));
                }
                let result = db.agent_atomic_operation(
                    &request.caller.key(),
                    &input.request_id,
                    method,
                    &input,
                    |tx| {
                        let fields = with_pinyin(&input.fields, pinyin.as_ref());
                        let contact = crate::db::contacts::update(
                            tx,
                            input.id,
                            input.base_revision,
                            &fields,
                        )?;
                        let changed = contact.revision != input.base_revision;
                        Ok(mutation_result(contact, &request, method, changed))
                    },
                )?;
                Ok(json!(result))
            }
            _ => Err(invalid("Unknown contact command")),
        };
        if write {
            capture_committed(binding, db, &request.request_id, action)
        } else {
            Ok((action(), None))
        }
    })?;
    if let Some(changes) = changes {
        connection.publish_committed(changes);
    }
    result
}
