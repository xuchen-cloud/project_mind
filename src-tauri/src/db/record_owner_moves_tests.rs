use super::*;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    },
    models::WorkspaceRecordUpsertInput,
};

#[test]
fn g13_old_locator_read_uses_actual_owner_grant() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Database::open(&dir.path().join("db.sqlite"), dir.path(), None).unwrap();
    db.conn.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES(1,'A','workspace:a','now','now'),(2,'B','workspace:b','now','now'); INSERT INTO notes(id,project_id,title,created_at,updated_at) VALUES(1,1,'record','now','now');").unwrap();
    db.ensure_record_owner_moves_schema().unwrap();
    let binding = WorkspaceBinding {
        workspace_id: "test".into(),
        generation: "open".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        request_id: "read-old".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: "test".into(),
            workspace_content: false,
            project_ids: vec![2],
            operations: vec!["source.read".into()],
            object_keys: None,
        },
    };
    let old = ObjectRef {
        workspace_id: "test".into(),
        scope: Scope::Project { project_id: 1 },
        kind: ObjectKind::Record,
        id: "1".into(),
    };
    // Existing physical-owner change illustrates the real old-locator authorization failure.
    db.conn
        .execute("UPDATE notes SET project_id=2 WHERE id=1", [])
        .unwrap();
    // The retained alias is native migration provenance, not a caller-supplied owner.
    db.conn.execute_batch("BEGIN; INSERT INTO record_document_heads(record_key,project_note_id,head_revision,document_json,html,markdown,text,body_hash,schema_version,updated_at) VALUES('project:1:1',1,1,'{}','','','','hash',1,'now'); PRAGMA defer_foreign_keys=ON; UPDATE record_document_heads SET record_key='project:2:1' WHERE record_key='project:1:1'; UPDATE record_versions SET record_key='project:2:1'; INSERT INTO record_logical_identities VALUES('11111111111111111111111111111111','project:2:1','project:2',1); INSERT INTO record_location_aliases VALUES('project:1:1','note',1,'11111111111111111111111111111111'); COMMIT;").unwrap();
    let resolved = db.source_read_object(&request, &binding, &old).unwrap();
    assert_eq!(resolved.scope, Scope::Project { project_id: 2 });
}

#[path = "record_owner_moves_matrix_tests.rs"]
mod matrix;
