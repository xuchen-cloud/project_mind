use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn project_page_is_read_only_and_preserves_unregistered_files_in_other_projects() {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    db.conn.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES
        (1,'Active','workspace:active','now','now'),(2,'Unused','workspace:unused','now','now');
        INSERT INTO documents(id,project_id,name,base_name,original_path,managed_path,history_dir_path,storage_mode,mime_type,current_version_number,version_count,health,created_at,updated_at) VALUES
        (1,1,'missing.txt','missing.txt','workspace:active/missing.txt','workspace:active/missing.txt','','managed_copy','text/plain',1,1,'normal','now','now'),
        (2,2,'pending.txt','pending.txt','workspace:unused/pending.txt','workspace:unused/pending.txt','','project_directory','text/plain',0,0,'unavailable','now','now');
        INSERT INTO document_versions(document_id,version_number,name,source_path,managed_path,created_at)
        VALUES (1,1,'missing.txt','workspace:active/missing.txt','workspace:active/missing.txt','now');
        CREATE TABLE document_write_counter(count INTEGER NOT NULL);
        INSERT INTO document_write_counter VALUES (0);
        CREATE TRIGGER count_document_updates AFTER UPDATE ON documents
        BEGIN UPDATE document_write_counter SET count=count+1; END;").unwrap();
    db.conn.pragma_update(None, "query_only", true).unwrap();
    let page = db
        .project_page_get(ProjectIdInput { project_id: 1 })
        .unwrap();
    assert_eq!(page.project_documents.len(), 1);
    // Health is the last confirmed state, not a traversal performed by this read.
    assert_eq!(page.project_documents[0].health, "normal");
    assert_eq!(
        db.document_list_versions(DocumentListVersionsInput { document_id: 1 })
            .unwrap()
            .len(),
        1
    );
    assert_eq!(db.document_record(2).unwrap().current_version_number, 0);
    assert_eq!(db.document_record(2).unwrap().version_count, 0);
    assert_eq!(
        db.conn
            .query_row("SELECT count FROM document_write_counter", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.conn.pragma_update(None, "query_only", false).unwrap();
    let image = db
        .document_import_clipboard_note_image(DocumentImportClipboardNoteImageInput {
            project_id: 1,
            file_name: "inline.png".into(),
            mime_type: "image/png".into(),
            data_base64: STANDARD.encode(b"image"),
        })
        .unwrap();
    assert_eq!(image.base_name, "inline.png");
    assert_eq!((image.current_version_number, image.version_count), (1, 1));
    // Current imports establish their own metadata and never repair another
    // Project's legitimate, not-yet-registered directory File into fake v1.
    assert_eq!(
        (
            db.document_record(2).unwrap().current_version_number,
            db.document_record(2).unwrap().version_count
        ),
        (0, 0)
    );
}

#[test]
fn project_context_metadata_reads_identity_without_hydrating_project_content() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    // Missing directory and unreadable content tables are irrelevant to identity.
    db.conn
        .execute(
            "INSERT INTO projects(name,root_path,created_at,updated_at)
        VALUES ('Context only','workspace:missing-project','now','now')",
            [],
        )
        .unwrap();
    let id = db.conn.last_insert_rowid();
    db.conn
        .execute_batch(
            "DROP VIEW agent_visible_notes;
        DROP VIEW agent_visible_todos; DROP VIEW agent_visible_files;
        DROP TABLE notes; DROP TABLE todos; DROP TABLE documents;",
        )
        .unwrap();
    db.conn.pragma_update(None, "query_only", true).unwrap();
    assert_eq!(
        db.project_context_metadata(id).unwrap(),
        ("Context only".into(), root.path().join("missing-project"))
    );
    assert!(db.project_context_metadata(id + 1).is_err());
    assert!(!root.path().join("missing-project").exists());
}

#[test]
fn current_schema_preparation_is_bounded_and_read_only() {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    // Unrelated historical changes must not be walked on reopen.
    db.conn
        .execute_batch(
            "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
        INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at)
        SELECT 'settings:'||x,'workspace','settings.update','1','2026-10-28' FROM n;",
        )
        .unwrap();
    db.conn.pragma_update(None, "query_only", true).unwrap();

    unsafe extern "C" fn count_steps(context: *mut std::ffi::c_void) -> std::ffi::c_int {
        // The counter lives until the handler is removed below; SQLite invokes
        // this synchronously on this connection's thread.
        let steps = unsafe { &*(context.cast::<AtomicUsize>()) };
        steps.fetch_add(1, Ordering::Relaxed);
        0
    }
    let steps = AtomicUsize::new(0);
    unsafe {
        rusqlite::ffi::sqlite3_progress_handler(
            db.conn.handle(),
            1,
            Some(count_steps),
            (&steps as *const AtomicUsize).cast_mut().cast(),
        );
    }
    let result = db.migrate();
    unsafe {
        rusqlite::ffi::sqlite3_progress_handler(db.conn.handle(), 0, None, std::ptr::null_mut());
    }
    result.unwrap();
    assert!(
        steps.load(Ordering::Relaxed) < 30,
        "current schema preparation executed {} SQLite instructions",
        steps.load(Ordering::Relaxed)
    );
}

#[test]
fn failed_final_schema_step_keeps_current_version_unpublished_and_retryable() {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("app.sqlite"), root.path(), None).unwrap();
    // Simulate the actual previous schema and an index-name collision. No
    // current version may be published before all final schema work succeeds.
    db.conn
        .execute_batch(
            "DROP INDEX idx_contacts_email;
        CREATE TABLE idx_contacts_email(value TEXT);
        INSERT INTO idx_contacts_email VALUES ('preserve');
        PRAGMA user_version=37;",
        )
        .unwrap();
    assert!(db.migrate().is_err());
    assert_eq!(db.schema_version().unwrap(), 37);
    assert_eq!(
        db.conn
            .query_row("SELECT value FROM idx_contacts_email", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "preserve"
    );
    db.conn
        .execute_batch("DROP TABLE idx_contacts_email")
        .unwrap();
    db.migrate().unwrap();
    assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
}

#[test]
fn future_workspace_schema_is_rejected_without_writes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app.sqlite");
    let db = Database::open(&path, root.path(), None).unwrap();
    db.set_schema_version(CURRENT_SCHEMA_VERSION + 1).unwrap();
    let before = db
        .conn
        .pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))
        .unwrap();
    drop(db);
    assert!(Database::open(&path, root.path(), None).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        CURRENT_SCHEMA_VERSION + 1
    );
    assert_eq!(
        conn.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        before
    );
}
