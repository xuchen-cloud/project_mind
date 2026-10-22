//! Native source evidence and immutable adoption history for accepted DSH requests.
use super::memory_facts::{MemoryScope, MemorySource};
use super::Database;
use crate::agent::{
    access::{Caller, RequestContext, ScopeGrant},
    models::{Scope, SourceRef, WorkspaceBinding},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn native_scope(scope: &MemoryScope) -> Scope {
    match scope {
        MemoryScope::Workspace => Scope::Workspace,
        MemoryScope::Project { project_id } => Scope::Project {
            project_id: *project_id,
        },
    }
}

fn source_request(binding: &WorkspaceBinding, scope: &MemoryScope) -> RequestContext {
    RequestContext {
        binding: binding.clone(),
        request_id: "memory-source".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: matches!(scope, MemoryScope::Workspace),
            project_ids: match scope {
                MemoryScope::Workspace => vec![],
                MemoryScope::Project { project_id } => vec![*project_id],
            },
            operations: vec!["source.read".into()],
            object_keys: None,
        },
    }
}

impl Database {
    pub(crate) fn memory_verified_sources(
        &self,
        binding: &WorkspaceBinding,
        scope: &MemoryScope,
        session_id: &str,
        sources: &[SourceRef],
    ) -> Result<Vec<MemorySource>, String> {
        if sources.len() > 32 {
            return Err("单次记忆来源过多".into());
        }
        let request = source_request(binding, scope);
        let mut verified = Vec::new();
        for source in sources {
            if source.object.workspace_id != binding.workspace_id
                || source.object.scope != native_scope(scope)
            {
                return Err("记忆原文来源不属于当前范围".into());
            }
            self.source_read_object(&request, binding, &source.object)
                .map_err(|e| e.message)?;
            let key = source.object.key().map_err(|e| e.message)?;
            // DSH source deliveries persist the actual fixed reference after a
            // provider accepts it. Arguments cannot invent a read or cite a
            // source delivered only to a different Session.
            let mut stmt = self.conn.prepare("SELECT json_extract(locator_json,'$.sourceRef') FROM content_reference_edges WHERE relation='evidence' AND target_object_key=?1 AND target_revision=?2 AND json_extract(locator_json,'$.sessionId')=?3")
                .map_err(|e|e.to_string())?;
            let candidates = stmt
                .query_map(params![key, source.revision, session_id], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            let expected = serde_json::to_value(source).map_err(|e| e.to_string())?;
            let reference = candidates
                .into_iter()
                .map(|s| serde_json::from_str::<Value>(&s))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|actual| {
                    actual["object"] == expected["object"]
                        && actual["fileVersion"] == expected["fileVersion"]
                        && actual["recordVersion"] == expected["recordVersion"]
                        && actual["locator"] == expected["locator"]
                })
                .ok_or("记忆来源尚未由当前会话实际读取")?;
            let kind = reference["object"]["kind"].as_str().ok_or("无效来源类型")?;
            if !matches!(kind, "file" | "record") {
                return Err("此来源不能作为记忆原文引用".into());
            }
            verified.push(serde_json::from_value(json!({"kind":kind,"id":source.object.id,
                "scope":scope,"label":reference["title"],"excerpt":reference["excerpt"],"reference":reference}))
                .map_err(|_|"无效记忆原文引用")?);
        }
        Ok(verified)
    }

