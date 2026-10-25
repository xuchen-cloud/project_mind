//! Explicit File detail/search reads reuse the verified extraction service.
use super::{
    access::RequestContext,
    context::serialized_chars,
    errors::{AgentError, AgentResult, ErrorCode},
    listing::ListMode,
    record_list::RecordListInput,
};
use crate::source_service::{BoundSourceStore, SourceReadTarget, SourceService, SourceUtility};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    hash: String,
    seq: i64,
    id: String,
}
fn invalid() -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, "Invalid list query or cursor")
}
pub(crate) fn validate(input: &RecordListInput) -> AgentResult<()> {
    input.scope.validate()?;
    super::listing::validate_filters(
        &input.ids,
        input.title_query.as_deref(),
        input.content_query.as_deref(),
    )?;
    if input.limit.unwrap_or(20) > 50
        || !(1..=12000).contains(&input.budget_chars.unwrap_or(4000))
        || input.tag_ids.len() > 50
        || input.tag_ids.iter().any(|n| *n <= 0)
        || input
            .tag
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 240)
    {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn query_hash(
    request: &RequestContext,
    input: &RecordListInput,
    method: &str,
) -> String {
    format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"method":method,"binding":request.binding,"caller":request.caller.key(),
        "grant":{"workspace":request.scope_grant.workspace_id,"workspaceContent":request.scope_grant.workspace_content,"projects":request.scope_grant.project_ids,"operations":request.scope_grant.operations,"objects":request.scope_grant.object_keys},
        "scope":input.scope,"mode":input.mode,"ids":input.ids,"tag":input.tag,"tagIds":input.tag_ids,"titleQuery":input.title_query,"contentQuery":input.content_query})).expect("query serializes")))
}
pub(crate) async fn list<S: BoundSourceStore, W: SourceUtility>(
    store: &S,
    request: &RequestContext,
    input: &RecordListInput,
    utility: &W,
) -> AgentResult<Value> {
    validate(input)?;
    if input.ids.iter().any(|s| {
        s.parse::<i64>()
            .ok()
            .filter(|n| *n > 0 && n.to_string() == *s)
            .is_none()
    }) {
        return Err(invalid());
    }
    let hash = query_hash(request, input, "file.list");
    let (seq, items) =
        store.with_current(|binding, db| db.agent_file_inventory(request, binding, input))?;
    let after = if let Some(raw) = &input.cursor {
        if raw.len() > 2048 {
            return Err(invalid());
        }
        let c: Cursor =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if c.hash != hash || c.id.parse::<i64>().ok().filter(|n| *n > 0).is_none() {
            return Err(invalid());
        }
        if c.seq != seq {
            return Err(AgentError::new(
                ErrorCode::SourceChanged,
                "File inventory changed; restart without cursor",
            ));
        }
        c.id.parse::<i64>().map_err(|_| invalid())?
    } else {
        0
    };
    let limit = input.limit.unwrap_or(20);
    let budget = input.budget_chars.unwrap_or(4000);
    let mut total = 0usize;
    let mut unreadable = 0usize;
    let mut candidates = vec![];
    let mut more = false;
    let mut verified = vec![];
    for mut item in items {
        let id = item["object"]["id"]
            .as_str()
            .ok_or_else(invalid)?
            .parse::<i64>()
            .map_err(|_| invalid())?;
        let in_window = limit > 0 && id > after && candidates.len() < limit + 1;
        let mut matches = true;
        if input.content_query.is_some() || (in_window && input.mode == ListMode::Detail) {
            let source = SourceReadTarget {
                object: serde_json::from_value(item["object"].clone()).map_err(|_| invalid())?,
                revision: None,
                record_version: None,
                file_version: None,
            };
            match SourceService::new(store)
                .file_inventory_content(request, &source, utility)
                .await
            {
                Ok((content, plan, receipt)) => {
                    matches = input.content_query.as_ref().is_none_or(|q| {
                        content["text"]
                            .as_str()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&q.to_lowercase())
                    });
                    if input.content_query.is_some() && content["complete"] != true {
                        unreadable += 1;
                    }
                    verified.push((source, plan, receipt));
                    if in_window && input.mode == ListMode::Detail {
                        item["content"] = content["text"].clone();
                        item["contentComplete"] = content["complete"].clone();
                        item["contentState"] = content["state"].clone();
                        item["contentReason"] = content["reason"].clone();
                    }
                }
                Err(e)
                    if matches!(
                        e.code,
                        ErrorCode::SourceNotReady
                            | ErrorCode::FileChangedUnregistered
                            | ErrorCode::BudgetExceeded
                            | ErrorCode::IoFailed
                    ) =>
                {
                    unreadable += 1;
                    matches = input.content_query.is_none();
                    if in_window && input.mode == ListMode::Detail {
                        item["content"] = Value::Null;
                        item["contentComplete"] = json!(false);
                        item["contentState"] = json!("unavailable");
                        item["contentReason"] = json!(e.code);
                        item["contentError"] = json!(e);
                    }
                }
                Err(e) => return Err(e),
            }
        }
        if !matches {
            continue;
        }
        total += 1;
        if id > after && limit > 0 {
            if candidates.len() < limit + 1 {
                candidates.push(item);
            } else {
                more = true;
            }
        }
    }
    // Recheck authority, native metadata and byte receipts after async extraction.
    let (current, _) =
        store.with_current(|binding, db| db.agent_file_inventory(request, binding, input))?;
    if current != seq {
        return Err(AgentError::new(
            ErrorCode::SourceChanged,
            "File inventory changed; restart without cursor",
        ));
    }
    for (source, plan, receipt) in verified {
        SourceService::new(store)
            .verify_inventory_file(request, &source, &plan, &receipt)
            .await?;
    }
    let encode = |id: &str| {
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Cursor {
                hash: hash.clone(),
                seq,
                id: id.into(),
            })
            .expect("cursor serializes"),
        )
    };
    let count = candidates.len();
    let mut page = json!({"scope":input.scope,"items":[],"totalCount":total,"staleCount":0,"unreadableCount":unreadable,"countComplete":input.content_query.is_none() || unreadable==0,"hasMore":false,"nextCursor":null});
    for (index, item) in candidates.into_iter().take(limit).enumerate() {
        page["hasMore"] = json!(more || index + 1 < count);
        page["nextCursor"] = if page["hasMore"] == true {
            json!(encode(item["object"]["id"].as_str().expect("ID")))
        } else {
            Value::Null
        };
        page["items"].as_array_mut().expect("items").push(item);
        let required = serialized_chars(&page)?;
        if required > budget {
            let item = page["items"]
                .as_array_mut()
                .expect("items")
                .pop()
                .expect("last");
            let Some(last) = page["items"].as_array().expect("items").last() else {
                return Err(super::listing::budget_error(
                    item["title"].as_str().unwrap_or(""),
                    item["object"].clone(),
                    required,
                ));
            };
            page["nextCursor"] = json!(encode(last["object"]["id"].as_str().expect("ID")));
            page["hasMore"] = json!(true);
            break;
        }
    }
    if serialized_chars(&page)? > budget {
        return Err(AgentError::new(
            ErrorCode::BudgetExceeded,
            "List budget cannot fit the response",
        ));
    }
    Ok(page)
}
