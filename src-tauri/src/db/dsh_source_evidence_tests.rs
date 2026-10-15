use super::*;
use crate::{agent::models::SourceLocator, models::ProjectCreateInput};
use std::{fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    db: Database,
    binding: WorkspaceBinding,
    project: i64,
    path: PathBuf,
    source: SourceRef,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
    db.bind_native_workspace("dsh-evidence").unwrap();
    let project = db
        .project_create(ProjectCreateInput {
            name: "Evidence".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let path = PathBuf::from(project.root_path);
    fs::write(path.join("source.txt"), b"actual delivered source").unwrap();
    let file = db
        .project_file_register("dsh-evidence", project.id, "source.txt")
        .unwrap();
    Fixture {
        _root: root,
        db,
        project: project.id,
        path,
        binding: WorkspaceBinding {
            workspace_id: "dsh-evidence".into(),
            generation: "opened".into(),
        },
        source: SourceRef {
            object: file.object,
            revision: file.content_hash.unwrap(),
            file_version: Some(file.version_number),
            record_version: None,
            block_id: None,
            locator: Some(SourceLocator::Paragraph { start: 1, end: 1 }),
            title: "source.txt".into(),
            excerpt: "actual delivered source".into(),
        },
    }
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn deliver(f: &Fixture, refs: &[SourceRef]) -> AgentResult<()> {
    f.db.dsh_record_source_evidence(
        &f.binding,
        f.project,
        "actual/session",
        "read:actual-call",
        &digest("final envelope and actual delivered source"),
        refs,
    )
}
fn count(db: &Database, table: &str) -> i64 {
    db.conn
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn empty(f: &Fixture) {
    assert_eq!(count(&f.db, "agent_evidence"), 0);
    assert_eq!(count(&f.db, "content_reference_edges"), 0);
}

#[test]
fn dsh_evidence_success_is_fixed_idempotent_and_uses_no_fake_sessions() {
    let f = fixture();
    fs::write(
        f.path.join("source.txt"),
        b"new live content must never be read",
    )
    .unwrap();
    let current = f.db.project_file_resolve(&f.source.object).unwrap();
    assert_eq!(current.version_number, 2);
    deliver(&f, &[f.source.clone()]).unwrap();
    deliver(&f, &[f.source.clone()]).unwrap();
    assert_eq!(count(&f.db, "agent_evidence"), 1);
    assert_eq!(count(&f.db, "content_reference_edges"), 1);
    assert_eq!(count(&f.db, "agent_sessions"), 0);
    assert_eq!(count(&f.db, "agent_messages"), 0);
    let (owner_kind, source_json): (String, String) =
        f.db.conn
            .query_row(
                "SELECT owner_kind,source_ref_json FROM agent_evidence",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
    assert_eq!(owner_kind, "message");
    // The historical version and revision remain discoverable directly from
    // evidence without joining a fabricated Pi message.
    let saved: SourceRef = serde_json::from_str(&source_json).unwrap();
    assert_eq!(saved.file_version, Some(1));
    assert_eq!(saved.revision, f.source.revision);
    let (locator, revision): (String, String) = f.db.conn.query_row("SELECT locator_json,target_revision FROM content_reference_edges WHERE relation='evidence'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let locator: serde_json::Value = serde_json::from_str(&locator).unwrap();
    assert_eq!(locator["sessionId"], "actual/session");
    assert_eq!(locator["deliveryId"], "read:actual-call");
    assert_eq!(
        locator["projectionHash"],
        digest("final envelope and actual delivered source")
    );
    assert_eq!(locator["sourceRef"]["fileVersion"], 1);
    assert_eq!(revision, f.source.revision);
    let reopened = WorkspaceBinding {
        generation: "reopened".into(),
        ..f.binding.clone()
    };
    f.db.dsh_record_source_evidence(
        &reopened,
        f.project,
        "actual/session",
        "read:actual-call",
        &digest("final envelope and actual delivered source"),
        &[f.source.clone()],
    )
    .unwrap();
    assert_eq!(count(&f.db, "agent_evidence"), 1);
}

#[test]
fn dsh_evidence_rejects_cross_scope_and_forged_actual_file_owner() {
    let f = fixture();
    let other =
        f.db.project_create(ProjectCreateInput {
            name: "Other".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let mut source = f.source.clone();
    source.object.workspace_id = "foreign".into();
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    source = f.source.clone();
    source.object.scope = Scope::Project {
        project_id: other.id,
    };
    assert_eq!(
        deliver(&f, &[source.clone()]).unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    // Claimed scope matches context but the native File belongs to the first Project.
    assert_eq!(
        f.db.dsh_record_source_evidence(
            &f.binding,
            other.id,
            "s",
            "read:c",
            &digest("projection"),
            &[source]
        )
        .unwrap_err()
        .code,
        ErrorCode::ScopeDenied
    );
    let foreign = WorkspaceBinding {
        workspace_id: "foreign".into(),
        ..f.binding.clone()
    };
    assert_eq!(
        f.db.dsh_record_source_evidence(
            &foreign,
            f.project,
            "s",
            "read:c",
            &digest("projection"),
            &[f.source.clone()]
        )
        .unwrap_err()
        .code,
        ErrorCode::WorkspaceChanged
    );
    empty(&f);
}

#[test]
fn dsh_evidence_rejects_missing_versions_wrong_hash_and_tampered_snapshot() {
    let f = fixture();
    let mut source = f.source.clone();
    source.file_version = Some(999);
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::SourceNotReady
    );
    source = f.source.clone();
    source.revision = format!("sha256:{}", digest("wrong"));
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    source = f.source.clone();
    source.file_version = None;
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let path: String = f
        .db
        .conn
        .query_row(
            "SELECT managed_path FROM document_versions WHERE document_id=?1 AND version_number=1",
            [&f.source.object.id],
            |r| r.get(0),
        )
        .unwrap();
    fs::write(f.db.decode_path_ref(&path), b"tampered retained bytes").unwrap();
    assert_eq!(
        deliver(&f, &[f.source.clone()]).unwrap_err().code,
        ErrorCode::SourceChanged
    );
    empty(&f);
}

#[test]
fn dsh_evidence_same_delivery_rejects_payload_or_persisted_edge_tampering() {
    let f = fixture();
    deliver(&f, &[f.source.clone()]).unwrap();
    let different = digest("different final projection");
    assert_eq!(
        f.db.dsh_record_source_evidence(
            &f.binding,
            f.project,
            "actual/session",
            "read:actual-call",
            &different,
            &[f.source.clone()]
        )
        .unwrap_err()
        .code,
        ErrorCode::IdempotencyConflict
    );
    let mut source = f.source.clone();
    source.excerpt = "different projection excerpt".into();
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    let mut source = f.source.clone();
    source.revision = format!("sha256:{}", digest("different retained version"));
    assert_eq!(
        deliver(&f, &[source]).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    f.db.conn
        .execute("UPDATE agent_evidence SET excerpt='tampered excerpt'", [])
        .unwrap();
    assert_eq!(
        deliver(&f, &[f.source.clone()]).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    f.db.conn
        .execute("UPDATE agent_evidence SET excerpt=?1", [&f.source.excerpt])
        .unwrap();
    f.db.conn
        .execute(
            "UPDATE content_reference_edges SET target_revision='tampered'",
            [],
        )
        .unwrap();
    assert_eq!(
        deliver(&f, &[f.source.clone()]).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    assert_eq!(count(&f.db, "agent_evidence"), 1);
    assert_eq!(count(&f.db, "content_reference_edges"), 1);
}

#[test]
fn dsh_evidence_atomic_failure_rolls_back_evidence_and_all_edges() {
    let f = fixture();
    fs::write(f.path.join("second.txt"), b"second").unwrap();
    let second =
        f.db.project_file_register("dsh-evidence", f.project, "second.txt")
            .unwrap();
    let source = SourceRef {
        object: second.object,
        revision: second.content_hash.unwrap(),
        title: "second.txt".into(),
        ..f.source.clone()
    };
    let mut invalid = source.clone();
    invalid.file_version = Some(999);
    assert!(deliver(&f, &[f.source.clone(), invalid]).is_err());
    empty(&f);
    f.db.conn.execute_batch("CREATE TEMP TRIGGER reject_second_dsh_edge BEFORE INSERT ON content_reference_edges WHEN EXISTS(SELECT 1 FROM content_reference_edges) BEGIN SELECT RAISE(ABORT,'edge failure'); END;").unwrap();
    assert_eq!(
        deliver(&f, &[f.source.clone(), source.clone()])
            .unwrap_err()
            .code,
        ErrorCode::IoFailed
    );
    empty(&f);
    f.db.conn
        .execute_batch("DROP TRIGGER reject_second_dsh_edge")
        .unwrap();
    deliver(&f, &[f.source.clone(), source]).unwrap();
    assert_eq!(count(&f.db, "agent_evidence"), 2);
    assert_eq!(count(&f.db, "content_reference_edges"), 2);
}

#[test]
fn dsh_evidence_delivery_namespace_and_input_boundaries() {
    let f = fixture();
    for (session, delivery) in [("a/b", "c"), ("a", "b/c"), ("a/b", "d")] {
        f.db.dsh_record_source_evidence(
            &f.binding,
            f.project,
            session,
            delivery,
            &digest("projection"),
            &[f.source.clone()],
        )
        .unwrap();
    }
    assert_eq!(count(&f.db, "agent_evidence"), 3);
    assert_eq!(count(&f.db, "content_reference_edges"), 3);
    for (session, delivery, hash) in [
        ("", "read:c", digest("projection")),
        ("s", "\n", digest("projection")),
        ("s", "read:c", "0".repeat(63)),
        ("s", "read:c", "A".repeat(64)),
        ("s", "d".repeat(513).as_str(), digest("projection")),
    ] {
        assert_eq!(
            f.db.dsh_record_source_evidence(
                &f.binding,
                f.project,
                session,
                delivery,
                &hash,
                &[f.source.clone()]
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(
        deliver(&f, &[]).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        deliver(&f, &vec![f.source.clone(); 129]).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(count(&f.db, "agent_evidence"), 3);
}

#[test]
fn dsh_evidence_multiple_refs_preserve_order_and_duplicate_occurrences() {
    let f = fixture();
    let mut refs = vec![f.source.clone(); 12];
    for (index, source) in refs.iter_mut().enumerate() {
        source.excerpt = format!("delivered occurrence {index}");
    }
    deliver(&f, &refs).unwrap();
    deliver(&f, &refs).unwrap();
    assert_eq!(count(&f.db, "agent_evidence"), 12);
    assert_eq!(count(&f.db, "content_reference_edges"), 12);
    refs.swap(0, 1);
    assert_eq!(
        deliver(&f, &refs).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    refs.swap(0, 1);
    refs.pop();
    assert_eq!(
        deliver(&f, &refs).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
}

#[test]
fn dsh_evidence_reopen_replay_returns_original_success_without_rereading_bytes() {
    let f = fixture();
    deliver(&f, &[f.source.clone()]).unwrap();
    let path: String = f
        .db
        .conn
        .query_row(
            "SELECT managed_path FROM document_versions WHERE document_id=?1 AND version_number=1",
            [&f.source.object.id],
            |r| r.get(0),
        )
        .unwrap();
    fs::remove_file(f.db.decode_path_ref(&path)).unwrap();
    let mut reopened =
        Database::open(&f._root.path().join("test.sqlite"), f._root.path(), None).unwrap();
    reopened
        .bind_native_workspace(&f.binding.workspace_id)
        .unwrap();
    reopened
        .dsh_record_source_evidence(
            &WorkspaceBinding {
                generation: "reopened".into(),
                ..f.binding.clone()
            },
            f.project,
            "actual/session",
            "read:actual-call",
            &digest("final envelope and actual delivered source"),
            &[f.source.clone()],
        )
        .unwrap();
    assert_eq!(count(&reopened, "agent_evidence"), 1);
    assert_eq!(count(&reopened, "content_reference_edges"), 1);
    // An unproved new delivery still has to read the retained snapshot.
    assert_eq!(
        reopened
            .dsh_record_source_evidence(
                &f.binding,
                f.project,
                "actual/session",
                "read:new-call",
                &digest("projection"),
                &[f.source.clone()],
            )
            .unwrap_err()
            .code,
        ErrorCode::SourceNotReady
    );
}

#[test]
fn dsh_evidence_enforces_character_and_combined_utf8_byte_budgets() {
    let f = fixture();
    for (title, excerpt) in [
        ("t".repeat(1001), String::new()),
        (String::new(), "e".repeat(2001)),
    ] {
        let source = SourceRef {
            title,
            excerpt,
            ..f.source.clone()
        };
        assert_eq!(
            deliver(&f, &[source]).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
    let source = SourceRef {
        title: "字".repeat(1000),
        excerpt: "字".repeat(2000),
        ..f.source.clone()
    };
    assert_eq!(
        deliver(&f, &vec![source; 128]).unwrap_err().code,
        ErrorCode::BudgetExceeded
    );
    empty(&f);
    let source = SourceRef {
        title: "t".repeat(1000),
        excerpt: "e".repeat(2000),
        ..f.source.clone()
    };
    deliver(&f, &[source]).unwrap();
}

#[test]
fn dsh_evidence_namespace_protects_versions_and_owner_cleanup_never_deletes_file() {
    let mut f = fixture();
    fs::write(f.path.join("source.txt"), b"new live version").unwrap();
    f.db.project_file_resolve(&f.source.object).unwrap();
    deliver(&f, &[f.source.clone()]).unwrap();
    let owner: String =
        f.db.conn
            .query_row("SELECT owner_id FROM agent_evidence", [], |r| r.get(0))
            .unwrap();
    assert!(owner.starts_with(&format!("dsh-evidence/project:{}/dsh_delivery/", f.project)));
    let edge_owner: String =
        f.db.conn
            .query_row(
                "SELECT source_object_key FROM content_reference_edges",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(edge_owner, owner);
    let error =
        f.db.document_delete(crate::models::DocumentDeleteInput {
            document_id: f.source.object.id.parse().unwrap(),
        })
        .unwrap_err();
    assert!(error.to_string().contains("fixed content references"));
    // A caller removing a DSH Session's evidence can remove these owners/edges
    // explicitly; neither table has a cascade into the target business File.
    f.db.conn
        .execute(
            "DELETE FROM agent_evidence WHERE owner_kind='message' AND owner_id=?1",
            [&owner],
        )
        .unwrap();
    f.db.conn.execute("DELETE FROM content_reference_edges WHERE source_object_key=?1 AND relation='evidence'", [&owner]).unwrap();
    empty(&f);
    let bytes =
        f.db.project_file_read_bytes(&FileBytesInput {
            object: f.source.object.clone(),
            version_number: 1,
            expected_content_hash: f.source.revision.clone(),
        })
        .unwrap();
    assert_eq!(bytes.byte_length, b"actual delivered source".len());
    assert_eq!(
        fs::read(f.path.join("source.txt")).unwrap(),
        b"new live version"
    );
    assert_eq!(count(&f.db, "documents"), 1);
    assert_eq!(count(&f.db, "document_versions"), 2);
}
