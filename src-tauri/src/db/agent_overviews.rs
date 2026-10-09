//! Versioned Overview storage; formal schema29 owns initial preparation.
use super::{
    agent_operations::{io_error, OperationChange},
    Database,
};
use crate::agent::{
    context::{AiOverview, OverviewItem, PublishedOverviewRef},
    errors::{AgentError, AgentResult, ErrorCode},
    models::Scope,
    overview::*,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

/// Stable proof material for one item and everything it depends on. A
/// revision identifies the captured snapshot; it is deliberately absent from
/// the digest so unrelated Project updates do not invalidate Workspace text.
fn published_material(
    snapshot: &AiOverview,
    item_id: &str,
    corrections: &[OverviewCorrection],
) -> AgentResult<(String, Vec<crate::agent::models::SourceRef>)> {
    let mut todo = vec![item_id.to_owned()];
    let mut seen = std::collections::BTreeSet::new();
    let mut material = Vec::new();
    let mut sources = std::collections::BTreeMap::new();
    while let Some(id) = todo.pop() {
        if !seen.insert(id.clone()) { continue; }
        let item = snapshot.items.iter().find(|item| item.id == id)
            .ok_or_else(|| AgentError::new(ErrorCode::SourceChanged,"Published Overview dependency is missing"))?;
        if !item.published_sources.is_empty() {
            return Err(invalid("Project item contains published parents"));
        }
        todo.extend(item.dependency_item_ids.iter().cloned());
        for source in &item.source_refs {
            sources.entry(published_source_key(source)?).or_insert_with(||source.clone());
        }
        material.push((id, item));
    }
    material.sort_by(|a,b| a.0.cmp(&b.0));
    let relevant: Vec<_> = corrections.iter().filter(|c| !c.deleted &&
        (c.item_id.is_none() || seen.contains(c.item_id.as_ref().unwrap()))).collect();
    // updatedAt and version numbers are metadata, not semantic support.
    let payload: Vec<_> = material.iter().map(|(_, item)| {
        let source_keys:std::collections::BTreeSet<_>=item.source_refs.iter()
            .map(published_source_key).collect::<AgentResult<_>>()?;
        let dependencies:std::collections::BTreeSet<_>=item.dependency_item_ids.iter().collect();
        Ok(serde_json::json!({
        "id": item.id, "section": item.section, "text": item.text,
        "epistemicStatus": item.epistemic_status, "validState": item.valid_state,
        "sourceRefs":source_keys,"dependencies":dependencies
    })) }).collect::<AgentResult<_>>()?;
    let encoded = serde_json::to_vec(&(payload,relevant.iter().map(|c| (&c.id,&c.item_id,&c.text)).collect::<Vec<_>>()))
        .map_err(|_| invalid("Cannot encode published item"))?;
    Ok((format!("{:x}", Sha256::digest(encoded)), sources.into_values().collect()))
}
fn published_source_key(source:&crate::agent::models::SourceRef)->AgentResult<String> {
    encode(&serde_json::json!({"object":source.object,"revision":source.revision,
        "fileVersion":source.file_version,"recordVersion":source.record_version,
        "blockId":source.block_id,"locator":source.locator}))
}
fn published_text(snapshot:&AiOverview,item_id:&str,_corrections:&[OverviewCorrection])->AgentResult<String> {
    let mut todo=vec![item_id.to_owned()];let mut seen=std::collections::BTreeSet::new();
    let mut items=vec![];
    while let Some(id)=todo.pop() {
        if !seen.insert(id.clone()) {continue;}
        let item=snapshot.items.iter().find(|item|item.id==id).ok_or_else(||AgentError::new(ErrorCode::SourceChanged,"Published dependency disappeared"))?;
        todo.extend(item.dependency_item_ids.iter().cloned());
        items.push(serde_json::json!({"id":item.id,"section":item.section,"text":item.text,
            "epistemicStatus":item.epistemic_status,"validState":item.valid_state,
            "dependencies":item.dependency_item_ids}));
    }
    items.sort_by(|a,b|a["id"].as_str().cmp(&b["id"].as_str()));
    encode(&serde_json::json!({"items":items}))
}

fn published_relevant_corrections(snapshot:&AiOverview,item_id:&str,corrections:&[OverviewCorrection])->AgentResult<Vec<OverviewCorrection>> {
    let mut todo=vec![item_id.to_owned()];let mut seen=std::collections::BTreeSet::new();
    while let Some(id)=todo.pop() {
        if !seen.insert(id.clone()) {continue;}
        let item=snapshot.items.iter().find(|item|item.id==id)
            .ok_or_else(||AgentError::new(ErrorCode::SourceChanged,"Published dependency disappeared"))?;
        todo.extend(item.dependency_item_ids.iter().cloned());
    }
    Ok(corrections.iter().filter(|c|!c.deleted &&
        (c.item_id.is_none() || c.item_id.as_ref().is_some_and(|id|seen.contains(id)))).cloned().collect())
}

fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid Overview payload"))
}
fn decode<T: DeserializeOwned>(text: &str) -> AgentResult<T> {
    serde_json::from_str(text)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored Overview"))
}
fn queue_published_change(tx:&rusqlite::Connection,workspace_id:&str,project_id:i64,item_id:&str,removed:bool)->AgentResult<()> {
    let key=format!("published:{project_id}:{item_id}");
    let now=Utc::now().to_rfc3339();
    tx.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,'workspace','overview.item.changed',?2,?3)",
        params![key,if removed {"deleted"} else {"changed"},now]).map_err(io_error)?;
    let seq=tx.last_insert_rowid();
    tx.execute("INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) VALUES('workspace',0) ON CONFLICT(scope_key) DO NOTHING",[]).map_err(io_error)?;
    tx.execute("INSERT INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded)
        VALUES('workspace',?1,?2,?2,'overview.item.changed',?3,?4,0)
        ON CONFLICT(scope_key,object_key) DO UPDATE SET last_seq=excluded.last_seq,operation=excluded.operation,
        latest_revision=excluded.latest_revision,deleted=excluded.deleted",params![key,seq,if removed {"deleted"} else {"changed"},removed]).map_err(io_error)?;
    let owner=format!("{workspace_id}/project:{project_id}/overview/{item_id}");
    tx.execute("INSERT INTO source_dependency_invalidations(owner_key,changed_object_key,seq,reason)
        WITH RECURSIVE affected(owner_key) AS (
            SELECT e.source_object_key FROM content_reference_edges e WHERE e.relation='derived_from' AND e.target_object_key=?1
            UNION SELECT e.source_object_key FROM content_reference_edges e JOIN affected a ON e.target_object_key=a.owner_key WHERE e.relation='derived_from'
        ) SELECT owner_key,?1,?2,'source_changed' FROM affected WHERE 1
        ON CONFLICT(owner_key) DO UPDATE SET changed_object_key=excluded.changed_object_key,seq=excluded.seq,reason=excluded.reason",
        params![owner,seq]).map_err(io_error)?;
    Ok(())
}
impl Database {
    pub(crate) fn agent_published_item_text(&self,snapshot:&AiOverview,item_id:&str,corrections:&[OverviewCorrection])->AgentResult<String> {
        published_text(snapshot,item_id,corrections)
    }
    pub(crate) fn agent_published_item_corrections(&self,snapshot:&AiOverview,item_id:&str,corrections:&[OverviewCorrection])->AgentResult<Vec<OverviewCorrection>> {
        published_relevant_corrections(snapshot,item_id,corrections)
    }
    pub(crate) fn agent_published_item_capture(&self, project_id: i64, item_id: &str)
        -> AgentResult<(PublishedOverviewRef, Vec<crate::agent::models::SourceRef>, String)> {
        validate_id(item_id)?;
        let scope = Scope::Project { project_id };
        let snapshot = self.agent_overview_head(&scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::SourceNotReady,"Project Overview is not published"))?;
        let corrections = self.agent_overview_corrections(&scope)?;
        let (digest, sources) = published_material(&snapshot,item_id,&corrections.items)?;
        Ok((PublishedOverviewRef { project_id, revision:snapshot.revision,
            item_id:item_id.into(), digest },sources,published_text(&snapshot,item_id,&corrections.items)?))
    }
    pub(crate) fn agent_published_item_verify(&self, reference: &PublishedOverviewRef)
        -> AgentResult<Vec<crate::agent::models::SourceRef>> {
        validate_published_ref(reference)?;
        let scope=Scope::Project { project_id:reference.project_id };
        let captured=self.agent_overview_version(&scope,reference.revision)?
            .ok_or_else(|| AgentError::new(ErrorCode::SourceChanged,"Published item version disappeared"))?;
        let current=self.agent_overview_head(&scope)?
            .ok_or_else(|| AgentError::new(ErrorCode::SourceChanged,"Published Project Overview disappeared"))?;
        let corrections=self.agent_overview_corrections(&scope)?;
        let (captured_digest,sources)=published_material(&captured,&reference.item_id,&corrections.items)?;
        let (current_digest,_)=published_material(&current,&reference.item_id,&corrections.items)?;
        if captured_digest!=reference.digest || current_digest!=reference.digest {
            return Err(AgentError::new(ErrorCode::SourceChanged,"Published item changed"));
        }
        Ok(sources)
    }
    pub(crate) fn agent_published_item_pending(&self,project_id:i64,item_id:&str)->AgentResult<PublishedOverviewRef> {
        match self.agent_published_item_capture(project_id,item_id) {
            Ok((reference,_,_))=>return Ok(reference),
            Err(error) if matches!(error.code,ErrorCode::SourceNotReady|ErrorCode::SourceChanged|ErrorCode::NotFound|ErrorCode::ScopeDenied)=>(),
            Err(error)=>return Err(error),
        }
        let scope=Scope::Project{project_id};
        let historical:Option<String>=self.conn.query_row("SELECT v.snapshot_json FROM agent_overview_versions v JOIN json_each(v.snapshot_json,'$.items') item
            WHERE v.scope_key=?1 AND json_extract(item.value,'$.id')=?2 ORDER BY v.revision DESC LIMIT 1",
            params![scope.key(),item_id],|row|row.get(0)).optional().map_err(io_error)?;
        let mut corrections_stmt=self.conn.prepare("SELECT correction_json FROM agent_overview_corrections WHERE scope_key=?1 ORDER BY id").map_err(io_error)?;
        let corrections=corrections_stmt.query_map([scope.key()],|r|r.get::<_,String>(0)).map_err(io_error)?
            .map(|row|decode::<OverviewCorrection>(&row.map_err(io_error)?)).collect::<AgentResult<Vec<_>>>()?;
        if let Some(version)=historical {
            let snapshot:AiOverview=decode(&version)?;
            if snapshot.items.iter().any(|item|item.id==item_id) {
                let (digest,_)=published_material(&snapshot,item_id,&corrections)?;
                return Ok(PublishedOverviewRef {project_id,revision:snapshot.revision,item_id:item_id.into(),digest});
            }
        }
        Err(AgentError::new(ErrorCode::SourceChanged,"Published item no longer exists"))
    }
    pub(crate) fn agent_overviews_prepare(&self) -> anyhow::Result<()> {
        self.source_prepare()
            .map_err(|error| anyhow::anyhow!("{}", error.message))?;
        self.conn
            .execute_batch("SAVEPOINT agent_overviews_prepare")?;
        let result = (|| -> anyhow::Result<()> {
            let columns = {
                let mut statement = self
                    .conn
                    .prepare("PRAGMA table_info(agent_overview_versions)")?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                names
            };
            if !columns.is_empty() && !columns.iter().any(|column| column == "batch_id") {
                self.conn.execute_batch(
                    "ALTER TABLE agent_overview_versions RENAME TO agent_overview_versions_legacy",
                )?;
                self.conn
                    .execute_batch(include_str!("agent_overview_versions.sql"))?;
                // Preserve historical payload/snapshot bytes and revision-based
                // evidence ownership. ':' is reserved by the input ID validator,
                // so new supplied batch IDs cannot claim migrated identities.
                self.conn.execute_batch("INSERT INTO agent_overview_versions
                    (scope_key,revision,batch_id,snapshot_json,payload_json,target_seq,policy_revision,correction_revision,created_at)
                    SELECT scope_key,revision,'legacy:'||revision,snapshot_json,payload_json,target_seq,policy_revision,correction_revision,created_at
                    FROM agent_overview_versions_legacy;
                    DROP TABLE agent_overview_versions_legacy;")?;
            } else {
                self.conn
                    .execute_batch(include_str!("agent_overview_versions.sql"))?;
            }
            self.conn
                .execute_batch(include_str!("agent_overviews.sql"))?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn.execute_batch("RELEASE agent_overviews_prepare")?;
                Ok(())
            }
            Err(error) => {
                self.conn.execute_batch(
                    "ROLLBACK TO agent_overviews_prepare; RELEASE agent_overviews_prepare",
                )?;
                Err(error.into())
            }
        }
    }
    fn overview_scope(&self, scope: &Scope) -> AgentResult<()> {
        scope.validate()?;
        self.source_live_scope(scope)?;
        self.agent_overviews_prepare()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare Overview storage"))?;
        self.conn.execute("INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) VALUES(?1,1) ON CONFLICT(scope_key) DO NOTHING",[scope.key()]).map_err(io_error)?;
        Ok(())
    }
    pub(crate) fn agent_overview_pending_status(
        &self,
        scope: &Scope,
    ) -> AgentResult<OverviewPendingStatus> {
        self.overview_scope(scope)?;
        self.overview_pending_status_read(scope)
    }
    fn overview_pending_status_read(&self, scope: &Scope) -> AgentResult<OverviewPendingStatus> {
        self.conn.query_row("SELECT (SELECT count(*) FROM agent_overview_pending WHERE scope_key=?1), needs_rebuild FROM agent_overview_pending_state WHERE scope_key=?1",[scope.key()],|r|Ok(OverviewPendingStatus{pending_count:r.get::<_,i64>(0)? as u64,needs_rebuild:r.get(1)?})).map_err(io_error)
    }
    pub(crate) fn agent_overview_pending_page(
        &self,
        scope: &Scope,
        target_seq: u64,
        after_key: Option<&str>,
        limit: u16,
    ) -> AgentResult<OverviewPendingPage> {
        self.overview_scope(scope)?;
        if !(1..=200).contains(&limit) || target_seq > i64::MAX as u64 {
            return Err(invalid("Invalid Overview pending page"));
        }
        if let Some(key) = after_key {
            validate_pending_key(key, scope)?;
        }
        // One read snapshot keeps items, count and captured watermark consistent.
        let tx = self.conn.unchecked_transaction().map_err(io_error)?;
        if target_seq > self.committed_change_watermark()? as u64 {
            return Err(invalid("Invalid Overview pending watermark"));
        }
        let mut stmt=tx.prepare("SELECT object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded FROM agent_overview_pending WHERE scope_key=?1 AND last_seq<=?2 AND object_key>?3 ORDER BY object_key LIMIT ?4").map_err(io_error)?;
        let mut items = stmt
            .query_map(
                params![
                    scope.key(),
                    target_seq as i64,
                    after_key.unwrap_or(""),
                    limit as i64 + 1
                ],
                |r| {
                    Ok(OverviewPendingItem {
                        object_key: r.get(0)?,
                        first_seq: r.get::<_, i64>(1)? as u64,
                        last_seq: r.get::<_, i64>(2)? as u64,
                        operation: r.get(3)?,
                        latest_revision: r.get(4)?,
                        deleted: r.get(5)?,
                        excluded: r.get(6)?,
                    })
                },
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if has_more {
            items.last().map(|i| i.object_key.clone())
        } else {
            None
        };
        let status = self.overview_pending_status_read(scope)?;
        drop(stmt);
        tx.commit().map_err(io_error)?;
        Ok(OverviewPendingPage {
            scope: scope.clone(),
            target_seq,
            items,
            pending_count: status.pending_count,
            needs_rebuild: status.needs_rebuild,
            next_cursor,
        })
    }
    pub(crate) fn agent_overview_head(&self, scope: &Scope) -> AgentResult<Option<AiOverview>> {
        self.overview_scope(scope)?;
        let text:Option<String>=self.conn.query_row("SELECT v.snapshot_json FROM agent_overviews h JOIN agent_overview_versions v ON v.scope_key=h.scope_key AND v.revision=h.current_revision WHERE h.scope_key=?1",[scope.key()],|r|r.get(0)).optional().map_err(io_error)?;
        text.map(|s| decode(&s)).transpose()
    }
    pub(crate) fn agent_overview_version(
        &self,
        scope: &Scope,
        revision: u64,
    ) -> AgentResult<Option<AiOverview>> {
        self.overview_scope(scope)?;
        if revision == 0 || revision > i64::MAX as u64 {
            return Err(invalid("Invalid Overview revision"));
        }
        let text:Option<String>=self.conn.query_row("SELECT snapshot_json FROM agent_overview_versions WHERE scope_key=?1 AND revision=?2",params![scope.key(),revision as i64],|r|r.get(0)).optional().map_err(io_error)?;
        text.map(|s| decode(&s)).transpose()
    }
    pub(crate) fn agent_overview_version_baselines(
        &self,
        scope: &Scope,
        revision: u64,
    ) -> AgentResult<(u64, u64)> {
        self.overview_scope(scope)?;
        if revision == 0 || revision > i64::MAX as u64 {
            return Err(invalid("Invalid Overview revision"));
        }
        self.conn.query_row("SELECT policy_revision,correction_revision FROM agent_overview_versions WHERE scope_key=?1 AND revision=?2",params![scope.key(),revision as i64],|r|Ok((r.get::<_,i64>(0)? as u64,r.get::<_,i64>(1)? as u64))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Overview version not found"))
    }
    pub(crate) fn agent_overview_versions(
        &self,
        scope: &Scope,
        after_revision: u64,
        limit: u16,
    ) -> AgentResult<Vec<u64>> {
        self.overview_scope(scope)?;
        if !(1..=100).contains(&limit) || after_revision > i64::MAX as u64 {
            return Err(invalid("Invalid Overview version page"));
        }
        let mut stmt=self.conn.prepare("SELECT revision FROM agent_overview_versions WHERE scope_key=?1 AND revision>?2 ORDER BY revision LIMIT ?3").map_err(io_error)?;
        let result = stmt
            .query_map(params![scope.key(), after_revision as i64, limit], |r| {
                Ok(r.get::<_, i64>(0)? as u64)
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error);
        result
    }
    pub(crate) fn agent_overview_stale_items(
        &self,
        workspace_id: &str,
        scope: &Scope,
    ) -> AgentResult<Vec<String>> {
        let Some(head) = self.agent_overview_head(scope)? else {
            return Ok(vec![]);
        };
        let mut result = vec![];
        for item in head.items {
            let owner = format!("{}/{}/overview/{}", workspace_id, scope.key(), item.id);
            let dirty:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM source_dependency_invalidations WHERE owner_key=?1)",[owner],|r|r.get(0)).map_err(io_error)?;
            if dirty {
                result.push(item.id);
            }
        }
        Ok(result)
    }
    pub(crate) fn agent_overview_replay(
        &self,
        caller: &str,
        request: &str,
        input: &OverviewPublishInput,
    ) -> AgentResult<Option<AiOverview>> {
        self.overview_scope(&input.scope)?;
        match self.agent_operation_replay(caller, request, "overview.publish", input)? {
            Some(receipt) => Ok(Some(receipt)),
            None => self.overview_batch_replay(input),
        }
    }
    fn overview_batch_replay(
        &self,
        input: &OverviewPublishInput,
    ) -> AgentResult<Option<AiOverview>> {
        let batch: Option<(String, String)> = self.conn.query_row(
            "SELECT payload_json,snapshot_json FROM agent_overview_versions WHERE scope_key=?1 AND batch_id=?2",
            params![input.scope.key(),input.batch_id], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(io_error)?;
        match batch {
            Some((payload, snapshot)) => {
                let stored: serde_json::Value = decode(&payload)?;
                if stored != serde_json::to_value(input).map_err(|_| invalid("Invalid payload"))? {
                    return Err(AgentError::new(
                        ErrorCode::IdempotencyConflict,
                        "Overview batch already belongs to another payload",
                    ));
                }
                Ok(Some(decode(&snapshot)?))
            }
            None => Ok(None),
        }
    }
    pub(crate) fn agent_overview_publish(
        &self,
        caller: &str,
        request: &str,
        workspace_id: &str,
        input: &OverviewPublishInput,
        verify: impl FnOnce(&Database, &[OverviewItem]) -> AgentResult<()>,
    ) -> AgentResult<AiOverview> {
        input.validate()?;
        self.overview_scope(&input.scope)?;
        if !input.knowledge_upserts.is_empty() || !input.knowledge_removes.is_empty() {
            self.agent_knowledge_prepare().map_err(|_| {
                AgentError::new(ErrorCode::IoFailed, "Cannot prepare knowledge publication")
            })?;
        }
        self.agent_atomic_operation(caller,request,"overview.publish",input,|tx| {
            self.source_live_scope(&input.scope)?;
            if let Some(snapshot)=self.overview_batch_replay(input)? {
                return Ok((snapshot,None));
            }
            let head=self.agent_overview_head(&input.scope)?;
            if head.as_ref().map_or(0,|v|v.revision)!=input.expected_revision { return Err(AgentError::new(ErrorCode::RevisionConflict,"Overview head changed")); }
            if head.as_ref().is_some_and(|h|input.target_seq<h.as_of_seq) || input.target_seq>self.committed_change_watermark()? as u64 { return Err(invalid("Invalid Overview target watermark")); }
            let policy:i64=tx.query_row("SELECT revision FROM agent_scope_settings WHERE scope_key=?1",[input.scope.key()],|r|r.get(0)).optional().map_err(io_error)?.unwrap_or(0);
            let corrections=self.agent_overview_corrections(&input.scope)?;
            if policy as u64!=input.policy_revision || corrections.revision!=input.correction_revision { return Err(AgentError::new(ErrorCode::RevisionConflict,"Overview policy or corrections changed")); }
            let previous_items=head.as_ref().map_or_else(Vec::new,|h|h.items.clone());
            let mut items=head.map_or_else(Vec::new,|h|h.items);
            items.retain(|item|!input.remove_item_ids.contains(&item.id));
            for item in &input.upsert_items { if let Some(existing)=items.iter_mut().find(|v|v.id==item.id) { *existing=item.clone(); } else { items.push(item.clone()); } }
            validate_snapshot(&input.scope,&items)?;
            for item in &input.upsert_items { if item.source_refs.iter().any(|s|s.object.workspace_id!=workspace_id) { return Err(AgentError::new(ErrorCode::ScopeDenied,"Overview evidence belongs to another Workspace")); } }
            verify(self,&input.upsert_items)?;
            if !input.knowledge_upserts.is_empty() || !input.knowledge_removes.is_empty() {self.agent_knowledge_publish_in_transaction(workspace_id,&input.scope,input.expected_revision+1,input.target_seq,&input.knowledge_upserts,&input.knowledge_removes)?;}
            for key in &input.settled_object_keys {
                if !key.starts_with(&format!("{}/{}/",workspace_id,input.scope.key())) && !(matches!(input.scope,Scope::Workspace) && key.starts_with("published:")) {return Err(AgentError::new(ErrorCode::ScopeDenied,"Settled source belongs to another Workspace"));}
                tx.execute("DELETE FROM agent_overview_pending WHERE scope_key=?1 AND object_key=?2 AND last_seq<=?3",params![input.scope.key(),key,input.target_seq as i64]).map_err(io_error)?;
            }
            let pending=self.overview_pending_status_read(&input.scope)?;
            let mut coverage=input.coverage.clone();coverage.pending=pending.pending_count;
            let now=Utc::now().to_rfc3339();
            let result=AiOverview { scope:input.scope.clone(),revision:input.expected_revision+1,schema_version:1,items,as_of_seq:input.target_seq,source_manifest_hash:input.source_manifest_hash.clone(),built_at:now.clone(),coverage,pending_count:pending.pending_count,model_profile_id:input.model_profile_id.clone() };
            tx.execute("INSERT INTO agent_overview_versions(scope_key,revision,batch_id,snapshot_json,payload_json,target_seq,policy_revision,correction_revision,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![input.scope.key(),result.revision as i64,input.batch_id,encode(&result)?,encode(input)?,input.target_seq as i64,input.policy_revision as i64,input.correction_revision as i64,now]).map_err(io_error)?;
            tx.execute("INSERT INTO agent_overviews(scope_key,current_revision,as_of_seq,policy_revision,correction_revision,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_key) DO UPDATE SET current_revision=excluded.current_revision,as_of_seq=excluded.as_of_seq,policy_revision=excluded.policy_revision,correction_revision=excluded.correction_revision,updated_at=excluded.updated_at",params![input.scope.key(),result.revision as i64,input.target_seq as i64,input.policy_revision as i64,input.correction_revision as i64,now]).map_err(io_error)?;
            // Only mutated owners are replaced/acknowledged. Retained stale items keep dirtiness.
            for id in input.remove_item_ids.iter().chain(input.upsert_items.iter().map(|i|&i.id)) {
                let owner=format!("{}/{}/overview/{}",workspace_id,input.scope.key(),id);
                tx.execute("DELETE FROM content_reference_edges WHERE source_object_key=?1 AND relation='derived_from'",[&owner]).map_err(io_error)?;
                tx.execute("DELETE FROM agent_overview_dependencies WHERE scope_key=?1 AND item_id=?2",params![input.scope.key(),id]).map_err(io_error)?;
                tx.execute("DELETE FROM source_dependency_invalidations WHERE owner_key=?1 AND seq<=?2",params![owner,input.target_seq as i64]).map_err(io_error)?;
            }
            for item in &input.upsert_items {
                let owner=format!("{}/{}/overview/{}",workspace_id,input.scope.key(),item.id);
                for (ordinal,source) in item.source_refs.iter().enumerate() {
                    let key=source.object.key()?; let locator=encode(&source.locator)?;
                    tx.execute("INSERT INTO agent_overview_dependencies VALUES (?1,?2,?3,?4,?5,?6)",params![input.scope.key(),item.id,ordinal as i64,key,source.revision,encode(source)?]).map_err(io_error)?;
                    tx.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES (?1,?2,'derived_from',?3,?4)",params![owner,key,locator,source.revision]).map_err(io_error)?;
                }
                for parent in &item.dependency_item_ids { tx.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES (?1,?2,'derived_from','{}',?3)",params![owner,format!("{}/{}/overview/{}",workspace_id,input.scope.key(),parent),result.revision.to_string()]).map_err(io_error)?; }
                for parent in &item.published_sources { tx.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES (?1,?2,'derived_from','{}',?3)",params![owner,format!("{}/project:{}/overview/{}",workspace_id,parent.project_id,parent.item_id),parent.digest]).map_err(io_error)?; }
            }
            if let Scope::Project { project_id }=&input.scope {
                let previous=AiOverview {items:previous_items,..result.clone()};
                let ids:std::collections::BTreeSet<_>=previous.items.iter().chain(&result.items).map(|item|item.id.clone()).collect();
                for id in ids {
                    let old=previous.items.iter().find(|item|item.id==id)
                        .map(|_|published_material(&previous,&id,&corrections.items).map(|v|v.0)).transpose()?;
                    let new=result.items.iter().find(|item|item.id==id)
                        .map(|_|published_material(&result,&id,&corrections.items).map(|v|v.0)).transpose()?;
                    if old!=new {queue_published_change(tx,workspace_id,*project_id,&id,new.is_none())?;}
                    else if new.is_some() {
                        let owner=format!("{workspace_id}/project:{project_id}/overview/{id}");
                        let parent_dirty:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM source_dependency_invalidations WHERE owner_key=?1)",[&owner],|r|r.get(0)).map_err(io_error)?;
                        if !parent_dirty {
                            let raw_prefix=format!("{workspace_id}/project:{project_id}/");
                            tx.execute("DELETE FROM source_dependency_invalidations WHERE owner_key IN (
                                WITH RECURSIVE affected(key) AS (
                                    SELECT source_object_key FROM content_reference_edges WHERE relation='derived_from' AND target_object_key=?1
                                    UNION SELECT e.source_object_key FROM content_reference_edges e JOIN affected a ON e.target_object_key=a.key WHERE e.relation='derived_from'
                                ) SELECT key FROM affected)
                                AND changed_object_key LIKE ?2 AND changed_object_key NOT LIKE ?3 AND seq<=?4",
                                params![owner,format!("{raw_prefix}%"),format!("{raw_prefix}overview/%"),input.target_seq as i64]).map_err(io_error)?;
                        }
                    }
                }
            }
            // Evidence is immutable and owned by a specific published version, including retained items.
            for item in &result.items { for (ordinal,source) in item.source_refs.iter().enumerate() {
                let owner=format!("{}/{}/overview/{}/{}",workspace_id,input.scope.key(),result.revision,item.id);
                tx.execute("INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt) VALUES (?1,'overview',?2,?3,?4)",params![format!("{owner}/{ordinal}"),owner,encode(source)?,source.excerpt]).map_err(io_error)?;
            } }
            Ok((result,Some(OperationChange {object_key:format!("overview/{}",input.scope.key()),scope:input.scope.clone(),revision:(input.expected_revision+1).to_string()})))
        })
    }
    pub(crate) fn agent_overview_corrections(
        &self,
        scope: &Scope,
    ) -> AgentResult<OverviewCorrections> {
        self.overview_scope(scope)?;
        let revision: i64 = self
            .conn
            .query_row(
                "SELECT revision FROM agent_overview_correction_heads WHERE scope_key=?1",
                [scope.key()],
                |r| r.get(0),
            )
            .optional()
            .map_err(io_error)?
            .unwrap_or(0);
        let mut stmt=self.conn.prepare("SELECT correction_json FROM agent_overview_corrections WHERE scope_key=?1 ORDER BY id").map_err(io_error)?;
        let texts = stmt
            .query_map([scope.key()], |r| r.get::<_, String>(0))
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?;
        Ok(OverviewCorrections {
            scope: scope.clone(),
            revision: revision as u64,
            items: texts
                .iter()
                .map(|s| decode(s))
                .collect::<AgentResult<_>>()?,
        })
    }
    pub(crate) fn agent_overview_correction_upsert(
        &self,
        caller: &str,
        request: &str,
        input: &OverviewCorrectionUpsert,
    ) -> AgentResult<OverviewCorrections> {
        validate_id(&input.id)?;
        if let Some(id) = &input.item_id {
            validate_id(id)?;
        }
        if input.text.chars().count() > 2000 || input.expected_revision >= i64::MAX as u64 {
            return Err(invalid("Correction exceeds bounds"));
        }
        self.overview_scope(&input.scope)?;
        self.agent_atomic_operation(caller, request, "overview.correction.upsert", input, |_| {
            self.overview_save_correction(
                &input.scope,
                &input.id,
                input.expected_revision,
                Some((&input.text, input.item_id.clone())),
            )
        })
    }
    pub(crate) fn agent_overview_correction_delete(
        &self,
        caller: &str,
        request: &str,
        input: &OverviewCorrectionDelete,
    ) -> AgentResult<OverviewCorrections> {
        validate_id(&input.id)?;
        if input.expected_revision >= i64::MAX as u64 {
            return Err(invalid("Invalid correction revision"));
        }
        self.overview_scope(&input.scope)?;
        self.agent_atomic_operation(caller, request, "overview.correction.delete", input, |_| {
            self.overview_save_correction(&input.scope, &input.id, input.expected_revision, None)
        })
    }
    fn overview_save_correction(
        &self,
        scope: &Scope,
        id: &str,
        expected: u64,
        update: Option<(&str, Option<String>)>,
    ) -> AgentResult<(OverviewCorrections, Option<OperationChange>)> {
        self.source_live_scope(scope)?;
        let current = self.agent_overview_corrections(scope)?;
        if current.revision != expected {
            return Err(AgentError::new(
                ErrorCode::RevisionConflict,
                "Overview corrections changed",
            ));
        }
        let existing = current.items.iter().find(|i| i.id == id);
        if update.is_none() && existing.map_or(true, |i| i.deleted) {
            return Err(AgentError::new(ErrorCode::NotFound, "Correction not found"));
        }
        if existing.is_none() && current.items.len() >= 100 {
            return Err(AgentError::new(
                ErrorCode::BudgetExceeded,
                "Correction count exceeds bounds",
            ));
        }
        let now = Utc::now().to_rfc3339();
        let item = OverviewCorrection {
            id: id.into(),
            scope: scope.clone(),
            item_id: update.as_ref().map_or_else(
                || existing.and_then(|i| i.item_id.clone()),
                |(_, id)| id.clone(),
            ),
            text: update.as_ref().map_or_else(
                || existing.map_or_else(String::new, |i| i.text.clone()),
                |(text, _)| (*text).into(),
            ),
            revision: expected + 1,
            deleted: update.is_none(),
            created_at: existing.map_or_else(|| now.clone(), |i| i.created_at.clone()),
            updated_at: now,
        };
        let json = encode(&item)?;
        self.conn.execute("INSERT INTO agent_overview_correction_heads VALUES (?1,?2) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision",params![scope.key(),item.revision as i64]).map_err(io_error)?;
        self.conn.execute("INSERT INTO agent_overview_corrections VALUES (?1,?2,?3) ON CONFLICT(scope_key,id) DO UPDATE SET correction_json=excluded.correction_json",params![scope.key(),id,json]).map_err(io_error)?;
        self.conn
            .execute(
                "INSERT INTO agent_overview_correction_versions VALUES (?1,?2,?3,?4)",
                params![scope.key(), item.revision as i64, id, json],
            )
            .map_err(io_error)?;
        if let (Scope::Project {project_id},Some(workspace_id))=(scope,self.native_workspace_id.as_deref()) {
            let head=self.agent_overview_head(scope)?;
            let mut affected=std::collections::BTreeSet::new();
            for candidate in existing.into_iter().map(|c|c.item_id.as_ref()).chain(std::iter::once(item.item_id.as_ref())) {
                if let Some(id)=candidate {affected.insert(id.clone());}
                else if let Some(snapshot)=&head {affected.extend(snapshot.items.iter().map(|i|i.id.clone()));}
            }
            if let Some(snapshot)=&head {
                loop {
                    let prior=affected.len();
                    affected.extend(snapshot.items.iter().filter(|entry|entry.dependency_item_ids.iter().any(|id|affected.contains(id))).map(|entry|entry.id.clone()).collect::<Vec<_>>());
                    if affected.len()==prior {break;}
                }
            }
            for id in affected {queue_published_change(&self.conn,workspace_id,*project_id,&id,false)?;}
        }
        Ok((
            self.agent_overview_corrections(scope)?,
            Some(OperationChange {
                object_key: format!("overview_correction/{}", scope.key()),
                scope: scope.clone(),
                revision: item.revision.to_string(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    // Remove schema31/30 additions before this fixture simulates an older file.
    const REMOVE_LATER_AGENT_SCHEMA: &str = r#"
DROP TABLE agent_run_source_dependencies; DROP TABLE agent_run_provenance; DROP TABLE agent_session_scan_state;
DROP INDEX agent_session_search_rows_session;
DROP TRIGGER agent_session_search_row_delete;
DROP TABLE agent_session_search_rows;
DROP TABLE agent_session_search_fts;
DROP VIEW agent_visible_files;
DROP VIEW agent_visible_todos;
DROP TABLE todo_revision_heads;
DROP TABLE todo_revision_snapshots;
DROP INDEX agent_todo_output_dedupe;
ALTER TABLE agent_outputs DROP COLUMN dedupe_key;
DROP VIEW agent_visible_notes;
DROP VIEW agent_visible_workspace_notes;
DROP TABLE agent_object_withdrawals;
DROP INDEX idx_agent_receipt_operation_id;
DROP INDEX idx_agent_receipts_run;
ALTER TABLE agent_operation_receipts DROP COLUMN operation_id;
ALTER TABLE agent_operation_receipts DROP COLUMN run_id;
ALTER TABLE agent_operation_receipts DROP COLUMN target_ref_json;
ALTER TABLE agent_operation_receipts DROP COLUMN before_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN after_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN before_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN after_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN output_context_json;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_state;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_operation_id;
"#;

    use super::*;
    use crate::{
        agent::{
            context::{EpistemicStatus, OverviewSection, SourceCoverage, ValidState},
            models::{ObjectKind, ObjectRef, SourceRef},
        },
        models::ProjectCreateInput,
    };
    fn setup() -> (tempfile::TempDir, Database, Scope) {
        let root = tempfile::tempdir().unwrap();
        let mut db =
            Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Overview".into(),
                summary: Some("user buffer".into()),
                status: None,
            })
            .unwrap();
        db.source_registry_prepare().unwrap();
        (
            root,
            db,
            Scope::Project {
                project_id: project.id,
            },
        )
    }
    fn item(id: &str) -> OverviewItem {
        OverviewItem {
            id: id.into(),
            section: OverviewSection::Profile,
            text: id.into(),
            epistemic_status: EpistemicStatus::Inferred,
            source_refs: vec![],
            published_sources: vec![],
            dependency_item_ids: vec![],
            valid_state: ValidState::Current,
            updated_at: "original time".into(),
        }
    }
    #[test]
    fn published_digest_tracks_dependency_semantics_without_display_or_unrelated_changes() {
        let scope=Scope::Project{project_id:7};
        let source=SourceRef {object:ObjectRef {workspace_id:"w".into(),scope:scope.clone(),
            kind:ObjectKind::File,id:"3".into()},revision:"content-hash".into(),
            file_version:Some(1),record_version:None,block_id:None,locator:None,
            title:"Old filename".into(),excerpt:"Old display excerpt".into()};
        let mut base=item("basis");base.source_refs=vec![source];
        let mut child=item("child");child.dependency_item_ids=vec!["basis".into()];
        let unrelated=item("other");
        let mut snapshot=AiOverview {scope,revision:1,schema_version:1,items:vec![base,child,unrelated],
            as_of_seq:1,source_manifest_hash:"test".into(),built_at:"now".into(),
            coverage:SourceCoverage{processed:1,partial:0,excluded:0,unsupported:0,pending:0},
            pending_count:0,model_profile_id:"test".into()};
        let first=published_material(&snapshot,"child",&[]).unwrap().0;
        snapshot.revision=2;snapshot.items[2].text="unrelated update".into();
        snapshot.items[0].source_refs[0].title="Renamed File".into();
        snapshot.items[0].source_refs[0].excerpt="New display excerpt".into();
        assert_eq!(published_material(&snapshot,"child",&[]).unwrap().0,first);
        snapshot.items[0].source_refs[0].revision="new-content-hash".into();
        assert_ne!(published_material(&snapshot,"child",&[]).unwrap().0,first);
        snapshot.items[0].source_refs[0].revision="content-hash".into();
        let correction=OverviewCorrection {id:"c".into(),scope:snapshot.scope.clone(),
            item_id:Some("basis".into()),text:"Corrected interpretation".into(),revision:1,
            deleted:false,created_at:"now".into(),updated_at:"now".into()};
        assert_ne!(published_material(&snapshot,"child",&[correction]).unwrap().0,first);
    }
    #[test]
    fn project_publish_queues_only_changed_parent_items() {
        let (_root,db,scope_a)=setup();
        let project_b=db.project_create(ProjectCreateInput {
            name:"Other project".into(),summary:None,status:None,
        }).unwrap();
        let scope_b=Scope::Project{project_id:project_b.id};
        let mut first_a=input(&db,&scope_a);
        first_a.upsert_items.push(item("stable"));
        publish(&db,"publish-a",&first_a).unwrap();
        let mut first_b=input(&db,&scope_b);
        first_b.batch_id="batch-b".into();
        publish(&db,"publish-b",&first_b).unwrap();
        db.conn.execute("DELETE FROM agent_overview_pending WHERE scope_key='workspace'",[]).unwrap();
        let mut second=input(&db,&scope_a);
        second.batch_id="batch-a2".into();
        second.expected_revision=1;
        second.upsert_items[0].text="Changed meaning".into();
        publish(&db,"publish-a2",&second).unwrap();
        let keys=db.conn.prepare("SELECT object_key FROM agent_overview_pending WHERE scope_key='workspace' ORDER BY object_key")
            .unwrap().query_map([],|row|row.get::<_,String>(0)).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let project_a=match scope_a {Scope::Project{project_id}=>project_id,_=>unreachable!()};
        assert_eq!(keys,vec![format!("published:{project_a}:a")]);
    }
    #[test]
    fn deferred_parent_keeps_pending_while_next_project_runs() {
        let (_root,mut db,scope_a)=setup();
        db.bind_native_workspace("w").unwrap();
        let project_b=db.project_create(ProjectCreateInput{name:"B".into(),summary:None,status:None}).unwrap();
        let scope_b=Scope::Project{project_id:project_b.id};
        let mut a=input(&db,&scope_a);a.batch_id="defer-a".into();
        publish(&db,"defer-project-a",&a).unwrap();
        let mut b=input(&db,&scope_b);b.batch_id="defer-b".into();
        publish(&db,"defer-project-b",&b).unwrap();
        let binding=crate::agent::models::WorkspaceBinding{workspace_id:"w".into(),generation:"one".into()};
        let workspace=Scope::Workspace;
        let first=db.agent_overview_maintenance_prepare(&binding,&workspace,Utc::now()).unwrap().unwrap();
        assert_eq!(first.source_object.published().unwrap().project_id,match scope_a {Scope::Project{project_id}=>project_id,_=>unreachable!()});
        db.agent_overview_maintenance_defer_published(&binding,&workspace,&first.batch_id,
            ErrorCode::SourceNotReady,Utc::now()).unwrap();
        let status=db.agent_overview_maintenance_status(&binding,&workspace).unwrap();
        assert_eq!(status.deferred_count,1);
        assert_eq!(status.error_code,None);
        assert_eq!(status.pending_count,2);
        let second=db.agent_overview_maintenance_prepare(&binding,&workspace,Utc::now()).unwrap().unwrap();
        assert_eq!(second.source_object.published().unwrap().project_id,project_b.id);
    }
    fn input(db: &Database, scope: &Scope) -> OverviewPublishInput {
        OverviewPublishInput {
            scope: scope.clone(),
            batch_id: "batch-0".into(),
            expected_revision: 0,
            target_seq: db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![item("a")],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: vec![],
            knowledge_removes: vec![],
            coverage: SourceCoverage {
                processed: 0,
                partial: 1,
                excluded: 0,
                unsupported: 0,
                pending: 1,
            },
            source_manifest_hash: "manifest".into(),
            model_profile_id: "profile".into(),
        }
    }
    fn publish(db: &Database, request: &str, p: &OverviewPublishInput) -> AgentResult<AiOverview> {
        db.agent_overview_publish("gui", request, "w", p, |_, _| Ok(()))
    }
    #[test]
    fn overview_reopen_preserves_snapshot_and_user_buffer() {
        let (root, db, scope) = setup();
        let p = input(&db, &scope);
        let before: Option<String> = db
            .conn
            .query_row(
                "SELECT summary FROM projects WHERE id=?1",
                [match scope {
                    Scope::Project { project_id } => project_id,
                    _ => 0,
                }],
                |r| r.get(0),
            )
            .unwrap();
        publish(&db, "one", &p).unwrap();
        drop(db);
        let db = Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        assert_eq!(
            db.agent_overview_head(&scope).unwrap().unwrap().items[0].text,
            "a"
        );
        let after: Option<String> = db
            .conn
            .query_row(
                "SELECT summary FROM projects WHERE id=?1",
                [match scope {
                    Scope::Project { project_id } => project_id,
                    _ => 0,
                }],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            db.conn
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            super::super::CURRENT_SCHEMA_VERSION
        );
    }
    #[test]
    fn overview_cas_and_callback_failure_are_atomic() {
        let (_root, db, scope) = setup();
        let p = input(&db, &scope);
        assert!(db
            .agent_overview_publish("gui", "failed", "w", &p, |_, _| Err(invalid("injected")))
            .is_err());
        assert!(db.agent_overview_head(&scope).unwrap().is_none());
        publish(&db, "one", &p).unwrap();
        let mut stale = p.clone();
        stale.batch_id = "stale-batch".into();
        stale.target_seq += 1;
        assert_eq!(
            publish(&db, "stale", &stale).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(db.agent_overview_versions(&scope, 0, 100).unwrap(), vec![1]);
    }
    #[test]
    fn overview_receipt_insert_failure_rolls_back_published_rows() {
        let (_root, db, scope) = setup();
        let p = input(&db, &scope);
        db.overview_scope(&scope).unwrap();
        db.conn.execute_batch("CREATE TEMP TRIGGER fail_overview_receipt BEFORE INSERT ON agent_operation_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END").unwrap();
        assert_eq!(
            publish(&db, "failed", &p).unwrap_err().code,
            ErrorCode::IoFailed
        );
        assert!(db.agent_overview_head(&scope).unwrap().is_none());
        assert!(db
            .agent_overview_versions(&scope, 0, 100)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM agent_overview_dependencies",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    #[test]
    fn overview_receipt_and_batch_replay_are_stable() {
        let (_root, db, scope) = setup();
        let p = input(&db, &scope);
        publish(&db, "one", &p).unwrap();
        let replay = db
            .agent_overview_publish("gui", "one", "w", &p, |_, _| {
                panic!("must not verify replay")
            })
            .unwrap();
        assert_eq!(replay.revision, 1);
        assert_eq!(
            db.agent_overview_publish("gui", "two", "w", &p, |_, _| panic!(
                "must not verify batch"
            ))
            .unwrap()
            .revision,
            1
        );
        let mut different = p;
        different.upsert_items[0].text = "different".into();
        assert_eq!(
            publish(&db, "one", &different).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        assert_eq!(
            publish(&db, "three", &different).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
    }
    #[test]
    fn overview_mutations_preserve_unselected_items() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope);
        p.upsert_items.push(item("b"));
        publish(&db, "one", &p).unwrap();
        p.batch_id = "batch-1".into();
        p.expected_revision = 1;
        p.target_seq = db.committed_change_watermark().unwrap() as u64;
        p.upsert_items = vec![item("b")];
        p.upsert_items[0].text = "new".into();
        let head = publish(&db, "two", &p).unwrap();
        assert_eq!(head.items[0].updated_at, "original time");
        assert_eq!(head.items[0].text, "a");
        assert_eq!(
            db.agent_overview_version(&scope, 1).unwrap().unwrap().items[1].text,
            "b"
        );
    }
    #[test]
    fn overview_budget_dependencies_and_confirmation_are_rejected() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope);
        p.upsert_items[0].text = "界".repeat(8001);
        assert_eq!(
            publish(&db, "budget", &p).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        p.upsert_items[0] = item("a");
        p.upsert_items[0].dependency_item_ids = vec!["missing".into()];
        assert!(publish(&db, "dangling", &p).is_err());
        p.upsert_items[0] = item("a");
        p.upsert_items[0].epistemic_status = EpistemicStatus::UserConfirmed;
        assert!(publish(&db, "confirmed", &p).is_err());
        p.upsert_items = vec![item("claim"), item("unsupported")];
        p.upsert_items[0].epistemic_status = EpistemicStatus::Recorded;
        p.upsert_items[0].dependency_item_ids = vec!["unsupported".into()];
        assert!(publish(&db, "unsupported-chain", &p).is_err());
        assert!(db.agent_overview_head(&scope).unwrap().is_none());
    }
    #[test]
    fn overview_corrections_have_independent_cas_and_tombstones() {
        let (_root, db, scope) = setup();
        let p = input(&db, &scope);
        let correction = OverviewCorrectionUpsert {
            scope: scope.clone(),
            id: "fix".into(),
            item_id: Some("future".into()),
            text: "用户原文".into(),
            expected_revision: 0,
        };
        let saved = db
            .agent_overview_correction_upsert("gui", "fix", &correction)
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            db.agent_overview_correction_upsert("gui", "fix", &correction)
                .unwrap()
                .revision,
            1
        );
        assert_eq!(
            publish(&db, "old", &p).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        let deleted = db
            .agent_overview_correction_delete(
                "gui",
                "delete",
                &OverviewCorrectionDelete {
                    scope: scope.clone(),
                    id: "fix".into(),
                    expected_revision: 1,
                },
            )
            .unwrap();
        assert_eq!(deleted.revision, 2);
        assert!(deleted.items[0].deleted);
        assert_eq!(deleted.items[0].text, "用户原文");
    }
    #[test]
    fn overview_real_source_event_invalidates_derived_item() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope);
        let source = ObjectRef {
            workspace_id: "w".into(),
            scope: scope.clone(),
            kind: ObjectKind::Project,
            id: match scope {
                Scope::Project { project_id } => project_id.to_string(),
                _ => unreachable!(),
            },
        };
        p.upsert_items[0].source_refs = vec![SourceRef {
            object: source.clone(),
            revision: "sha256:source".into(),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
            title: "project".into(),
            excerpt: "".into(),
        }];
        publish(&db, "one", &p).unwrap();
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,'project.update','changed','now')",params![source.key().unwrap(),scope.key()]).unwrap();
        assert_eq!(
            db.agent_overview_stale_items("w", &scope).unwrap(),
            vec!["a"]
        );
    }
    fn source_event(
        db: &Database,
        scope: &Scope,
        id: &str,
        operation: &str,
        revision: &str,
    ) -> (String, u64) {
        let key = format!("w/{}/record/{}", scope.key(), id);
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES (?1,?2,?3,?4,'now')",params![key,scope.key(),operation,revision]).unwrap();
        (key, db.committed_change_watermark().unwrap() as u64)
    }
    #[test]
    fn overview_pending_coalesces_and_survives_reopen_log_pruning() {
        let (root, db, scope) = setup();
        db.agent_overviews_prepare().unwrap();
        let (key, first) = source_event(&db, &scope, "101", "record.update", "first");
        source_event(&db, &scope, "101", "record.update", "second");
        let (_, last) = source_event(&db, &scope, "101", "record.delete", "deleted");
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        drop(db);
        let db = Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        let page = db
            .agent_overview_pending_page(&scope, last, None, 100)
            .unwrap();
        assert_eq!(page.pending_count, 1);
        assert!(page.needs_rebuild);
        assert_eq!(page.items[0].object_key, key);
        assert_eq!(page.items[0].first_seq, first);
        assert_eq!(page.items[0].last_seq, last);
        assert!(page.items[0].deleted);
        assert_eq!(page.items[0].latest_revision, "deleted");
    }
    #[test]
    fn overview_pending_bootstrap_preserves_registry_tombstones_without_claiming_complete_inventory(
    ) {
        let (_root, db, scope) = setup();
        let (key, _) = source_event(&db, &scope, "102", "record.delete", "deleted");
        db.conn.execute("DELETE FROM agent_change_log", []).unwrap();
        // Emulate pre-29 staged registry tombstones before the one-time
        // Overview bootstrap; current databases prepare this on initial open.
        db.conn
            .execute_batch(
                "DELETE FROM agent_overview_pending;
            DELETE FROM agent_overview_pending_state;
            DELETE FROM agent_overview_pending_bootstrap;",
            )
            .unwrap();
        db.agent_overviews_prepare().unwrap();
        let page = db
            .agent_overview_pending_page(
                &scope,
                db.committed_change_watermark().unwrap() as u64,
                None,
                100,
            )
            .unwrap();
        assert!(page.needs_rebuild);
        assert_eq!(page.items[0].object_key, key);
        assert!(page.items[0].deleted);
        assert_eq!(page.items[0].operation, "bootstrap.deleted");
    }
    #[test]
    fn overview_pending_exclusion_uses_actual_policy_state() {
        let (_root, db, scope) = setup();
        db.agent_overviews_prepare().unwrap();
        let (key, _) = source_event(&db, &scope, "103", "record.update", "content");
        db.conn
            .execute(
                "INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",
                [&key],
            )
            .unwrap();
        let (_, seq) = source_event(&db, &scope, "103", "source.policy.update", "sha256:policy");
        let page = db
            .agent_overview_pending_page(&scope, seq, None, 100)
            .unwrap();
        assert!(page.items[0].excluded);
        assert!(!page.items[0].deleted);
        db.conn
            .execute(
                "UPDATE source_access_policies SET excluded=0,revision=2 WHERE object_key=?1",
                [key],
            )
            .unwrap();
        let (_, seq) = source_event(
            &db,
            &scope,
            "103",
            "source.policy.update",
            "sha256:unexcluded",
        );
        assert!(
            !db.agent_overview_pending_page(&scope, seq, None, 100)
                .unwrap()
                .items[0]
                .excluded
        );
    }
    #[test]
    fn overview_pending_page_is_bounded_and_keeps_later_changes() {
        let (_root, db, scope) = setup();
        db.agent_overviews_prepare().unwrap();
        source_event(&db, &scope, "104", "record.update", "a");
        source_event(&db, &scope, "105", "record.update", "b");
        let (_, captured) = source_event(&db, &scope, "106", "record.update", "c");
        let first = db
            .agent_overview_pending_page(&scope, captured, None, 1)
            .unwrap();
        assert_eq!(first.items.len(), 1);
        assert!(first.next_cursor.is_some());
        let second = db
            .agent_overview_pending_page(&scope, captured, first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(
            second.items[0].object_key,
            "w/".to_owned() + &scope.key() + "/record/105"
        );
        source_event(&db, &scope, "105", "record.update", "later");
        let bounded = db
            .agent_overview_pending_page(&scope, captured, None, 100)
            .unwrap();
        assert_eq!(bounded.items.len(), 2);
        assert_eq!(bounded.pending_count, 3);
        assert_eq!(
            db.agent_overview_pending_page(&scope, captured, None, 201)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn overview_pending_publish_ack_is_explicit_atomic_and_does_not_loop() {
        let (root, db, scope) = setup();
        db.agent_overviews_prepare().unwrap();
        let (settled, _) = source_event(&db, &scope, "107", "record.update", "a");
        source_event(&db, &scope, "108", "record.update", "b");
        let mut p = input(&db, &scope);
        p.settled_object_keys = vec![settled];
        p.coverage.pending = 999;
        db.conn.execute_batch("CREATE TEMP TRIGGER fail_pending_receipt BEFORE INSERT ON agent_operation_receipts BEGIN SELECT RAISE(ABORT,'fail pending ack commit'); END").unwrap();
        assert!(publish(&db, "failed-pending", &p).is_err());
        assert_eq!(
            db.agent_overview_pending_status(&scope)
                .unwrap()
                .pending_count,
            2
        );
        assert!(db.agent_overview_head(&scope).unwrap().is_none());
        db.conn
            .execute_batch("DROP TRIGGER fail_pending_receipt")
            .unwrap();
        let snapshot = publish(&db, "acked", &p).unwrap();
        assert_eq!(snapshot.pending_count, 1);
        assert_eq!(snapshot.coverage.pending, 1);
        assert_eq!(
            db.agent_overview_pending_status(&scope)
                .unwrap()
                .pending_count,
            1
        );
        assert!(
            db.agent_overview_pending_status(&scope)
                .unwrap()
                .needs_rebuild
        );
        drop(db);
        let db = Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        assert_eq!(
            db.agent_overview_pending_status(&scope)
                .unwrap()
                .pending_count,
            1
        );
        let replay = db
            .agent_overview_publish("gui", "acked", "w", &p, |_, _| {
                panic!("receipt must skip verification")
            })
            .unwrap();
        assert_eq!(replay.pending_count, 1);
    }
    #[test]
    fn overview_pending_event_after_capture_is_not_acknowledged_by_old_publish() {
        let (_root, db, scope) = setup();
        db.agent_overviews_prepare().unwrap();
        let (key, _) = source_event(&db, &scope, "109", "record.update", "captured");
        let mut p = input(&db, &scope);
        p.settled_object_keys = vec![key];
        let result = db
            .agent_overview_publish("gui", "later", "w", &p, |db, _| {
                source_event(db, &scope, "109", "record.update", "concurrent-later");
                Ok(())
            })
            .unwrap();
        assert_eq!(result.pending_count, 1);
        assert_eq!(result.coverage.pending, 1);
        let page = db
            .agent_overview_pending_page(&scope, p.target_seq, None, 100)
            .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.pending_count, 1);
        let page = db
            .agent_overview_pending_page(
                &scope,
                db.committed_change_watermark().unwrap() as u64,
                None,
                100,
            )
            .unwrap();
        assert_eq!(page.items[0].latest_revision, "concurrent-later");
    }

    #[test]
    fn overview_same_watermark_continuations_have_distinct_batches_and_keep_late_pending() {
        let (_root, db, scope) = setup();
        let (first_key, _) = source_event(&db, &scope, "201", "record.update", "first");
        let (second_key, _) = source_event(&db, &scope, "202", "record.update", "second");
        let (unread_key, _) = source_event(&db, &scope, "203", "record.update", "unread");
        let mut first = input(&db, &scope);
        first.batch_id = "maintenance-job-1-batch-1".into();
        first.settled_object_keys = vec![first_key];
        let first_receipt = publish(&db, "first-batch", &first).unwrap();
        assert_eq!(first_receipt.revision, 1);
        assert_eq!(first_receipt.pending_count, 2);
        let mut continuation = first.clone();
        continuation.batch_id = "maintenance-job-1-batch-2".into();
        continuation.expected_revision = 1;
        continuation.settled_object_keys = vec![second_key.clone()];
        continuation.upsert_items = vec![item("b")];
        let second_receipt = db
            .agent_overview_publish("gui", "second-batch", "w", &continuation, |db, _| {
                source_event(db, &scope, "202", "record.update", "late-edit");
                Ok(())
            })
            .unwrap();
        assert_eq!(second_receipt.revision, 2);
        assert_eq!(second_receipt.as_of_seq, first_receipt.as_of_seq);
        assert_eq!(second_receipt.items.len(), 2);
        assert_eq!(second_receipt.pending_count, 2);
        let pending = db
            .agent_overview_pending_page(&scope, first.target_seq, None, 100)
            .unwrap();
        assert_eq!(pending.items.len(), 1);
        assert_eq!(pending.items[0].object_key, unread_key);
        let latest = db
            .agent_overview_pending_page(
                &scope,
                db.committed_change_watermark().unwrap() as u64,
                None,
                100,
            )
            .unwrap();
        assert!(latest
            .items
            .iter()
            .any(|item| item.object_key == second_key && item.latest_revision == "late-edit"));
        let watermark = db.committed_change_watermark().unwrap();
        let replay = db
            .agent_overview_publish("gui", "retry-new-request", "w", &continuation, |_, _| {
                panic!("same batch must not consume/verify again")
            })
            .unwrap();
        assert_eq!(encode(&replay).unwrap(), encode(&second_receipt).unwrap());
        assert_eq!(db.committed_change_watermark().unwrap(), watermark);
        assert_eq!(
            db.agent_overview_versions(&scope, 0, 100).unwrap(),
            vec![1, 2]
        );
        let mut changed = continuation.clone();
        changed.expected_revision = 2;
        assert_eq!(
            publish(&db, "changed-baseline", &changed).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        changed = continuation.clone();
        changed.upsert_items[0].text = "different payload".into();
        assert_eq!(
            publish(&db, "changed-payload", &changed).unwrap_err().code,
            ErrorCode::IdempotencyConflict
        );
        changed = continuation.clone();
        changed.batch_id = "maintenance-job-1-batch-3".into();
        assert_eq!(
            publish(&db, "stale-head", &changed).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        changed.batch_id = "legacy:1".into();
        assert_eq!(
            publish(&db, "reserved-legacy", &changed).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        changed.batch_id = "maintenance-job-1-batch-3".into();
        changed.expected_revision = 2;
        db.conn
            .execute(
                "INSERT INTO agent_scope_settings(scope_key,revision) VALUES (?1,1)",
                [scope.key()],
            )
            .unwrap();
        assert_eq!(
            publish(&db, "changed-policy", &changed).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        assert_eq!(
            db.agent_overview_versions(&scope, 0, 100).unwrap(),
            vec![1, 2]
        );
    }

    #[test]
    fn overview_schema29_migrates_legacy_unique_watermark_without_rewriting_history() {
        let (root, db, scope) = setup();
        let original = input(&db, &scope);
        publish(&db, "legacy-publish", &original).unwrap();
        db.conn.execute_batch("ALTER TABLE agent_overview_versions RENAME TO current_versions;
            CREATE TABLE agent_overview_versions (
                scope_key TEXT NOT NULL, revision INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
                payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), target_seq INTEGER NOT NULL,
                policy_revision INTEGER NOT NULL, correction_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(scope_key,revision), UNIQUE(scope_key,target_seq,policy_revision,correction_revision));
            INSERT INTO agent_overview_versions SELECT scope_key,revision,snapshot_json,
                '  '||json_remove(payload_json,'$.batchId')||char(10),target_seq,policy_revision,correction_revision,created_at FROM current_versions;
            DROP TABLE current_versions;
            INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt)
                VALUES ('legacy-evidence','overview','legacy-owner','{}','original evidence');").unwrap();
        let before: (String, String, String) = db
            .conn
            .query_row(
                "SELECT snapshot_json,payload_json,created_at FROM agent_overview_versions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        db.conn.execute_batch(REMOVE_LATER_AGENT_SCHEMA).unwrap();
        db.set_schema_version(28).unwrap();
        drop(db);
        let reopened =
            Database::open(&root.path().join("overview.sqlite"), root.path(), None).unwrap();
        let after: (String, String, String, String) = reopened.conn.query_row("SELECT snapshot_json,payload_json,created_at,batch_id FROM agent_overview_versions", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
        assert_eq!((after.0, after.1, after.2), before);
        assert_eq!(after.3, "legacy:1");
        assert_eq!(
            reopened
                .agent_overview_head(&scope)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert_eq!(
            reopened
                .conn
                .query_row(
                    "SELECT excerpt FROM agent_evidence WHERE id='legacy-evidence'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "original evidence"
        );
        let mut next = original;
        next.batch_id = "post-migration-batch".into();
        next.expected_revision = 1;
        next.upsert_items = vec![item("b")];
        let result = publish(&reopened, "post-migration", &next).unwrap();
        assert_eq!(result.revision, 2);
        assert_eq!(
            reopened.agent_overview_versions(&scope, 0, 100).unwrap(),
            vec![1, 2]
        );
    }
}
