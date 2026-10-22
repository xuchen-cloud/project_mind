//! Explicit historical content changes over existing immutable publications.
use super::{
    memory_facts::{MemoryAccess, MemoryScope},
    Database,
};
use crate::agent::models::{ObjectRef, Scope};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

type R<T> = Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    project: i64,
    query: String,
    overview: i64,
    memory: i64,
    after: (String, String, i64, String),
}
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn point(v: &Value, origin: &str) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    json!({"text":if origin=="overview" {&v["text"]} else {&v["content"]},
        "condition":v.get("condition").unwrap_or(&Value::Null),
        "validFrom":v.get("validFrom").unwrap_or(&Value::Null),
        "validTo":v.get("validTo").unwrap_or(&Value::Null),
        "supersededBy":v.get("supersededBy").unwrap_or(&Value::Null),
        "confirmation":if origin=="overview" {&v["epistemicStatus"]} else {&v["confirmation"]},
        "state":if origin=="overview" {&v["validState"]} else {&v["state"]}})
}
fn same_text(a: &Value, b: &Value) -> bool {
    normalize(a["text"].as_str().unwrap_or("")) == normalize(b["text"].as_str().unwrap_or(""))
        && a["condition"].is_null() == b["condition"].is_null()
        && normalize(a["condition"].as_str().unwrap_or(""))
            == normalize(b["condition"].as_str().unwrap_or(""))
        && a["validFrom"] == b["validFrom"]
        && a["validTo"] == b["validTo"]
        && a["supersededBy"] == b["supersededBy"]
        && a["confirmation"] == b["confirmation"]
}
// A bounded SQL page of individual item/version candidates. Multi-item Overview
// publications have an independent stable item key, including removals.
const CANDIDATES: &str = r#"
WITH snapshots AS (
 SELECT v.revision,v.created_at,v.snapshot_json,p.snapshot_json previous
 FROM agent_overview_versions v LEFT JOIN agent_overview_versions p
 ON p.scope_key=v.scope_key AND p.revision=v.revision-1
 WHERE v.scope_key=?1 AND v.revision<=?2
), candidates AS (
 SELECT s.created_at time,'overview' origin,s.revision seq,j.value after,p.value before,
 json_extract(j.value,'$.id') id,s.revision revision
 FROM snapshots s JOIN json_each(s.snapshot_json,'$.items') j
 LEFT JOIN json_each(s.previous,'$.items') p ON json_extract(p.value,'$.id')=json_extract(j.value,'$.id')
 UNION ALL
 SELECT s.created_at,'overview',s.revision,NULL,p.value,json_extract(p.value,'$.id'),s.revision
 FROM snapshots s JOIN json_each(s.previous,'$.items') p
 WHERE NOT EXISTS(SELECT 1 FROM json_each(s.snapshot_json,'$.items') j
 WHERE json_extract(j.value,'$.id')=json_extract(p.value,'$.id'))
 UNION ALL
 SELECT o.created_at,'memory',v.rowid,v.body,p.body,v.fact_id,v.revision
 FROM memory_fact_versions v JOIN memory_fact_heads h ON h.id=v.fact_id
 JOIN memory_fact_versions head ON head.fact_id=h.id AND head.revision=h.revision
 JOIN memory_fact_operations o ON o.id=v.operation_id
 LEFT JOIN memory_fact_versions p ON p.fact_id=v.fact_id AND p.revision=v.revision-1
 WHERE h.scope=?1 AND v.rowid<=?3
 AND json_extract(v.body,'$.category') IN ('agreement','decision')
 AND json_extract(head.body,'$.state') NOT IN ('forgotten','disabled')
)
SELECT time,origin,seq,id,revision,before,after FROM candidates
WHERE (time,origin,seq,id)>(?4,?5,?6,?7)
ORDER BY time,origin,seq,id LIMIT 129
"#;
impl Database {
    /// Read-only, opt-in history. Access fixes the only Project that can be read.
    pub fn memory_project_history(
        &self,
        access: &MemoryAccess,
        query: &str,
        cursor: Option<&str>,
        limit: usize,
        budget_chars: usize,
    ) -> R<Value> {
        let MemoryScope::Project { project_id } = access.scope else {
            return Err("Project history requires Project access".into());
        };
        if !(1..=100).contains(&limit) || budget_chars > 100_000 || query.chars().count() > 2000 {
            return Err("Invalid Project history limits".into());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                [project_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if project_id <= 0 || !exists {
            return Err("Project does not exist".into());
        }
        let scope_key = format!("project:{project_id}");
        let query = normalize(query).to_lowercase();
        let mut state = if let Some(cursor) = cursor {
            if cursor.len() > 12000 {
                return Err("Invalid Project history cursor".into());
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| "Invalid Project history cursor")?;
            let value: Cursor =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid Project history cursor")?;
            if value.project != project_id
                || value.query != query
                || value.overview < 0
                || value.memory < 0
            {
                return Err("Project history cursor scope/query mismatch".into());
            }
            value
        } else {
            Cursor{project:project_id,query:query.clone(),overview:tx.query_row("SELECT COALESCE(MAX(revision),0) FROM agent_overview_versions WHERE scope_key=?1",[&scope_key],|r|r.get(0)).map_err(|e|e.to_string())?,
                memory:tx.query_row("SELECT COALESCE(MAX(v.rowid),0) FROM memory_fact_versions v JOIN memory_fact_heads h ON h.id=v.fact_id WHERE h.scope=?1",[&scope_key],|r|r.get(0)).map_err(|e|e.to_string())?,after:(String::new(),String::new(),0,String::new())}
        };
        let mut stmt = tx.prepare(CANDIDATES).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![
                scope_key,
                state.overview,
                state.memory,
                state.after.0,
                state.after.1,
                state.after.2,
                state.after.3
            ])
            .map_err(|e| e.to_string())?;
        let mut events = Vec::new();
        let mut used = 0;
        let mut more = false;
        let mut required = None;
        for scanned in 0..129 {
            let Some(row) = rows.next().map_err(|e| e.to_string())? else {
                break;
            };
            if scanned == 128 || events.len() == limit {
                more = true;
                break;
            }
            let time: String = row.get(0).map_err(|e| e.to_string())?;
            let origin: String = row.get(1).map_err(|e| e.to_string())?;
            let seq: i64 = row.get(2).map_err(|e| e.to_string())?;
            let id: String = row.get(3).map_err(|e| e.to_string())?;
            let revision: i64 = row.get(4).map_err(|e| e.to_string())?;
            let parse = |col| -> R<Value> {
                let text: Option<String> = row.get(col).map_err(|e| e.to_string())?;
                text.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
                    .transpose()
                    .map(|v| v.unwrap_or(Value::Null))
            };
            let before = parse(5)?;
            let after = parse(6)?;
            let position = (time.clone(), origin.clone(), seq, id.clone());
            // Old Workspace / foreign Project publications are never a source
            // of Project history text, even when inherited into an old snapshot.
            let safe = self.history_item_scope(&before, &origin, project_id)?
                && self.history_item_scope(&after, &origin, project_id)?;
            let b = point(&before, &origin);
            let a = point(&after, &origin);
            let kind = if before.is_null() {
                "added"
            } else if after.is_null() {
                "removed"
            } else if !same_text(&b, &a) {
                "changed"
            } else if b["state"] != a["state"] {
                "state"
            } else {
                state.after = position;
                continue;
            };
            let matches = query.is_empty()
                || [&b, &a].iter().any(|p| {
                    ["text", "condition"].iter().any(|k| {
                        normalize(p[k].as_str().unwrap_or(""))
                            .to_lowercase()
                            .contains(&query)
                    })
                });
            if !safe || !matches {
                state.after = position;
                continue;
            }
            let sources = self.history_pointers(
                if after.is_null() { &before } else { &after },
                &origin,
                project_id,
            )?;
            let event = json!({"time":time,"origin":origin,"id":id,"revision":revision,"kind":kind,"before":b,"after":a,"sources":sources});
            let cost = serde_json::to_string(&event)
                .map_err(|e| e.to_string())?
                .chars()
                .count();
            if used + cost > budget_chars {
                more = true;
                required = Some(cost);
                break;
            }
            events.push(event);
            used += cost;
            state.after = position;
        }
        let next = if more {
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&state).map_err(|e| e.to_string())?))
        } else {
            None
        };
        Ok(
            json!({"historical":true,"scope":access.scope,"events":events,"nextCursor":next,"requiredBudgetChars":required,"changeClassification":"raw_content"}),
        )
    }
    fn history_item_scope(&self, item: &Value, origin: &str, project: i64) -> R<bool> {
        if item.is_null() {
            return Ok(true);
        }
        if origin == "memory" {
            return Ok(item["scope"] == json!({"kind":"project","projectId":project}));
        }
        if let Some(parents) = item["publishedSources"].as_array() {
            if parents
                .iter()
                .any(|p| p["projectId"].as_i64() != Some(project))
            {
                return Ok(false);
            }
        }
        if let Some(sources) = item["sourceRefs"].as_array() {
            for source in sources {
                if !self.history_source_scope(source, project)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    fn history_source_scope(&self, source: &Value, project: i64) -> R<bool> {
        let object: ObjectRef = serde_json::from_value(source["object"].clone())
            .map_err(|_| "Invalid historical source pointer")?;
        let scope = Scope::Project {
            project_id: project,
        };
        if object.scope != scope {
            return Ok(false);
        }
        let resolved = self
            .agent_resolve_object(&object, &object.workspace_id)
            .map_err(|e| e.message)?;
        Ok(resolved.is_none_or(|owner| owner.scope == scope))
    }
    fn history_pointers(&self, item: &Value, origin: &str, project: i64) -> R<Vec<Value>> {
        let mut out = Vec::new();
        let sources = if origin == "overview" {
            item["sourceRefs"].as_array()
        } else {
            item["sources"].as_array()
        };
        if let Some(sources) = sources {
            for source in sources {
                let native = if origin == "overview" {
                    Some(source)
                } else {
                    source.get("reference").filter(|v| !v.is_null())
                };
                if let Some(native) = native {
                    if !self.history_source_scope(native, project)? {
                        continue;
                    }
                    let mut pointer = serde_json::Map::new();
                    for key in [
                        "object",
                        "revision",
                        "fileVersion",
                        "recordVersion",
                        "blockId",
                        "locator",
                    ] {
                        if let Some(v) = native.get(key) {
                            pointer.insert(key.into(), v.clone());
                        }
                    }
                    out.push(Value::Object(pointer));
                } else if source["scope"] == json!({"kind":"project","projectId":project}) {
                    out.push(json!({"kind":source["kind"],"id":source["id"],"sessionId":source["sessionId"],"messageId":source["messageId"]}));
                }
            }
        }
        Ok(out)
    }
}
#[cfg(test)]
#[path = "project_history_tests.rs"]
mod tests;
