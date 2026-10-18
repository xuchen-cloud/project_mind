use super::*;
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentResult, ErrorCode},
        models::WorkspaceBinding,
    },
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    file_version_service::{BoundFileCommitStore, FileCommitHost},
    office_worker::{OfficePayload, OfficeUtility},
    source_service::BoundSourceStore,
    workspace::{create_workspace, WorkspacePaths},
    workspace_commit_fence::WorkspaceCommitFence,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct Store {
    db: Mutex<Database>,
    binding: WorkspaceBinding,
    paths: WorkspacePaths,
    fence: Arc<WorkspaceCommitFence>,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        f(&self.binding, &self.db.lock().unwrap())
    }
}
impl BoundFileCommitStore for Store {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        crate::file_version_service::validate_binding(binding, &self.binding)?;
        Ok(FileCommitHost::for_test(
            self.binding.clone(),
            self.paths.clone(),
            None,
            self.fence.clone(),
        ))
    }
}
struct Engine;
impl OfficeUtility for Engine {
    async fn request(
        &self,
        _: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        assert_eq!(format, "docx");
        let original = STANDARD.decode(base64).unwrap();
        assert_eq!(original, b"first document");
        if method == "office.inspect" {
            return Ok(json!({"model":{"text":"first document"}}));
        }
        let OfficePayload::Edit(edits) = payload else {
            panic!("expected edit payload")
        };
        assert_eq!(edits, &[json!({"text":"second document"})]);
        Ok(json!({"model":{"text":"second document"},"base64":STANDARD.encode(b"second document")}))
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    store: Store,
    request: RequestContext,
    input: FileOfficeEditInput,
    path: PathBuf,
}
fn fixture() -> Fixture {
    fixture_bytes("document.docx", b"first document")
}
fn fixture_bytes(name: &str, bytes: &[u8]) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (metadata, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Office".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let path = PathBuf::from(project.root_path).join(name);
    std::fs::write(&path, bytes).unwrap();
    let file = db
        .project_file_register(&metadata.workspace_id, project.id, name)
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: metadata.workspace_id,
        generation: "opened".into(),
    };
    let request = RequestContext {
        binding: binding.clone(),
        caller: Caller::Gui,
        request_id: "office-save".into(),
        scope_grant: ScopeGrant {
            workspace_id: binding.workspace_id.clone(),
            workspace_content: false,
            project_ids: vec![project.id],
            operations: vec!["source.read".into(), "file.update".into()],
            object_keys: None,
        },
    };
    let input = FileOfficeEditInput {
        object: file.object,
        version_number: 1,
        expected_content_hash: file.content_hash.unwrap(),
        edits: vec![json!({"text":"second document"})],
    };
    Fixture {
        _temp: temp,
        store: Store {
            db: Mutex::new(db),
            binding,
            paths,
            fence: Arc::new(WorkspaceCommitFence::new()),
        },
        request,
        input,
        path,
    }
}

