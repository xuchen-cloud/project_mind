use super::*;
const DOCX_BYTES: &[u8] =
    include_bytes!("../../../../packages/office-docx/test/fixtures/complex.original.docx");
use crate::{
    agent::errors::AgentResult,
    committed_changes::{CommittedChangePublisher, CommittedChanges},
    db::Database,
    workspace::create_workspace,
};

struct Store {
    binding: Mutex<WorkspaceBinding>,
    db: Mutex<Database>,
    db_path: std::path::PathBuf,
}
impl CommittedChangePublisher for Store {
    fn publish_committed(&self, _: CommittedChanges) {
        panic!("image reads cannot publish writes")
    }
}
impl BoundSourceStore for Store {
    fn with_current<T>(
        &self,
        action: impl FnOnce(&WorkspaceBinding, &Database) -> AgentResult<T>,
    ) -> AgentResult<T> {
        action(&self.binding.lock().unwrap(), &self.db.lock().unwrap())
    }
}
fn fixture() -> (
    tempfile::TempDir,
    Store,
    FetchEditorRemoteImageInput,
    std::path::PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (workspace, paths) = create_workspace(&root, "password").unwrap();
    let mut db = Database::open(&paths.db_path, &root, None).unwrap();
    db.bind_native_workspace(&workspace.workspace_id).unwrap();
    let project = db
        .project_create(crate::models::ProjectCreateInput {
            name: "Images".into(),
            summary: None,
            status: None,
        })
        .unwrap();
    let path = std::path::PathBuf::from(project.root_path).join("document.docx");
    std::fs::write(&path, DOCX_BYTES).unwrap();
    let file = db
        .project_file_register(&workspace.workspace_id, project.id, "document.docx")
        .unwrap();
    let binding = WorkspaceBinding {
        workspace_id: workspace.workspace_id,
        generation: "opened".into(),
    };
    let input = FetchEditorRemoteImageInput {
        binding: binding.clone(),
        document: FileBytesInput {
            object: file.object,
            version_number: 1,
            expected_content_hash: file.content_hash.unwrap(),
        },
        url: "http://images.test/picture.png".into(),
    };
    (
        temp,
        Store {
            binding: Mutex::new(binding),
            db: Mutex::new(db),
            db_path: paths.db_path.clone(),
        },
        input,
        path,
    )
}

#[tokio::test]
async fn actual_file_hash_format_and_editable_owner_are_required_before_dns() {
    let (_temp, store, mut input, path) = fixture();
    assert!(input.document.expected_content_hash.starts_with("sha256:"));
    assert_eq!(input.document.expected_content_hash.len(), 71);
    let client = downloader("127.0.0.1:1".parse().unwrap());
    for mutation in ["history", "workspace", "unregistered", "owner", "caller"] {
        let original = input.document.version_number;
        if mutation == "history" {
            input.document.version_number = 2;
        }
        if mutation == "workspace" {
            input.binding.generation = "closed-and-reopened".into();
        }
        if mutation == "unregistered" {
            std::fs::write(&path, b"outside change").unwrap();
        }
        let label = if mutation == "owner" {
            "project-999999"
        } else {
            "main"
        };
        let result = fetch_for_document(
            &store,
            &input,
            || {
                if mutation == "caller" {
                    Err(failure("caller_denied", "denied"))
                } else {
                    Ok(label.into())
                }
            },
            &client,
        )
        .await;
        assert!(result.is_err(), "{mutation}");
        assert!(
            client.resolver.calls.lock().unwrap().is_empty(),
            "{mutation} reached DNS"
        );
        input.document.version_number = original;
        input.binding.generation = "opened".into();
        std::fs::write(&path, DOCX_BYTES).unwrap();
    }
}

#[tokio::test]
async fn delayed_response_cannot_outlive_file_or_binding_and_holds_no_db_lock() {
    for mutation in [
        "bytes",
        "generation",
        "version",
        "archive",
        "hidden",
        "deleted",
    ] {
        let (_temp, store, input, path) = fixture();
        let project = match input.document.object.scope {
            crate::agent::models::Scope::Project { project_id } => project_id,
            _ => unreachable!(),
        };
        let (addr, seen, task) = server(
            vec![response("200 OK", "Content-Type: image/png\r\n", &png())],
            Duration::from_millis(80),
        )
        .await;
        let client = downloader(addr);
        let fetch = fetch_for_document(&store, &input, || Ok("main".into()), &client);
        let mutate = async {
            while seen.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
            // Real HTTP request has arrived; both mutexes must be available.
            let mut binding = store.binding.try_lock().expect("binding held over network");
            let _db = store.db.try_lock().expect("DB held over network");
            let connection = rusqlite::Connection::open(&store.db_path).unwrap();
            match mutation {
                "bytes" => std::fs::write(&path, b"external change during HTTP").unwrap(),
                "generation" => binding.generation = "reopened".into(),
                "version" => {
                    connection
                        .execute(
                            "UPDATE documents SET current_version_number=2 WHERE id=?1",
                            [input.document.object.id.parse::<i64>().unwrap()],
                        )
                        .unwrap();
                }
                "archive" => {
                    connection
                        .execute("UPDATE projects SET is_archived=1 WHERE id=?1", [project])
                        .unwrap();
                }
                "hidden" => {
                    connection.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,restore_operation_id,revision) VALUES (?1,'image-fixture','2026-10-18T00:00:00Z',NULL,1)",[input.document.object.key().unwrap()]).unwrap();
                }
                "deleted" => {
                    connection
                        .execute(
                            "DELETE FROM documents WHERE id=?1",
                            [input.document.object.id.parse::<i64>().unwrap()],
                        )
                        .unwrap();
                }
                _ => unreachable!(),
            }
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(fetch, mutate)
        })
        .await
        .expect("HTTP/File mutation boundary did not arrive");
        assert!(result.is_err(), "{mutation} returned image");
        task.await.unwrap();
    }
}

#[tokio::test]
async fn successful_read_preserves_file_bytes_and_returns_real_original_png() {
    let (_temp, store, input, path) = fixture();
    let before = std::fs::read(&path).unwrap();
    let png = png();
    let (addr, _, task) = server(
        vec![response("200 OK", "Content-Type: image/png\r\n", &png)],
        Duration::ZERO,
    )
    .await;
    let result = fetch_for_document(&store, &input, || Ok("main".into()), &downloader(addr))
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(STANDARD.decode(result.base64).unwrap(), png);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
