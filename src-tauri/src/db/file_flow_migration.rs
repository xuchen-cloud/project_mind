//! Unified migration for the owner-move, drop-intent and version-metadata package.
use super::Database;

impl Database {
    pub(super) fn migrate_file_flow_package(&mut self) -> anyhow::Result<()> {
        // Each extension is idempotent; do not advance user_version until all
        // have succeeded. Runtime Host connections never run these DDL paths.
        self.ensure_file_flow_schema()?;
        self.ensure_file_version_metadata_schema()?;
        self.ensure_record_owner_moves_schema()?;
        self.directory_schema()?;
        self.set_schema_version(super::CURRENT_SCHEMA_VERSION)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::models::Scope;
    use crate::models::{DocumentImportInput, WorkspaceRecordUpsertInput};
    use crate::record_documents::{RecordDocumentProjection, RecordTarget};
    use std::fs;

    fn snapshot(db: &Database) -> Vec<String> {
        let mut query = db.conn.prepare("SELECT json_array(id,document_id,version_number,name,source_path,managed_path,created_at) FROM document_versions ORDER BY id").unwrap();
        let mut rows = query
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        let mut query = db.conn.prepare("SELECT json_array(id,record_key,version_number,document_snapshot,body_hash,created_at) FROM record_versions ORDER BY id").unwrap();
        rows.extend(
            query
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<String>>>()
                .unwrap(),
        );
        rows
    }

    fn strip_extensions(db: &mut Database) {
        db.conn
            .execute_batch(
                "DROP TRIGGER IF EXISTS important_version_retain;
            DROP TRIGGER IF EXISTS important_version_identity;
            DROP TRIGGER IF EXISTS important_version_replace;
            DROP TRIGGER IF EXISTS important_version_hash_retain;
            DROP TRIGGER IF EXISTS important_version_hash_replace;
            DROP TRIGGER IF EXISTS important_version_update_replace;
            DROP TRIGGER IF EXISTS record_version_owner_context_insert;
            DROP TRIGGER IF EXISTS record_owner_move_asset_project_delete;
            DROP TRIGGER IF EXISTS record_owner_move_asset_project_root;
            DROP TABLE IF EXISTS record_owner_move_assets;
            DROP TABLE IF EXISTS record_location_aliases;
            DROP TABLE IF EXISTS record_logical_identities;
            DROP TABLE IF EXISTS record_version_owner_context;
            DROP TABLE IF EXISTS file_owner_move_journals;
            DROP TABLE IF EXISTS file_owner_aliases;
            DROP TABLE IF EXISTS file_drop_intents;
            ALTER TABLE document_versions DROP COLUMN display_name;
            ALTER TABLE document_versions DROP COLUMN is_important;
            ALTER TABLE document_versions DROP COLUMN metadata_revision;
            PRAGMA user_version=40;",
            )
            .unwrap();
    }

    #[test]
    fn file_flow_migration_upgrades_published_history_and_runtime_connection() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let source = root.path().join("source.md");
        fs::write(&source, b"old published File bytes").unwrap();
        let file = db
            .document_import(DocumentImportInput {
                project_id: None,
                source_path: source.to_string_lossy().into(),
                is_starred: false,
                tag_ids: None,
            })
            .unwrap();
        let p: RecordDocumentProjection =
            serde_json::from_str(include_str!("../record_document_projection.fixture.json"))
                .unwrap();
        for name in ["assets/图片.png", "assets/文件.pdf"] {
            let target = root.path().join(name);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, b"old retained resource").unwrap();
        }
        let row = db
            .workspace_record_upsert(WorkspaceRecordUpsertInput {
                note_id: None,
                title: Some("published".into()),
                markdown: p.markdown.clone(),
                html: p.html.clone(),
                default_code_language: p.code_language.clone(),
                tag_ids: vec![],
            })
            .unwrap();
        let target = RecordTarget {
            scope: Scope::Workspace,
            record_id: row.id,
        };
        let old = db.record_document_source(&target).unwrap();
        db.record_document_initialize(
            "gui",
            "migration-fixture",
            &target,
            &old.source_hash,
            &p,
            "fixture",
        )
        .unwrap();
        let before = snapshot(&db);
        strip_extensions(&mut db);
        drop(db);
        let mut db = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(
            db.schema_version().unwrap(),
            super::super::CURRENT_SCHEMA_VERSION
        );
        assert_eq!(snapshot(&db), before);
        let version = db.fetch_document_versions(file.id).unwrap().remove(0);
        assert_eq!(version.display_name, None);
        assert!(!version.is_important);
        assert_eq!(version.metadata_revision, 0);
        assert_eq!(
            fs::read(version.managed_path).unwrap(),
            b"old published File bytes"
        );
        let mismatches: i64 = db.conn.query_row("SELECT count(*) FROM record_versions v LEFT JOIN record_version_owner_context c ON c.version_id=v.id WHERE c.original_record_key IS NOT v.record_key", [], |r| r.get(0)).unwrap();
        assert_eq!(mismatches, 0);
        let schema: i64 = db
            .conn
            .pragma_query_value(None, "schema_version", |r| r.get(0))
            .unwrap();
        db.migrate().unwrap();
        assert_eq!(
            db.conn
                .pragma_query_value(None, "schema_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            schema
        );
        drop(db);
        let runtime = Database::open_runtime_connection(&path, root.path(), None).unwrap();
        for table in [
            "file_drop_intents",
            "file_owner_aliases",
            "record_location_aliases",
            "record_version_owner_context",
        ] {
            assert!(runtime.table_exists(table).unwrap(), "missing {table}");
        }
        assert_eq!(snapshot(&runtime), before);
    }

    #[test]
    fn file_flow_migration_failure_does_not_publish_current_version_and_retries() {
        for published in [38, 39, 40] {
            let root = tempfile::tempdir().unwrap();
            let mut db =
                Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
            strip_extensions(&mut db);
            db.set_schema_version(published).unwrap();
            // A later extension fails after contacts/metadata extensions succeeded.
            db.conn
                .execute_batch("CREATE TABLE record_logical_identities(incompatible TEXT)")
                .unwrap();
            assert!(db.migrate().is_err());
            assert_eq!(db.schema_version().unwrap(), published);
            db.conn
                .execute_batch("DROP TABLE record_logical_identities")
                .unwrap();
            db.migrate().unwrap();
            assert_eq!(
                db.schema_version().unwrap(),
                super::super::CURRENT_SCHEMA_VERSION
            );
            assert!(db.table_exists("record_location_aliases").unwrap());
            assert!(db
                .has_column("document_versions", "metadata_revision")
                .unwrap());
        }
    }
}