fn recalculation_input(f: &Fixture) -> FileOfficeRecalculateInput {
    serde_json::from_value(json!({
        "object":f.input.object,"versionNumber":1,"expectedContentHash":f.input.expected_content_hash,
        "recalculation":{"edits":[{"sheetId":"sheet-1","row":0,"column":1,"input":"=SUM(A1:A2)"}],
            "reads":[{"sheetId":"sheet-1","range":{"startRow":0,"endRow":0,"startColumn":1,"endColumn":1}}]}
    })).unwrap()
}
struct RecalcEngine;
impl OfficeUtility for RecalcEngine {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        assert!(!id.is_empty());
        assert_eq!(method, "office.recalculate");
        assert_eq!(format, "xlsx");
        assert_eq!(STANDARD.decode(base64).unwrap(), b"first workbook");
        let OfficePayload::Recalculate(input) = payload else {
            panic!("expected read-only calculation payload")
        };
        assert_eq!(input.edits[0].input, "=SUM(A1:A2)");
        Ok(
            json!({"cells":[{"sheetId":"sheet-1","row":0,"column":1,"formatted":"42","number":42,"isFormula":true}]}),
        )
    }
}
#[tokio::test]
async fn office_recalculate_is_read_only_and_accepts_a_read_only_gui_grant() {
    let f = fixture_bytes("workbook.xlsx", b"first workbook");
    let input = recalculation_input(&f);
    let request = gui_request(
        &f.store,
        &f.store.binding,
        "read-recalc",
        &input.object,
        false,
    )
    .unwrap();
    assert_eq!(request.scope_grant.operations, ["source.read"]);
    let result = FileOfficeService::new(&f.store, &RecalcEngine)
        .recalculate(&request, &input)
        .await
        .unwrap();
    assert_eq!(result.cells[0].number, Some(42.0));
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first workbook");
    let connection = rusqlite::Connection::open(&f.store.paths.db_path).unwrap();
    let versions: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM document_versions WHERE document_id=?1",
            [&input.object.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(versions, 1);
    let file = f
        .store
        .with_current(|_, db| {
            db.project_file_resolve(&input.object)
                .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
        })
        .unwrap();
    assert_eq!(file.version_number, 1);
    assert_eq!(
        file.content_hash.as_deref(),
        Some(input.expected_content_hash.as_str())
    );
}

#[tokio::test]
async fn office_recalculate_checks_actual_owner_binding_hash_format_and_value_budget() {
    let f = fixture_bytes("workbook.xlsx", b"first workbook");
    let input = recalculation_input(&f);
    let service = FileOfficeService::new(&f.store, &RecalcEngine);
    let mut forged = input.clone();
    forged.object.scope = crate::agent::models::Scope::Project { project_id: 9999 };
    assert_eq!(
        service
            .recalculate(&f.request, &forged)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let mut stale = f.request.clone();
    stale.binding.generation = "previous".into();
    assert_eq!(
        service.recalculate(&stale, &input).await.unwrap_err().code,
        ErrorCode::WorkspaceChanged
    );
    let mut denied = f.request.clone();
    denied.scope_grant.operations.clear();
    assert_eq!(
        service.recalculate(&denied, &input).await.unwrap_err().code,
        ErrorCode::ScopeDenied
    );
    let mut changed = input.clone();
    changed.expected_content_hash = format!("sha256:{}", "f".repeat(64));
    assert_eq!(
        service
            .recalculate(&f.request, &changed)
            .await
            .unwrap_err()
            .code,
        ErrorCode::SourceChanged
    );
    let mut over = input.clone();
    over.recalculation.edits[0].input = "😀".repeat(16384);
    assert_eq!(
        service
            .recalculate(&f.request, &over)
            .await
            .unwrap_err()
            .code,
        ErrorCode::BudgetExceeded
    );
    let doc = fixture();
    assert_eq!(
        FileOfficeService::new(&doc.store, &RecalcEngine)
            .recalculate(&doc.request, &recalculation_input(&doc))
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
}

enum RecalcMutation {
    Hash,
    VersionGone,
    Owner(i64),
}
struct RecalcChangedBaseline {
    database: PathBuf,
    root: PathBuf,
    file_id: String,
    mutation: RecalcMutation,
}
impl OfficeUtility for RecalcChangedBaseline {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        bytes: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        let result = RecalcEngine
            .request(id, method, format, bytes, payload)
            .await?;
        let connection = rusqlite::Connection::open(&self.database).unwrap();
        match self.mutation {
            RecalcMutation::Hash => {
                let reference:String=connection.query_row("SELECT managed_path FROM document_versions WHERE document_id=?1 AND version_number=1",[&self.file_id],|row|row.get(0)).unwrap();
                let snapshot = self
                    .root
                    .join(reference.strip_prefix("workspace:").unwrap());
                std::fs::write(snapshot, b"tampered retained workbook").unwrap();
            }
            RecalcMutation::VersionGone => {
                connection
                    .execute(
                        "DELETE FROM document_versions WHERE document_id=?1",
                        [&self.file_id],
                    )
                    .unwrap();
            }
            RecalcMutation::Owner(project) => {
                connection
                    .execute(
                        "UPDATE documents SET project_id=?1 WHERE id=?2",
                        rusqlite::params![project, self.file_id],
                    )
                    .unwrap();
            }
        }
        Ok(result)
    }
}
#[tokio::test]
async fn office_recalculate_rechecks_fixed_version_hash_after_async_computation() {
    for variant in 0..3 {
        let f = fixture_bytes("workbook.xlsx", b"first workbook");
        let input = recalculation_input(&f);
        let (mutation, expected) = match variant {
            0 => (RecalcMutation::Hash, ErrorCode::SourceChanged),
            1 => (RecalcMutation::VersionGone, ErrorCode::SourceNotReady),
            _ => {
                let project = f
                    .store
                    .db
                    .lock()
                    .unwrap()
                    .project_create(crate::models::ProjectCreateInput {
                        name: "Another owner".into(),
                        summary: None,
                        status: None,
                    })
                    .unwrap();
                (RecalcMutation::Owner(project.id), ErrorCode::ScopeDenied)
            }
        };
        let worker = RecalcChangedBaseline {
            database: f.store.paths.db_path.clone(),
            root: f.store.paths.root_path.clone(),
            file_id: input.object.id.clone(),
            mutation,
        };
        assert_eq!(
            FileOfficeService::new(&f.store, &worker)
                .recalculate(&f.request, &input)
                .await
                .unwrap_err()
                .code,
            expected
        );
        assert_eq!(std::fs::read(&f.path).unwrap(), b"first workbook");
    }
}

struct RecalcRevoked<'a>(&'a Store, std::sync::atomic::AtomicBool);
impl BoundSourceStore for RecalcRevoked<'_> {
    fn with_current<T>(
        &self,
        f: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        self.0.with_current(|binding, db| {
            let mut binding = binding.clone();
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                binding.generation = "reopened".into();
            }
            f(&binding, db)
        })
    }
}
impl CommittedChangePublisher for RecalcRevoked<'_> {
    fn publish_committed(&self, _: CommittedChanges) {}
}
impl BoundFileCommitStore for RecalcRevoked<'_> {
    fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
        self.0.gui_commit_host(binding)
    }
}
impl OfficeUtility for RecalcRevoked<'_> {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        bytes: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        let result = RecalcEngine
            .request(id, method, format, bytes, payload)
            .await?;
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(result)
    }
}
#[tokio::test]
async fn office_recalculate_rechecks_workspace_generation_after_async_computation() {
    let f = fixture_bytes("workbook.xlsx", b"first workbook");
    let host = RecalcRevoked(&f.store, std::sync::atomic::AtomicBool::new(false));
    assert_eq!(
        FileOfficeService::new(&host, &host)
            .recalculate(&f.request, &recalculation_input(&f))
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceChanged
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first workbook");
}

#[tokio::test]
async fn office_gui_save_commits_real_file_version_and_history_keeps_old_bytes() {
    let f = fixture();
    let service = FileOfficeService::new(&f.store, &Engine);
    let saved = service.save(&f.request, &f.input).await.unwrap();
    assert_eq!(saved.version_number, 2);
    assert_eq!(saved.model["text"], "second document");
    assert_eq!(std::fs::read(&f.path).unwrap(), b"second document");
    let old = service
        .inspect(&f.request, &f.input.baseline())
        .await
        .unwrap();
    assert_eq!(old.version_number, 1);
    assert_eq!(old.model["text"], "first document");
    let mut stale = f.request.clone();
    stale.request_id = "old-baseline".into();
    assert_eq!(
        service.save(&stale, &f.input).await.unwrap_err().code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"second document");
}

#[tokio::test]
async fn office_save_replays_same_receipt_and_rejects_reusing_id_for_different_edits() {
    let f = fixture();
    let service = FileOfficeService::new(&f.store, &Engine);
    let saved = service.save(&f.request, &f.input).await.unwrap();
    let replay = service.save(&f.request, &f.input).await.unwrap();
    assert_eq!(replay.commit.receipt, saved.commit.receipt);
    let mut changed = f.input.clone();
    changed.edits = vec![json!({"text":"different"})];
    assert_eq!(
        service.save(&f.request, &changed).await.unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"second document");
}
struct ChangedDisk(PathBuf);
impl OfficeUtility for ChangedDisk {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        let result = Engine.request(id, method, format, base64, payload).await?;
        std::fs::write(&self.0, b"external document").unwrap();
        Ok(result)
    }
}
struct DeletedDisk(PathBuf);
impl OfficeUtility for DeletedDisk {
    async fn request(
        &self,
        id: &str,
        method: &str,
        format: &str,
        base64: &str,
        payload: OfficePayload<'_>,
    ) -> AgentResult<Value> {
        let result = Engine.request(id, method, format, base64, payload).await?;
        std::fs::remove_file(&self.0).unwrap();
        Ok(result)
    }
}