    pub(crate) fn memory_source_availability(
        &self,
        binding: &WorkspaceBinding,
        source: &MemorySource,
    ) -> Result<&'static str, String> {
        let value = serde_json::to_value(source).map_err(|e| e.to_string())?;
        let Some(reference) = value.get("reference") else {
            return Ok("unverified");
        };
        let reference: SourceRef =
            serde_json::from_value(reference.clone()).map_err(|_| "无效记忆来源")?;
        let request = source_request(binding, &source.scope);
        match self.source_read_object(&request, binding, &reference.object) {
            Ok(_) => Ok("available"),
            Err(error) => match error.code {
                crate::agent::errors::ErrorCode::NotFound
                | crate::agent::errors::ErrorCode::ObjectWithdrawn => Ok("source_removed"),
                crate::agent::errors::ErrorCode::ScopeDenied => Ok("access_denied"),
                _ => Err(error.message),
            },
        }
    }

    fn ensure_memory_adoption_table(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS memory_request_adoption_history (
            scope_key TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL, adopted_at TEXT NOT NULL,
            PRIMARY KEY(scope_key,session_id,request_id))",
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub(crate) fn memory_adoption_record(
        &self,
        scope: &MemoryScope,
        session_id: &str,
        request_id: &str,
        snapshot: &Value,
    ) -> Result<(), String> {
        self.ensure_memory_adoption_table()?;
        let mut snapshot = snapshot.clone();
        if let Some(facts) = snapshot.get_mut("facts").and_then(Value::as_array_mut) {
            for fact in facts {
                let id = fact["id"].as_str().ok_or("缺少采用的记忆身份")?;
                let revision = fact["revision"]
                    .as_u64()
                    .and_then(|value| i64::try_from(value).ok())
                    .ok_or("无效采用的记忆版本")?;
                let body: String = self
                    .conn
                    .query_row(
                        "SELECT body FROM memory_fact_versions WHERE fact_id=?1 AND revision=?2",
                        params![id, revision],
                        |row| row.get(0),
                    )
                    .map_err(|_| "采用的记忆版本不存在")?;
                let body: Value = serde_json::from_str(&body).map_err(|_| "无效记忆版本")?;
                let owner: MemoryScope =
                    serde_json::from_value(body["scope"].clone()).map_err(|_| "无效记忆归属")?;
                if owner != *scope && owner != MemoryScope::Workspace {
                    return Err("采用的记忆不属于当前范围".into());
                }
                fact["content"] = body["content"].clone();
                fact["scope"] = body["scope"].clone();
                fact["condition"] = body["condition"].clone();
            }
        }
        self.conn.execute("INSERT INTO memory_request_adoption_history(scope_key,session_id,request_id,snapshot_json,adopted_at) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(scope_key,session_id,request_id) DO NOTHING",
            params![native_scope(scope).key(),session_id,request_id,serde_json::to_string(&snapshot).map_err(|e|e.to_string())?,chrono::Utc::now().to_rfc3339()])
            .map_err(|e|e.to_string())?;
        Ok(())
    }
    pub(crate) fn memory_adoption_get(
        &self,
        scope: &MemoryScope,
        session_id: &str,
    ) -> Result<Option<Value>, String> {
        self.ensure_memory_adoption_table()?;
        let value:Option<(String,String,String)>=self.conn.query_row("SELECT request_id,snapshot_json,adopted_at FROM memory_request_adoption_history WHERE scope_key=?1 AND session_id=?2 ORDER BY rowid DESC LIMIT 1",
            params![native_scope(scope).key(),session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
        value.map(|(request_id,snapshot,adopted_at)|Ok(json!({"requestId":request_id,"adoptedAt":adopted_at,"snapshot":serde_json::from_str::<Value>(&snapshot).map_err(|e|e.to_string())?}))).transpose()
    }
    pub(crate) fn memory_adoptions_for_turn(
        &self,
        scope: &MemoryScope,
        session_id: &str,
        turn: u32,
    ) -> Result<Vec<Value>, String> {
        self.ensure_memory_adoption_table()?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT request_id,snapshot_json,adopted_at FROM memory_request_adoption_history
            WHERE scope_key=?1 AND session_id=?2 AND json_extract(snapshot_json,'$.turn')=?3
            ORDER BY json_extract(snapshot_json,'$.step'),rowid",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![native_scope(scope).key(), session_id, turn], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| { let (request_id,snapshot,adopted_at)=row.map_err(|e|e.to_string())?;
            Ok(json!({"requestId":request_id,"adoptedAt":adopted_at,"snapshot":serde_json::from_str::<Value>(&snapshot).map_err(|e|e.to_string())?})) }).collect()
    }
}

#[cfg(test)]
#[path = "memory_delivery_tests.rs"]
mod tests;
