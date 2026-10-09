//! Internal knowledge current pointers publish only in the Overview transaction.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    knowledge::*,
    models::Scope,
    overview::{invalid, validate_id},
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

fn encode(value: &impl Serialize) -> AgentResult<String> {
    serde_json::to_string(value).map_err(|_| invalid("Invalid knowledge payload"))
}
fn decode<T: DeserializeOwned>(value: &str) -> AgentResult<T> {
    serde_json::from_str(value)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Invalid stored knowledge snapshot"))
}
fn kind_key(kind: KnowledgeKind) -> AgentResult<String> {
    let value = serde_json::to_value(kind).map_err(|_| invalid("Invalid knowledge kind"))?;
    Ok(value
        .as_str()
        .ok_or_else(|| invalid("Invalid knowledge kind"))?
        .into())
}

impl Database {
    pub(crate) fn agent_published_knowledge_ids(&self,project_id:i64,item_id:&str)->AgentResult<Vec<String>> {
        validate_id(item_id)?;
        let prefix=published_node_prefix(project_id,item_id);
        let mut stmt=self.conn.prepare("SELECT node_id FROM agent_knowledge_nodes WHERE scope_key='workspace' AND deleted=0 AND node_id LIKE ?1 ORDER BY node_id").map_err(io_error)?;
        let result=stmt.query_map([format!("{prefix}%")],|r|r.get::<_,String>(0)).map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(io_error);
        result
    }
    pub(crate) fn agent_knowledge_prepare(&self) -> anyhow::Result<()> {
        self.conn
            .execute_batch("SAVEPOINT agent_knowledge_prepare")?;
        match self.conn.execute_batch(include_str!("agent_knowledge.sql")) {
            Ok(()) => {
                self.conn.execute_batch("RELEASE agent_knowledge_prepare")?;
                Ok(())
            }
            Err(error) => {
                self.conn.execute_batch(
                    "ROLLBACK TO agent_knowledge_prepare; RELEASE agent_knowledge_prepare",
                )?;
                Err(error.into())
            }
        }
    }
    fn knowledge_scope(&self, scope: &Scope) -> AgentResult<()> {
        scope.validate()?;
        self.source_live_scope(scope)?;
        self.agent_knowledge_prepare()
            .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare knowledge storage"))
    }
    pub(crate) fn agent_knowledge_get(
        &self,
        scope: &Scope,
        id: &str,
        version: Option<u64>,
    ) -> AgentResult<Option<KnowledgeNode>> {
        self.knowledge_scope(scope)?;
        validate_id(id)?;
        if version.is_some_and(|v| v == 0 || v > i64::MAX as u64) {
            return Err(invalid("Invalid knowledge revision"));
        }
        let text: Option<String> = if let Some(revision) = version {
            self.conn.query_row("SELECT snapshot_json FROM agent_knowledge_versions WHERE scope_key=?1 AND node_id=?2 AND revision=?3",params![scope.key(),id,revision as i64],|r|r.get(0)).optional().map_err(io_error)?
        } else {
            self.conn.query_row("SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision WHERE n.scope_key=?1 AND n.node_id=?2 AND n.deleted=0",params![scope.key(),id],|r|r.get(0)).optional().map_err(io_error)?
        };
        text.as_deref().map(decode).transpose()
    }
    pub(crate) fn agent_knowledge_baselines(
        &self,
        scope: &Scope,
        id: &str,
        revision: u64,
    ) -> AgentResult<(u64, u64)> {
        self.knowledge_scope(scope)?;
        validate_id(id)?;
        if revision == 0 || revision > i64::MAX as u64 {
            return Err(invalid("Invalid knowledge revision"));
        }
        self.conn.query_row("SELECT o.policy_revision,o.correction_revision FROM agent_knowledge_versions k JOIN agent_overview_versions o ON o.scope_key=k.scope_key AND o.revision=k.overview_revision WHERE k.scope_key=?1 AND k.node_id=?2 AND k.revision=?3",params![scope.key(),id,revision as i64],|r|Ok((r.get::<_,i64>(0)? as u64,r.get::<_,i64>(1)? as u64))).optional().map_err(io_error)?.ok_or_else(||AgentError::new(ErrorCode::NotFound,"Knowledge publication baseline not found"))
    }
    pub(crate) fn agent_knowledge_stale_ids(
        &self,
        workspace_id: &str,
        scope: &Scope,
        ids: &[String],
    ) -> AgentResult<Vec<String>> {
        self.knowledge_scope(scope)?;
        if ids.len() > 50 {
            return Err(invalid("Knowledge stale selection exceeds bounds"));
        }
        let mut result = vec![];
        for id in ids {
            validate_id(id)?;
            let owner = format!("{}/{}/knowledge/{}", workspace_id, scope.key(), id);
            let dirty:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM source_dependency_invalidations WHERE owner_key=?1)",[owner],|r|r.get(0)).map_err(io_error)?;
            if dirty {
                result.push(id.clone());
            }
        }
        Ok(result)
    }
    pub(crate) fn agent_knowledge_candidates(
        &self,
        scope: &Scope,
        query: &str,
        kinds: &[KnowledgeKind],
        after_id: Option<&str>,
        limit: u16,
    ) -> AgentResult<Vec<KnowledgeNode>> {
        self.knowledge_scope(scope)?;
        if !(1..=50).contains(&limit) || query.chars().count() > 2000 || kinds.len() > 3 {
            return Err(invalid("Invalid knowledge search page"));
        }
        if let Some(id) = after_id {
            validate_id(id)?;
        }
        let kinds_json = encode(&kinds)?;
        let query = query.trim();
        let search = if query.is_empty() {
            ""
        } else if query.chars().count() < 3 {
            " AND n.node_id IN (SELECT node_id FROM agent_knowledge_fts WHERE scope_key=?1 AND (title LIKE ?5 ESCAPE '\\' OR aliases LIKE ?5 ESCAPE '\\' OR keywords LIKE ?5 ESCAPE '\\' OR one_line LIKE ?5 ESCAPE '\\'))"
        } else {
            " AND n.node_id IN (SELECT node_id FROM agent_knowledge_fts WHERE scope_key=?1 AND agent_knowledge_fts MATCH ?5)"
        };
        let sql=format!("SELECT v.snapshot_json FROM agent_knowledge_nodes n JOIN agent_knowledge_versions v ON v.scope_key=n.scope_key AND v.node_id=n.node_id AND v.revision=n.current_revision WHERE n.scope_key=?1 AND n.deleted=0 AND n.node_id>?2 AND (json_array_length(?3)=0 OR n.kind IN (SELECT value FROM json_each(?3))){search} ORDER BY n.node_id LIMIT ?4");
        let mut stmt = self.conn.prepare(&sql).map_err(io_error)?;
        let filter = if query.chars().count() < 3 {
            format!(
                "%{}%",
                query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        } else {
            format!("\"{}\"", query.replace('"', "\"\""))
        };
        let row = |r: &rusqlite::Row<'_>| r.get::<_, String>(0);
        let texts = if query.is_empty() {
            stmt.query_map(
                params![scope.key(), after_id.unwrap_or(""), kinds_json, limit],
                row,
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?
        } else {
            stmt.query_map(
                params![
                    scope.key(),
                    after_id.unwrap_or(""),
                    kinds_json,
                    limit,
                    filter
                ],
                row,
            )
            .map_err(io_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(io_error)?
        };
        texts.iter().map(|s| decode(s)).collect()
    }
    pub(crate) fn agent_knowledge_publish_in_transaction(
        &self,
        workspace_id: &str,
        scope: &Scope,
        overview_revision: u64,
        target_seq: u64,
        upserts: &[KnowledgeNodeWrite],
        removes: &[String],
    ) -> AgentResult<()> {
        if self.conn.is_autocommit() {
            return Err(AgentError::new(
                ErrorCode::IoFailed,
                "Knowledge publication requires the Overview transaction",
            ));
        }
        scope.validate()?;
        self.source_live_scope(scope)?;
        validate_knowledge_batch(scope, upserts, removes)?;
        if overview_revision == 0
            || overview_revision > i64::MAX as u64
            || target_seq > self.committed_change_watermark()? as u64
        {
            return Err(invalid("Invalid knowledge publication baseline"));
        }
        // Validate the complete candidate set before changing any current pointers.
        for node in upserts {
            let current:i64=self.conn.query_row("SELECT current_revision FROM agent_knowledge_nodes WHERE scope_key=?1 AND node_id=?2",params![scope.key(),node.node_id],|r|r.get(0)).optional().map_err(io_error)?.unwrap_or(0);
            if current as u64 != node.expected_revision {
                return Err(AgentError::new(
                    ErrorCode::RevisionConflict,
                    "Knowledge node changed",
                ));
            }
            if node
                .source_refs
                .iter()
                .any(|s| s.object.workspace_id != workspace_id)
            {
                return Err(AgentError::new(
                    ErrorCode::ScopeDenied,
                    "Knowledge source belongs to another Workspace",
                ));
            }
            for edge in &node.related {
                let candidate = upserts.iter().any(|target| {
                    target.node_id == edge.node_id && target.expected_revision + 1 == edge.revision
                });
                let existing:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_knowledge_versions WHERE scope_key=?1 AND node_id=?2 AND revision=?3)",params![scope.key(),edge.node_id,edge.revision as i64],|r|r.get(0)).map_err(io_error)?;
                if !candidate && !existing {
                    return Err(invalid(
                        "Related knowledge version does not exist in this scope",
                    ));
                }
            }
        }
        for id in removes {
            let active:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM agent_knowledge_nodes WHERE scope_key=?1 AND node_id=?2 AND deleted=0)",params![scope.key(),id],|r|r.get(0)).map_err(io_error)?;
            if !active {
                return Err(AgentError::new(
                    ErrorCode::NotFound,
                    "Knowledge node not found",
                ));
            }
        }
        let now = Utc::now().to_rfc3339();
        for id in upserts.iter().map(|n| &n.node_id).chain(removes) {
            let owner = format!("{}/{}/knowledge/{}", workspace_id, scope.key(), id);
            self.conn.execute("DELETE FROM content_reference_edges WHERE source_object_key=?1 AND relation='derived_from'",[&owner]).map_err(io_error)?;
            self.conn
                .execute(
                    "DELETE FROM source_dependency_invalidations WHERE owner_key=?1 AND seq<=?2",
                    params![owner, target_seq as i64],
                )
                .map_err(io_error)?;
            self.conn
                .execute(
                    "DELETE FROM agent_knowledge_fts WHERE scope_key=?1 AND node_id=?2",
                    params![scope.key(), id],
                )
                .map_err(io_error)?;
        }
        for node in upserts {
            let saved = node.snapshot(scope, now.clone());
            let kind = kind_key(node.kind)?;
            self.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![scope.key(),node.node_id,saved.revision as i64,overview_revision as i64,encode(&saved)?,now]).map_err(io_error)?;
            self.conn.execute("INSERT INTO agent_knowledge_nodes(scope_key,node_id,current_revision,kind,deleted,updated_at) VALUES(?1,?2,?3,?4,0,?5) ON CONFLICT(scope_key,node_id) DO UPDATE SET current_revision=excluded.current_revision,kind=excluded.kind,deleted=0,updated_at=excluded.updated_at",params![scope.key(),node.node_id,saved.revision as i64,kind,now]).map_err(io_error)?;
            self.conn.execute("INSERT INTO agent_knowledge_fts(scope_key,node_id,title,aliases,keywords,one_line) VALUES(?1,?2,?3,?4,?5,?6)",params![scope.key(),node.node_id,node.title,node.aliases.join("\n"),node.keywords.join("\n"),node.one_line]).map_err(io_error)?;
            for (ordinal, source) in node.source_refs.iter().enumerate() {
                let owner = format!(
                    "{}/{}/knowledge/{}",
                    workspace_id,
                    scope.key(),
                    node.node_id
                );
                self.conn.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES(?1,?2,'derived_from',?3,?4)",params![owner,source.object.key()?,encode(&source.locator)?,source.revision]).map_err(io_error)?;
                let evidence_owner = format!(
                    "{}/{}/knowledge/{}/{}",
                    workspace_id,
                    scope.key(),
                    node.node_id,
                    saved.revision
                );
                self.conn.execute("INSERT INTO agent_evidence(id,owner_kind,owner_id,source_ref_json,excerpt) VALUES(?1,'overview',?2,?3,?4)",params![format!("{evidence_owner}/{ordinal}"),evidence_owner,encode(source)?,source.excerpt]).map_err(io_error)?;
            }
            for parent in &node.published_sources {
                self.conn.execute("INSERT OR IGNORE INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json,target_revision) VALUES(?1,?2,'derived_from','{}',?3)",
                    params![format!("{}/{}/knowledge/{}",workspace_id,scope.key(),node.node_id),
                    format!("{}/project:{}/overview/{}",workspace_id,parent.project_id,parent.item_id),parent.digest]).map_err(io_error)?;
            }
        }
        for id in removes {
            self.conn.execute("UPDATE agent_knowledge_nodes SET deleted=1,updated_at=?3 WHERE scope_key=?1 AND node_id=?2",params![scope.key(),id,now]).map_err(io_error)?;
        }
        // These config keys do not qualify as canonical source registry events.
        for id in upserts.iter().map(|n| &n.node_id).chain(removes) {
            self.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,'knowledge.publish',?3,?4)",params![format!("knowledge/{}/{}",scope.key(),id),scope.key(),overview_revision.to_string(),now]).map_err(io_error)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            context::{EpistemicStatus, SourceCoverage},
            models::{ObjectKind, ObjectRef, SourceRef},
            overview::OverviewPublishInput,
        },
        models::ProjectCreateInput,
    };
    fn setup() -> (tempfile::TempDir, Database, Scope) {
        let root = tempfile::tempdir().unwrap();
        let db =
            Database::open(&root.path().join("knowledge.sqlite"), root.path(), None).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "Knowledge".into(),
                summary: Some("user authority".into()),
                status: None,
            })
            .unwrap();
        (
            root,
            db,
            Scope::Project {
                project_id: project.id,
            },
        )
    }
    fn coverage() -> SourceCoverage {
        SourceCoverage {
            processed: 0,
            partial: 1,
            excluded: 0,
            unsupported: 0,
            pending: 0,
        }
    }
    fn node(id: &str) -> KnowledgeNodeWrite {
        KnowledgeNodeWrite {
            node_id: id.into(),
            expected_revision: 0,
            kind: KnowledgeKind::Topic,
            title: "Cloud database design".into(),
            one_line: "云存储选择".into(),
            summary: "Compare available database options".into(),
            body_sections: vec![KnowledgeBodySection {
                id: "tradeoffs".into(),
                title: "Tradeoffs".into(),
                text: "Durability and portability".into(),
            }],
            aliases: vec!["持久知识".into(), "persistent knowledge".into()],
            keywords: vec!["中文检索".into()],
            source_refs: vec![],
            published_sources: vec![],
            epistemic_status: EpistemicStatus::Inferred,
            coverage: coverage(),
            related: vec![],
            session_summary: None,
        }
    }
    fn input(db: &Database, scope: &Scope, revision: u64) -> OverviewPublishInput {
        OverviewPublishInput {
            scope: scope.clone(),
            batch_id: format!("batch-{revision}"),
            expected_revision: revision,
            target_seq: db.committed_change_watermark().unwrap() as u64,
            policy_revision: 0,
            correction_revision: 0,
            upsert_items: vec![],
            remove_item_ids: vec![],
            settled_object_keys: vec![],
            knowledge_upserts: vec![],
            knowledge_removes: vec![],
            coverage: coverage(),
            source_manifest_hash: "manifest".into(),
            model_profile_id: "profile".into(),
        }
    }
    fn publish(
        db: &Database,
        request: &str,
        p: &OverviewPublishInput,
    ) -> AgentResult<crate::agent::context::AiOverview> {
        db.agent_overview_publish("gui", request, "w", p, |_, _| Ok(()))
    }
    #[test]
    fn knowledge_reopen_versions_and_raw_authority_remain_independent() {
        let (root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        p.knowledge_upserts = vec![node("database")];
        publish(&db, "one", &p).unwrap();
        let original = db
            .agent_knowledge_get(&scope, "database", None)
            .unwrap()
            .unwrap();
        p = input(&db, &scope, 1);
        p.knowledge_upserts = vec![node("database")];
        p.knowledge_upserts[0].expected_revision = 1;
        p.knowledge_upserts[0].summary = "new summary".into();
        publish(&db, "two", &p).unwrap();
        drop(db);
        let db = Database::open(&root.path().join("knowledge.sqlite"), root.path(), None).unwrap();
        assert_eq!(
            db.agent_knowledge_get(&scope, "database", None)
                .unwrap()
                .unwrap()
                .revision,
            2
        );
        assert_eq!(
            db.agent_knowledge_get(&scope, "database", Some(1))
                .unwrap()
                .unwrap()
                .summary,
            original.summary
        );
        let summary: Option<String> = db
            .conn
            .query_row(
                "SELECT summary FROM projects WHERE id=?1",
                [match scope {
                    Scope::Project { project_id } => project_id,
                    _ => unreachable!(),
                }],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(summary.as_deref(), Some("user authority"));
        assert_eq!(
            db.conn
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            super::super::CURRENT_SCHEMA_VERSION
        );
    }
    #[test]
    fn knowledge_search_trigram_alias_short_chinese_and_literal_like() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        let mut n = node("database");
        n.aliases.push("100%_safe".into());
        p.knowledge_upserts = vec![n];
        publish(&db, "one", &p).unwrap();
        for query in [
            "持久知识",
            "persistent knowledge",
            "中文检索",
            "云",
            "存储",
            "%_",
        ] {
            assert_eq!(
                db.agent_knowledge_candidates(&scope, query, &[], None, 50)
                    .unwrap()
                    .len(),
                1,
                "query={query}"
            );
        }
        assert!(db
            .agent_knowledge_candidates(&scope, "持久知识", &[KnowledgeKind::Decision], None, 50)
            .unwrap()
            .is_empty());
        assert!(db
            .agent_knowledge_candidates(&scope, "持久知识", &[], Some("database"), 50)
            .unwrap()
            .is_empty());
        assert_eq!(
            db.agent_knowledge_candidates(&scope, "", &[], None, 1)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.agent_knowledge_candidates(&scope, "", &[], None, 51)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    #[test]
    fn knowledge_cas_and_receipt_failure_roll_back_overview_node_and_index() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        p.knowledge_upserts = vec![node("database")];
        publish(&db, "one", &p).unwrap();
        p = input(&db, &scope, 1);
        p.knowledge_upserts = vec![node("database")];
        assert_eq!(
            publish(&db, "stale", &p).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        p.knowledge_upserts[0].expected_revision = 1;
        p.knowledge_upserts[0].title = "new unrelated replacement".into();
        db.conn.execute_batch("CREATE TEMP TRIGGER fail_knowledge_receipt BEFORE INSERT ON agent_operation_receipts BEGIN SELECT RAISE(ABORT,'injected knowledge receipt'); END").unwrap();
        assert_eq!(
            publish(&db, "failed", &p).unwrap_err().code,
            ErrorCode::IoFailed
        );
        assert_eq!(db.agent_overview_head(&scope).unwrap().unwrap().revision, 1);
        assert_eq!(
            db.agent_knowledge_get(&scope, "database", None)
                .unwrap()
                .unwrap()
                .revision,
            1
        );
        assert_eq!(
            db.agent_knowledge_candidates(&scope, "Cloud database", &[], None, 50)
                .unwrap()
                .len(),
            1
        );
        assert!(db
            .agent_knowledge_get(&scope, "database", Some(2))
            .unwrap()
            .is_none());
    }
    #[test]
    fn knowledge_delete_hides_current_index_but_retains_history_and_unchanged_nodes() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        p.knowledge_upserts = vec![node("a"), node("b")];
        publish(&db, "one", &p).unwrap();
        let retained = db.agent_knowledge_get(&scope, "b", None).unwrap().unwrap();
        p = input(&db, &scope, 1);
        p.knowledge_removes = vec!["a".into()];
        publish(&db, "delete", &p).unwrap();
        assert!(db.agent_knowledge_get(&scope, "a", None).unwrap().is_none());
        assert!(db
            .agent_knowledge_get(&scope, "a", Some(1))
            .unwrap()
            .is_some());
        let nodes = db
            .agent_knowledge_candidates(&scope, "持久知识", &[], None, 50)
            .unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].node_id, "b");
        assert_eq!(nodes[0].updated_at, retained.updated_at);
        p = input(&db, &scope, 2);
        p.knowledge_upserts = vec![node("a")];
        p.knowledge_upserts[0].expected_revision = 1;
        publish(&db, "restore", &p).unwrap();
        assert_eq!(
            db.agent_knowledge_get(&scope, "a", None)
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }
    #[test]
    fn knowledge_related_is_versioned_navigation_not_source_confirmation() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        let mut a = node("a");
        a.related = vec![KnowledgeRelated {
            node_id: "b".into(),
            revision: 1,
            relation: KnowledgeRelation::Supports,
            reason: "Compare alternatives".into(),
        }];
        p.knowledge_upserts = vec![a.clone(), node("b")];
        publish(&db, "one", &p).unwrap();
        p = input(&db, &scope, 1);
        a.expected_revision = 1;
        a.related[0].revision = 99;
        p.knowledge_upserts = vec![a.clone()];
        assert_eq!(
            publish(&db, "missing", &p).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        a.related[0].revision = 1;
        a.epistemic_status = EpistemicStatus::Recorded;
        p.knowledge_upserts = vec![a];
        assert_eq!(
            publish(&db, "fake-recorded", &p).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(db.agent_overview_head(&scope).unwrap().unwrap().revision, 1);
    }
    #[test]
    fn knowledge_source_summary_requires_one_source_and_budget_limits_hold() {
        let (_root, db, scope) = setup();
        let mut p = input(&db, &scope, 0);
        let mut n = node("summary");
        n.kind = KnowledgeKind::SourceSummary;
        p.knowledge_upserts = vec![n];
        assert!(publish(&db, "unsupported-summary", &p).is_err());
        let mut n = node("large");
        n.body_sections[0].text = "界".repeat(8001);
        p.knowledge_upserts = vec![n];
        assert_eq!(
            publish(&db, "budget", &p).unwrap_err().code,
            ErrorCode::BudgetExceeded
        );
        let mut n = node("confirmed");
        n.epistemic_status = EpistemicStatus::UserConfirmed;
        p.knowledge_upserts = vec![n];
        assert!(publish(&db, "confirmed", &p).is_err());
        assert!(db.agent_overview_head(&scope).unwrap().is_none());
    }
    #[test]
    fn knowledge_requires_owner_transaction_and_real_event_dirties_original_source_index() {
        let (_root, db, scope) = setup();
        db.agent_knowledge_prepare().unwrap();
        assert_eq!(
            db.agent_knowledge_publish_in_transaction("w", &scope, 1, 0, &[], &[])
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
        let mut p = input(&db, &scope, 0);
        let mut n = node("database");
        let object = ObjectRef {
            workspace_id: "w".into(),
            scope: scope.clone(),
            kind: ObjectKind::Project,
            id: match scope {
                Scope::Project { project_id } => project_id.to_string(),
                _ => unreachable!(),
            },
        };
        n.source_refs = vec![SourceRef {
            object: object.clone(),
            revision: "sha256:source".into(),
            file_version: None,
            record_version: None,
            block_id: None,
            locator: None,
            title: "Project".into(),
            excerpt: "original evidence".into(),
        }];
        p.knowledge_upserts = vec![n];
        publish(&db, "one", &p).unwrap();
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES(?1,?2,'project.update','changed','now')",params![object.key().unwrap(),scope.key()]).unwrap();
        assert_eq!(
            db.agent_knowledge_stale_ids("w", &scope, &["database".into()])
                .unwrap(),
            vec!["database"]
        );
        assert_eq!(db.conn.query_row("SELECT count(*) FROM agent_evidence WHERE owner_kind='overview' AND owner_id=?1",[format!("w/{}/knowledge/database/1",scope.key())],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            db.agent_knowledge_get(&scope, "database", Some(1))
                .unwrap()
                .unwrap()
                .source_refs[0]
                .excerpt,
            "original evidence"
        );
    }
}