#[tokio::test]
async fn office_save_original_missing_before_save_has_explicit_reason() {
    let f = fixture();
    let service = FileOfficeService::new(&f.store, &Engine);
    service.inspect(&f.request, &f.input.baseline()).await.unwrap();
    std::fs::remove_file(&f.path).unwrap();
    let failure = service.save(&f.request, &f.input).await.unwrap_err();
    assert_eq!(failure.code, ErrorCode::SourceNotReady);
    assert_eq!(failure.details, Some(json!({"reason":"original_missing"})));
    assert!(!f.path.exists());
    assert_eq!(
        f.store.db.lock().unwrap()
            .file_version_registered_target(&f.request, &f.store.binding, &f.input.object)
            .unwrap().current_version_number,
        1
    );
}

#[tokio::test]
async fn office_save_original_missing_during_utility_has_explicit_reason() {
    let f = fixture();
    let failure = FileOfficeService::new(&f.store, &DeletedDisk(f.path.clone()))
        .save(&f.request, &f.input).await.unwrap_err();
    assert_eq!(failure.code, ErrorCode::SourceNotReady);
    assert_eq!(failure.details, Some(json!({"reason":"original_missing"})));
    assert!(!f.path.exists());
    assert_eq!(
        f.store.db.lock().unwrap()
            .file_version_registered_target(&f.request, &f.store.binding, &f.input.object)
            .unwrap().current_version_number,
        1
    );
}

