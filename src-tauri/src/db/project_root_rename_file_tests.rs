//! WP03 / ARCH-03: imported File history stays at its original owner root.
//! Fixtures use native import/version/working-session/owner-move APIs; SQL is
//! read only, to compare the registered immutable hashes and historical rows.

use super::Database;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        models::{ObjectKind, ObjectRef, WorkspaceBinding},
    },
    db::{file_owner_move::FileOwnerMove, file_version_metadata::VersionMetadataUpdate},
    file_working::WorkingSession,
    models::{
        DocumentAddVersionInput, DocumentImportInput, DocumentListVersionsInput, DocumentRecord,
        ProjectCreateInput, ProjectUpdateInput,
    },
};
use std::{fs, path::Path};

struct Fixture {
    // Database drops before its temporary workspace.
    db: Database,
    root: tempfile::TempDir,
    _external: tempfile::TempDir,
    binding: WorkspaceBinding,
    request: RequestContext,
    a: i64,
    b: i64,
    file: DocumentRecord,
}

fn fixture(from_project: bool, version_count: i64) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let (meta, paths) = crate::workspace::create_workspace(root.path(), "password").unwrap();
    let mut db = Database::open(&paths.db_path, root.path(), None).unwrap();
    let mut projects = Vec::new();
    for name in ["A", "B"] {
        projects.push(
            db.project_create(ProjectCreateInput {
                name: name.into(),
                summary: None,
                status: None,
            })
            .unwrap()
            .id,
        );
    }
    db.bind_file_commit_fence(std::sync::Arc::new(
        crate::workspace_commit_fence::WorkspaceCommitFence::new(),
    ));
    let source_owner = from_project.then_some(projects[0]);
    let source = external.path().join("source.md");
    fs::write(&source, b"original immutable content").unwrap();
    let file = db
        .document_import(DocumentImportInput {
            project_id: source_owner,
            source_path: source.to_string_lossy().into(),
            is_starred: false,
            tag_ids: None,
        })
        .unwrap();
    for number in 2..=version_count {
        let next = external.path().join(format!("version-{number}.md"));
        fs::write(&next, format!("immutable content {number}")).unwrap();
        db.document_add_version(DocumentAddVersionInput {
            document_id: file.id,
            source_path: Some(next.to_string_lossy().into()),
        })
        .unwrap();
    }
    let binding = WorkspaceBinding {
        workspace_id: meta.workspace_id,
        generation: "wp03-file-rename".into(),
    };
    let mut request = RequestContext {
        binding: binding.clone(),
        request_id: "mark-history".into(),
        caller: Caller::Gui,
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: true,
            project_ids: projects.clone(),
            operations: vec![
                "file.move".into(),
                "file.update".into(),
                "source.read".into(),
                "file.version.metadata.update".into(),
            ],
            object_keys: None,
        },
    };
    let object = ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: super::file_scope::scope(source_owner),
        kind: ObjectKind::File,
        id: file.id.to_string(),
    };
    // Freeze the latest version too, rather than testing only a legacy version
    // row pointing at the mutable live file. This also covers a lone v1.
    let opened = db
        .file_working_begin_session(&request, &binding, &object)
        .unwrap();
    db.file_working_close(
        &request,
        &binding,
        &WorkingSession {
            object: object.clone(),
            session_id: opened.session_id,
        },
    )
    .unwrap();
    let versions = db
        .document_list_versions(DocumentListVersionsInput {
            document_id: file.id,
        })
        .unwrap();
    assert_eq!(versions.len(), version_count as usize);
    db.file_version_metadata_update(
        &request,
        &binding,
        &VersionMetadataUpdate {
            object,
            version_id: versions.last().unwrap().id.to_string(),
            expected_metadata_revision: 0,
            display_name: Some("Retain through Project rename".into()),
            is_important: true,
        },
    )
    .unwrap();
    request.request_id = "move-to-b".into();
    let file = db.document_record(file.id).unwrap();
    Fixture {
        db,
        root,
        _external: external,
        binding,
        request,
        a: projects[0],
        b: projects[1],
        file,
    }
}

fn rename_input(project_id: i64, name: &str) -> ProjectUpdateInput {
    ProjectUpdateInput {
        project_id,
        name: Some(name.into()),
        summary: String::new(),
        summary_markdown: None,
        summary_html: None,
        summary_code_language: None,
        status: None,
    }
}

fn move_to_b(f: &mut Fixture) {
    let baseline =
        f.db.file_owner_move_baseline(&f.request, &f.binding, f.file.id, f.file.project_id)
            .unwrap();
    f.db.file_owner_move(
        &f.request,
        &f.binding,
        &FileOwnerMove {
            document_id: f.file.id,
            source_owner: f.file.project_id,
            target_owner: Some(f.b),
            expected_version: baseline.expected_version,
            expected_working_revision: baseline.expected_working_revision,
            expected_hash: baseline.expected_hash,
        },
    )
    .unwrap();
}

#[derive(Debug, PartialEq)]
struct History {
    versions: serde_json::Value,
    hashes: Vec<(i64, String)>,
    bytes: Vec<Vec<u8>>,
}

