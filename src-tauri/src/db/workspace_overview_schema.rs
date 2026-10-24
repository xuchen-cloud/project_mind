use super::Database;

pub(super) const WORKSPACE_OVERVIEW_SCHEMA_VERSION: i64 = 36;

impl Database {
    pub(super) fn ensure_workspace_overview_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= WORKSPACE_OVERVIEW_SCHEMA_VERSION { return Ok(()); }
        self.conn.execute_batch("SAVEPOINT workspace_overview_schema")?;
        let result=(|| -> anyhow::Result<()> {
            // CREATE TRIGGER IF NOT EXISTS does not replace the Project-only
            // definition installed by schema 29.
            self.conn.execute_batch("DROP TRIGGER IF EXISTS agent_overview_pending_outbox")?;
            self.conn.execute_batch(include_str!("agent_overviews.sql"))?;
            let has_item_id=self.conn.prepare("PRAGMA table_info(agent_overview_inventory_cursors)")?
                .query_map([],|row|row.get::<_,String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|column|column=="item_id");
            if !has_item_id {self.conn.execute_batch("ALTER TABLE agent_overview_inventory_cursors ADD COLUMN item_id TEXT NOT NULL DEFAULT ''")?;}
            self.conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_overview_published_deferrals(
                object_key TEXT PRIMARY KEY,last_seq INTEGER NOT NULL,deferred_at INTEGER NOT NULL,error_code_json TEXT NOT NULL)")?;
            self.conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_overview_workspace_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1));
                INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) SELECT 'workspace',1
                WHERE NOT EXISTS(SELECT 1 FROM agent_overview_workspace_bootstrap)
                ON CONFLICT(scope_key) DO NOTHING;
                INSERT INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded)
                SELECT 'workspace',r.object_key,r.last_change_seq,r.last_change_seq,'bootstrap.inventory_required',r.event_revision,
                r.deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM source_access_policies p WHERE p.object_key=r.object_key AND p.excluded=1)
                FROM source_registry r WHERE r.scope_key='workspace'
                AND NOT EXISTS(SELECT 1 FROM agent_overview_workspace_bootstrap)
                ON CONFLICT(scope_key,object_key) DO NOTHING;
                INSERT OR IGNORE INTO agent_overview_workspace_bootstrap(id) VALUES(1);")?;
            self.set_schema_version(WORKSPACE_OVERVIEW_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE workspace_overview_schema")?;
            Ok(())
        })();
        if result.is_err() {self.conn.execute_batch("ROLLBACK TO workspace_overview_schema; RELEASE workspace_overview_schema")?;}
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_35_replaces_project_only_trigger_and_seeds_workspace_once() {
        let root=tempfile::tempdir().unwrap();
        let path=root.path().join("old.sqlite");
        let db=Database::open(&path,root.path(),None).unwrap();
        db.conn.execute_batch("DROP TRIGGER agent_overview_pending_outbox;
            CREATE TRIGGER agent_overview_pending_outbox AFTER INSERT ON agent_change_log
            WHEN NEW.scope_key LIKE 'project:%' BEGIN SELECT 1; END;
            DROP TABLE agent_overview_workspace_bootstrap;").unwrap();
        super::super::agent_memory_schema::remove_agent_memory_schema_fixture(&db);
        db.set_schema_version(35).unwrap();
        drop(db);
        let db=Database::open(&path,root.path(),None).unwrap();
        assert_eq!(db.schema_version().unwrap(),super::super::CURRENT_SCHEMA_VERSION);
        let trigger:String=db.conn.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='agent_overview_pending_outbox'",[],|r|r.get(0)).unwrap();
        assert!(trigger.contains("NEW.scope_key='workspace'"));
        assert_eq!(db.conn.query_row("SELECT needs_rebuild FROM agent_overview_pending_state WHERE scope_key='workspace'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        db.conn.execute("UPDATE agent_overview_pending_state SET needs_rebuild=0 WHERE scope_key='workspace'",[]).unwrap();
        drop(db);
        let db=Database::open(&path,root.path(),None).unwrap();
        assert_eq!(db.conn.query_row("SELECT needs_rebuild FROM agent_overview_pending_state WHERE scope_key='workspace'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let backups=root.path().join(crate::db::WORKSPACE_HIDDEN_DIR_NAME).join("backups");
        assert!(std::fs::read_dir(backups).unwrap().any(|entry|entry.unwrap().file_name()
            .to_string_lossy().contains(&format!("schema-35-to-{}", super::super::CURRENT_SCHEMA_VERSION))));
    }
}