#[test]
fn office_save_original_missing_does_not_reclassify_generic_snapshot_io() {
    use crate::file_version_service::{FileBytesReader, FilesystemFileReader};
    let temp = tempfile::tempdir().unwrap();
    let failure = FilesystemFileReader.capture(&temp.path().join("missing-version-snapshot"))
        .err().unwrap();
    assert_eq!(failure.code, ErrorCode::IoFailed);
    assert_eq!(failure.details, None);
}

#[tokio::test]
async fn office_save_rejects_external_disk_changes_before_and_during_utility() {
    let f = fixture();
    std::fs::write(&f.path, b"external document").unwrap();
    assert_eq!(
        FileOfficeService::new(&f.store, &Engine)
            .save(&f.request, &f.input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"external document");
    std::fs::write(&f.path, b"first document").unwrap();
    assert_eq!(
        FileOfficeService::new(&f.store, &ChangedDisk(f.path.clone()))
            .save(&f.request, &f.input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::FileChangedUnregistered
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"external document");
}
#[tokio::test]
async fn office_gui_authority_uses_actual_file_owner_and_cannot_save_with_read_only_grant() {
    use crate::agent::models::Scope;
    let f = fixture();
    let mut forged = f.input.clone();
    forged.object.scope = Scope::Project { project_id: 9999 };
    assert_eq!(
        gui_request(&f.store, &f.store.binding, "forged", &forged.object, true)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(
        FileOfficeService::new(&f.store, &Engine)
            .inspect(&f.request, &forged.baseline())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    let read = gui_request(&f.store, &f.store.binding, "read", &f.input.object, false).unwrap();
    assert_eq!(
        FileOfficeService::new(&f.store, &Engine)
            .save(&read, &f.input)
            .await
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first document");
}
#[tokio::test]
async fn office_save_preparation_stages_owned_content_without_writing_the_file() {
    let f = fixture();
    let candidate = FileOfficeService::new(&f.store, &Engine)
        .prepare_edit(&f.request, &f.input)
        .await
        .unwrap();
    assert_eq!(candidate.target, f.input.object);
    assert_eq!(candidate.expected_version, 1);
    assert_eq!(candidate.expected_hash, f.input.expected_content_hash);
    assert_eq!(candidate.model, json!({"text":"second document"}));
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first document");
    let content = FileContentService::new(&f.store, &SystemFileContentClock);
    let status = content
        .status(&f.request, &candidate.staged_content_id)
        .unwrap();
    assert!(status.ready);
    assert!(!status.consumed);
    assert_eq!(status.received_length, b"second document".len() as u64);
    let mut other = f.request.clone();
    other.caller = Caller::BuiltinRun {
        run_id: "other-run".into(),
    };
    assert_eq!(
        content
            .status(&other, &candidate.staged_content_id)
            .unwrap_err()
            .code,
        ErrorCode::ScopeDenied
    );
}
#[tokio::test]
async fn office_sql_failure_rolls_back_live_bytes_and_can_retry_same_stage() {
    let f = fixture();
    let connection = rusqlite::Connection::open(&f.store.paths.db_path).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_office_save BEFORE INSERT ON document_versions WHEN NEW.version_number=2 BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    let service = FileOfficeService::new(&f.store, &Engine);
    assert!(service.save(&f.request, &f.input).await.is_err());
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first document");
    assert_eq!(
        service
            .inspect(&f.request, &f.input.baseline())
            .await
            .unwrap()
            .model["text"],
        "first document"
    );
    connection
        .execute_batch("DROP TRIGGER fail_office_save;")
        .unwrap();
    assert_eq!(
        service
            .save(&f.request, &f.input)
            .await
            .unwrap()
            .version_number,
        2
    );
    assert_eq!(std::fs::read(&f.path).unwrap(), b"second document");
}

/// Explicit opt-in: uses the packaged format engines and XLSX native sidecar,
/// with no Tauri AppHandle, user window or mock utility.
#[tokio::test]
#[ignore = "requires pinned development Node and all staged Office-dist assets"]
async fn office_real_formats_native_save_reopen_and_retained_history() {
    let worker = crate::office_worker::OfficeWorker::development()
        .expect("Stage Node 24.21.0 and office-dist before this acceptance test");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    for (format, relative) in [
        (
            "docx",
            "packages/office-docx/test/fixtures/simple.original.docx",
        ),
        (
            "xlsx",
            "packages/office-xlsx/tests/fixtures/simple.original.xlsx",
        ),
        ("pptx", "packages/office-pptx/test/fixtures/simple.pptx"),
    ] {
        office_real_format(&worker, root, format, relative).await;
    }
}
#[tokio::test]
#[ignore = "requires pinned development Node and all staged Office-dist assets"]
async fn office_real_pptx_native_save_reopen_and_retained_history() {
    let worker = crate::office_worker::OfficeWorker::development().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    office_real_format(
        &worker,
        root,
        "pptx",
        "packages/office-pptx/test/fixtures/simple.pptx",
    )
    .await;
}
async fn office_real_format(
    worker: &crate::office_worker::OfficeWorker,
    root: &std::path::Path,
    format: &str,
    relative: &str,
) {
    let bytes = std::fs::read(root.join(relative)).unwrap();
    let mut f = fixture_bytes(&format!("original.{format}"), &bytes);
    let service = FileOfficeService::new(&f.store, worker);
    let original = service
        .inspect(&f.request, &f.input.baseline())
        .await
        .unwrap();
    if format == "xlsx" {
        let imported = crate::editor_workbook_import::inspect_imported(
            "main", worker,
            serde_json::from_value(json!({"base64": STANDARD.encode(&bytes)})).unwrap(),
        ).await.unwrap();
        assert_eq!(imported["format"], "xlsx");
        assert_eq!(imported["sheets"], original.model["sheets"]);
        assert!(imported["rendererData"]["file"].is_object());
        assert_eq!(std::fs::read(root.join(relative)).unwrap(), bytes);
        // The existing real-format opt-in also exercises the data-only IronCalc route.
        let calculation: FileOfficeRecalculateInput = serde_json::from_value(json!({
            "object":f.input.object,"versionNumber":1,"expectedContentHash":f.input.expected_content_hash,
            "recalculation":{"edits":[
                {"sheetId":"sheet-1","row":2,"column":1,"input":"15"},
                {"sheetId":"sheet-1","row":4,"column":1,"input":"=SUM(B3:B4)+5"}
            ],"reads":[
                {"sheetId":"sheet-1","range":{"startRow":4,"endRow":4,"startColumn":1,"endColumn":1}},
                {"sheetId":"sheet-2","range":{"startRow":2,"endRow":2,"startColumn":1,"endColumn":1}}
            ]}
        })).unwrap();
        let calculated = service.recalculate(&f.request, &calculation).await.unwrap();
        for (sheet, row) in [("sheet-1", 4), ("sheet-2", 2)] {
            let cell = calculated
                .cells
                .iter()
                .find(|cell| cell.sheet_id == sheet && cell.row == row && cell.column == 1)
                .unwrap();
            assert_eq!(
                cell.number,
                Some(40.0),
                "{sheet}: native read-only IronCalc result"
            );
        }
        assert_eq!(
            std::fs::read(&f.path).unwrap(),
            bytes,
            "Recalculation must not save the File"
        );
        let current = f
            .store
            .with_current(|_, db| {
                db.project_file_resolve(&f.input.object)
                    .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
            })
            .unwrap();
        assert_eq!(current.version_number, 1);
    }
    let old = f.input.baseline();
    f.input.edits = match format {
        "docx" => {
            let node = original.model["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| {
                    node["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("春风拂面"))
                })
                .expect("Real Chinese paragraph fixture");
            vec![
                json!({"type":"text","nodeId":node["id"],"expectedText":node["text"],"text":"原生保存中文段落。"}),
            ]
        }
        "xlsx" => vec![
            json!({"sheetId":"sheet-1","row":2,"column":0,"kind":"string","value":"香蕉（原生保存）"}),
            json!({"sheetId":"sheet-1","row":2,"column":1,"kind":"number","value":15}),
            json!({"sheetId":"sheet-1","row":4,"column":1,"kind":"formula","formula":"=SUM(B3:B4)+5"}),
        ],
        "pptx" => {
            let target = original.model["textElements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|target| {
                    target["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("项目进展正常"))
                })
                .expect("Real Chinese slide fixture");
            vec![
                json!({"kind":"text","slideIndex":target["slideIndex"],"cNvPrId":target["cNvPrId"],"paragraphIndex":0,"runIndex":0,"text":"项目进展：原生保存成功"}),
            ]
        }
        _ => unreachable!(),
    };
    let saved = service.save(&f.request, &f.input).await.unwrap();
    assert_eq!(saved.version_number, 2, "{format}");
    let current = FileOfficeInput {
        object: saved.object.clone(),
        version_number: 2,
        expected_content_hash: saved.content_hash.clone(),
    };
    let reopened = service.inspect(&f.request, &current).await.unwrap();
    assert_eq!(
        reopened.model, saved.model,
        "{format}: saved model must describe reopened bytes"
    );
    match format {
        "docx" => assert!(reopened.model["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["text"] == "原生保存中文段落。")),
        "pptx" => assert!(reopened.model["textElements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["text"] == "项目进展：原生保存成功")),
        "xlsx" => {
            assert_eq!(
                xlsx_cell(&reopened.model, "明细", 2, 0)["value"],
                "香蕉（原生保存）"
            );
            assert_eq!(xlsx_cell(&reopened.model, "明细", 4, 1)["value"], 40);
            assert_eq!(xlsx_cell(&reopened.model, "说明", 2, 1)["value"], 40);
        }
        _ => unreachable!(),
    }
    assert_ne!(
        std::fs::read(&f.path).unwrap(),
        bytes,
        "{format}: original format was saved"
    );
    let history = service.inspect(&f.request, &old).await.unwrap();
    assert_eq!(
        history.model, original.model,
        "{format}: history reads original retained bytes"
    );
    let mut stale = f.request.clone();
    stale.request_id = format!("{format}:stale-baseline");
    assert_eq!(
        service.save(&stale, &f.input).await.unwrap_err().code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(
        service
            .save(&f.request, &f.input)
            .await
            .unwrap()
            .commit
            .receipt,
        saved.commit.receipt
    );
    // A second save retains the first cell and recalculates an untouched sheet.
    if format == "xlsx" {
        f.input.version_number = 2;
        f.input.expected_content_hash = saved.content_hash;
        f.input.edits =
            vec![json!({"sheetId":"sheet-1","row":2,"column":1,"kind":"number","value":10})];
        let mut next = f.request.clone();
        next.request_id = "xlsx:second-save".into();
        let second = service.save(&next, &f.input).await.unwrap();
        let reopened = service
            .inspect(
                &next,
                &FileOfficeInput {
                    object: second.object,
                    version_number: 3,
                    expected_content_hash: second.content_hash,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            xlsx_cell(&reopened.model, "明细", 2, 0)["value"],
            "香蕉（原生保存）"
        );
        assert_eq!(xlsx_cell(&reopened.model, "说明", 2, 1)["value"], 35);
    }
}

fn xlsx_cell<'a>(model: &'a Value, name: &str, row: u64, column: u64) -> &'a Value {
    let sheet = model["sheets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|sheet| sheet["name"] == name)
        .unwrap();
    model["ranges"][sheet["id"].as_str().unwrap()]["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cell| cell["row"] == row && cell["column"] == column)
        .unwrap()
}

fn crash_store(root: &std::path::Path) -> Store {
    let (metadata, paths) = crate::workspace::load_metadata(root).unwrap();
    let mut db = Database::open_runtime_connection(&paths.db_path, root, None).unwrap();
    db.bind_native_workspace(&metadata.workspace_id).unwrap();
    Store {
        db: Mutex::new(db),
        binding: WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "opened".into(),
        },
        paths,
        fence: Arc::new(WorkspaceCommitFence::new()),
    }
}
#[test]
#[ignore = "subprocess fixture for Office staged-directory crash recovery"]
fn office_directory_staged_crash_fixture() {
    let root =
        PathBuf::from(std::env::var_os("MIND_OFFICE_CRASH_ROOT").expect("Subprocess-only test"));
    let input: FileOfficeEditInput =
        serde_json::from_slice(&std::fs::read(root.join("office-test-input.json")).unwrap())
            .unwrap();
    let store = crash_store(&root);
    let request = gui_request(&store, &store.binding, "office-save", &input.object, true).unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(FileOfficeService::new(&store, &Engine).save(&request, &input))
        .unwrap();
    panic!("Office crash boundary was not reached");
}
fn crash_office(f: &Fixture, phase: u8) {
    std::fs::write(
        f.store.paths.root_path.join("office-test-input.json"),
        serde_json::to_vec(&f.input).unwrap(),
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "file_office::tests::office_directory_staged_crash_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("MIND_OFFICE_CRASH_ROOT", &f.store.paths.root_path)
        .env("MIND_DIRECTORY_RESTORE_CRASH_STAGE", phase.to_string())
        .output()
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            output.status.signal(),
            Some(9),
            "phase {phase}: status {}\nstdout: {}\nstderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(unix))]
    assert_eq!(
        output.status.code(),
        Some(91),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test]
async fn office_directory_staged_save_recovers_every_durable_boundary_and_replays_once() {
    for phase in 1..=4 {
        let f = fixture();
        crash_office(&f, phase);
        let store = crash_store(&f.store.paths.root_path);
        let file = store
            .with_current(|_, db| {
                db.project_file_resolve(&f.input.object)
                    .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
            })
            .unwrap();
        assert_eq!(file.state, "ready");
        assert_eq!(file.version_number, if phase == 4 { 2 } else { 1 });
        assert_eq!(
            std::fs::read(&f.path).unwrap(),
            if phase == 4 {
                b"second document".as_slice()
            } else {
                b"first document".as_slice()
            }
        );
        let request =
            gui_request(&store, &store.binding, "office-save", &f.input.object, true).unwrap();
        let service = FileOfficeService::new(&store, &Engine);
        let saved = service.save(&request, &f.input).await.unwrap();
        assert_eq!(saved.version_number, 2);
        assert_eq!(
            service
                .save(&request, &f.input)
                .await
                .unwrap()
                .commit
                .receipt,
            saved.commit.receipt
        );
        assert_eq!(std::fs::read(&f.path).unwrap(), b"second document");
        assert_eq!(
            service
                .inspect(&request, &f.input.baseline())
                .await
                .unwrap()
                .model["text"],
            "first document"
        );
        let file = store
            .with_current(|_, db| {
                db.project_file_resolve(&f.input.object)
                    .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
            })
            .unwrap();
        assert_eq!(file.version_number, 2);
    }
}
#[test]
fn office_directory_staged_recovery_never_overwrites_a_foreign_live_identity() {
    let f = fixture();
    crash_office(&f, 2);
    assert!(!f.path.exists());
    std::fs::write(&f.path, b"first document").unwrap();
    let identity = crate::db::file_versions::path_identity(&f.path).unwrap();
    let store = crash_store(&f.store.paths.root_path);
    let file = store
        .with_current(|_, db| {
            db.project_file_resolve(&f.input.object)
                .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
        })
        .unwrap();
    assert_eq!(file.state, "ambiguous");
    assert_eq!(file.version_number, 1);
    assert_eq!(std::fs::read(&f.path).unwrap(), b"first document");
    assert_eq!(
        crate::db::file_versions::path_identity(&f.path).unwrap(),
        identity
    );
}