fn history(db: &mut Database, document_id: i64) -> History {
    let versions = db
        .document_list_versions(DocumentListVersionsInput { document_id })
        .unwrap();
    let bytes = versions
        .iter()
        .map(|version| fs::read(&version.managed_path).unwrap())
        .collect();
    // Compare persisted hashes as well as actual bytes, without mutating SQL
    // state or synthesizing version rows outside the production API.
    let hashes = db
        .conn
        .prepare(
            "SELECT v.id,h.content_hash FROM document_versions v
             JOIN source_file_version_hashes h ON h.document_version_id=v.id
             WHERE v.document_id=?1 ORDER BY v.version_number",
        )
        .unwrap()
        .query_map([document_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(hashes.len(), versions.len());
    for version in &versions {
        let registered = hashes.iter().find(|(id, _)| *id == version.id).unwrap();
        assert_eq!(
            super::file_versions::checksum(Path::new(&version.managed_path)).unwrap(),
            registered.1
        );
    }
    History {
        versions: serde_json::to_value(versions).unwrap(),
        hashes,
        bytes,
    }
}

fn assert_target_rename_preserves_history(from_project: bool, version_count: i64) {
    let mut f = fixture(from_project, version_count);
    let before = history(&mut f.db, f.file.id);
    let live_bytes = fs::read(&f.file.managed_path).unwrap();
    move_to_b(&mut f);
    let moved = f.db.document_record(f.file.id).unwrap();
    let old_b = f.db.project_record(f.b).unwrap();
    assert_eq!(moved.history_dir_path, f.file.history_dir_path);
    assert!(!Path::new(&moved.history_dir_path).starts_with(&old_b.root_path));
    assert_eq!(history(&mut f.db, f.file.id), before);

    let renamed = f
        .db
        .project_update(rename_input(f.b, "B renamed"))
        .expect("ARCH-03: legitimate external File history must not block target Project rename");
    let current = f.db.document_record(f.file.id).unwrap();
    let relative_live = Path::new(&moved.managed_path)
        .strip_prefix(&old_b.root_path)
        .unwrap();
    assert_eq!(renamed.id, f.b);
    assert_eq!(renamed.name, "B renamed");
    assert_eq!(
        Path::new(&renamed.root_path),
        f.root.path().join("B renamed")
    );
    assert!(!Path::new(&old_b.root_path).exists());
    assert_eq!(current.id, f.file.id);
    assert_eq!(current.project_id, Some(f.b));
    assert_eq!(current.current_version_number, version_count);
    assert_eq!(current.version_count, version_count);
    assert_eq!(
        Path::new(&current.managed_path),
        Path::new(&renamed.root_path).join(relative_live)
    );
    assert_eq!(fs::read(&current.managed_path).unwrap(), live_bytes);
    assert_eq!(current.history_dir_path, f.file.history_dir_path);
    // Full serialized version records include IDs, version numbers, source and
    // physical paths, timestamps, names, importance, and metadata revisions.
    assert_eq!(history(&mut f.db, f.file.id), before);
}

#[test]
fn arch03_workspace_file_v1_move_then_rename_b_preserves_external_history() {
    assert_target_rename_preserves_history(false, 1);
}

#[test]
fn arch03_workspace_file_multiple_versions_move_then_rename_b_preserves_external_history() {
    assert_target_rename_preserves_history(false, 3);
}

#[test]
fn arch03_project_file_v1_move_then_rename_b_preserves_external_history() {
    assert_target_rename_preserves_history(true, 1);
}

#[test]
fn arch03_project_file_multiple_versions_move_then_rename_b_preserves_external_history() {
    assert_target_rename_preserves_history(true, 3);
}

#[test]
fn arch03_source_project_rename_still_protects_foreign_file_history() {
    for version_count in [1, 3] {
        let mut f = fixture(true, version_count);
        let source_project = f.db.project_record(f.a).unwrap();
        let before = history(&mut f.db, f.file.id);
        move_to_b(&mut f);
        let moved = f.db.document_record(f.file.id).unwrap();
        let live_bytes = fs::read(&moved.managed_path).unwrap();
        assert!(Path::new(&moved.history_dir_path).starts_with(&source_project.root_path));
        let error =
            f.db.project_update(rename_input(f.a, "A renamed"))
                .expect_err(
                    "source root hosts another owner's immutable history and must remain protected",
                );
        assert!(error.to_string().contains("retains history"), "{error:#}");
        let unchanged = f.db.project_record(f.a).unwrap();
        assert_eq!(unchanged.name, source_project.name);
        assert_eq!(unchanged.root_path, source_project.root_path);
        assert!(Path::new(&source_project.root_path).is_dir());
        assert!(!f.root.path().join("A renamed").exists());
        let current = f.db.document_record(f.file.id).unwrap();
        assert_eq!(current.project_id, Some(f.b));
        assert_eq!(current.managed_path, moved.managed_path);
        assert_eq!(current.history_dir_path, moved.history_dir_path);
        assert_eq!(fs::read(&current.managed_path).unwrap(), live_bytes);
        assert_eq!(history(&mut f.db, f.file.id), before);
    }
}
