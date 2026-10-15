//! Local GUI File reads share the model-facing read kernels and actual owners.
use crate::{
    agent::{
        access::{Caller, RequestContext, ScopeGrant},
        errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
        file_tools::{
            FileSourceReadInput, FileVersionResult, FileVersionsGetInput, FileVersionsListInput,
            FileVersionsPage,
        },
        models::{ObjectRef, Scope, WorkspaceBinding},
    },
    file_source_read::{FileSourcePage, FileSourceReadService},
    source_service::BoundSourceStore,
    AppState,
};
use serde::Deserialize;
use tauri::{Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileReadCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}
fn request<T>(
    state: &AppState,
    input: &FileReadCommandInput<T>,
    object: &ObjectRef,
    operations: &[&str],
) -> AgentResult<RequestContext> {
    state.with_current(|binding, db| {
        if binding != &input.binding {
            return Err(AgentError::new(
                ErrorCode::WorkspaceChanged,
                "File Workspace is no longer current",
            ));
        }
        if input.request_id.is_empty() || input.request_id.len() > 128 {
            return Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid File read request identity",
            ));
        }
        let actual = db
            .agent_resolve_object(object, &binding.workspace_id)?
            .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "File is no longer present"))?;
        let (workspace_content, project_ids) = match actual.scope {
            Scope::Workspace => (true, vec![]),
            Scope::Project { project_id } => (false, vec![project_id]),
        };
        Ok(RequestContext {
            binding: binding.clone(),
            request_id: input.request_id.clone(),
            caller: Caller::Gui,
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content,
                project_ids,
                operations: operations
                    .iter()
                    .map(|operation| (*operation).into())
                    .collect(),
            },
        })
    })
}
#[tauri::command]
pub(crate) fn file_versions_list(
    state: State<'_, AppState>,
    input: FileReadCommandInput<FileVersionsListInput>,
) -> ApiResponse<FileVersionsPage> {
    let result =
        request(&state, &input, &input.data.object, &["source.read"]).and_then(|request| {
            state.with_current(|binding, db| {
                db.file_read_versions_list(&request, binding, &input.data)
            })
        });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) fn file_versions_get(
    state: State<'_, AppState>,
    input: FileReadCommandInput<FileVersionsGetInput>,
) -> ApiResponse<FileVersionResult> {
    let result =
        request(&state, &input, &input.data.object, &["source.read"]).and_then(|request| {
            state.with_current(|binding, db| {
                db.file_read_version_get(&request, binding, &input.data)
            })
        });
    ApiResponse::from_result(input.request_id, result)
}
#[tauri::command]
pub(crate) async fn file_source_read(
    state: State<'_, AppState>,
    input: FileReadCommandInput<FileSourceReadInput>,
) -> Result<ApiResponse<FileSourcePage>, String> {
    let result = async {
        let request = request(&state, &input, &input.data.object, &["source.read"])?;
        FileSourceReadService::new(&*state)
            .read(&request, &input.data)
            .await
    }
    .await;
    Ok(ApiResponse::from_result(input.request_id, result))
}

#[tauri::command]
pub(crate) async fn file_version_restore(
    state: State<'_, AppState>,
    input: FileReadCommandInput<crate::file_version_restore::FileVersionRestore>,
) -> Result<ApiResponse<crate::file_version_service::FileVersionCommitResult>, String> {
    let request_id = input.request_id.clone();
    let result = async {
        let request = request(
            &state,
            &input,
            &input.data.object,
            &["source.read", "file.restore"],
        )?;
        let handle = state.app_handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<AppState>();
            restore_gui_file_history(&*state, &request, &input.data)
        })
        .await
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "File restore task failed"))?
    }
    .await;
    // The envelope identity is retained outside the blocking native write.
    Ok(ApiResponse::from_result(request_id, result))
}

pub(crate) fn restore_gui_file_history<S>(
    store: &S,
    request: &RequestContext,
    input: &crate::file_version_restore::FileVersionRestore,
) -> AgentResult<crate::file_version_service::FileVersionCommitResult>
where
    S: BoundSourceStore
        + crate::file_version_service::BoundFileCommitStore
        + crate::file_version_service::BoundFileVersionStore,
{
    let plan =
        store.with_current(|binding, db| db.file_read_gui_restore_plan(request, binding, input))?;
    let service = crate::file_version_service::FileVersionService::new(
        store,
        &crate::file_version_service::FilesystemFileReader,
    );
    let directory = store.with_current(|binding, db| {
        db.source_read_historical_file(request, binding, &input.object)?;
        db.project_file_is_directory(&input.object)
            .map_err(|e| AgentError::new(ErrorCode::IoFailed, e.to_string()))
    })?;
    if directory {
        return service.restore_version(request, input);
    }
    let prepared = service.prepare_gui(&request.binding, &plan.input)?;
    if prepared.expected_version_number != input.expected_version_number
        || prepared.registered_content_hash.as_deref() != Some(input.expected_content_hash.as_str())
    {
        return Err(AgentError::new(
            ErrorCode::RevisionConflict,
            "File registered baseline changed before restoration",
        ));
    }
    if prepared.expected_content_hash != input.expected_content_hash {
        return Err(AgentError::new(
            ErrorCode::FileChangedUnregistered,
            "Current File bytes differ from the frozen registered baseline",
        ));
    }
    if prepared.new_content_hash != plan.historical_content_hash {
        return Err(AgentError::new(
            ErrorCode::SourceChanged,
            "Historical File bytes differ from their registered version",
        ));
    }
    service.commit_gui(&request.binding, &request.request_id, &prepared, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn directory_file_gui_history_restore_uses_bound_original_location_service() {
        use crate::{
            agent::access::{Caller, ScopeGrant},
            committed_changes::{CommittedChangePublisher, CommittedChanges},
            db::file_versions::{GuiFileVersionMetadata, GuiFileVersionPrepare},
            file_version_service::{BoundFileCommitStore, BoundFileVersionStore, FileCommitHost},
            models::{DocumentListVersionsInput, ProjectCreateInput},
            workspace::{create_workspace, WorkspacePaths},
            workspace_commit_fence::WorkspaceCommitFence,
        };
        struct Store {
            db: crate::db::Database,
            binding: WorkspaceBinding,
            paths: WorkspacePaths,
            fence: std::sync::Arc<WorkspaceCommitFence>,
        }
        impl BoundSourceStore for Store {
            fn with_current<T>(
                &self,
                action: impl FnOnce(&WorkspaceBinding, &crate::db::Database) -> AgentResult<T>,
            ) -> AgentResult<T> {
                action(&self.binding, &self.db)
            }
        }
        impl CommittedChangePublisher for Store {
            fn publish_committed(&self, _: CommittedChanges) {}
        }
        impl BoundFileVersionStore for Store {
            fn gui_metadata(
                &self,
                _: &WorkspaceBinding,
                input: &GuiFileVersionPrepare,
            ) -> AgentResult<GuiFileVersionMetadata> {
                self.db.file_version_gui_metadata(input)
            }
        }
        impl BoundFileCommitStore for Store {
            fn gui_commit_host(&self, binding: &WorkspaceBinding) -> AgentResult<FileCommitHost> {
                if *binding != self.binding {
                    return Err(AgentError::new(ErrorCode::WorkspaceChanged, "reopened"));
                }
                Ok(FileCommitHost::for_test(
                    self.binding.clone(),
                    self.paths.clone(),
                    None,
                    self.fence.clone(),
                ))
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let (metadata, paths) = create_workspace(&root, "password").unwrap();
        let mut db = crate::db::Database::open(&paths.db_path, &root, None).unwrap();
        db.bind_native_workspace(&metadata.workspace_id).unwrap();
        let project = db
            .project_create(ProjectCreateInput {
                name: "History".into(),
                summary: None,
                status: None,
            })
            .unwrap();
        let live = std::path::Path::new(&project.root_path).join("live.bin");
        std::fs::write(&live, [0, 255, 1]).unwrap();
        let first = db
            .project_file_register(&metadata.workspace_id, project.id, "live.bin")
            .unwrap();
        std::fs::write(&live, [2, 128, 0]).unwrap();
        let second = db.project_file_resolve(&first.object).unwrap();
        let history = db
            .document_list_versions(DocumentListVersionsInput {
                document_id: first.object.id.parse().unwrap(),
            })
            .unwrap();
        let old = history
            .iter()
            .find(|version| version.version_number == 1)
            .unwrap();
        let input = crate::file_version_restore::FileVersionRestore {
            object: first.object.clone(),
            version_id: old.id.to_string(),
            expected_version_number: 2,
            expected_content_hash: second.content_hash.unwrap(),
        };
        let binding = WorkspaceBinding {
            workspace_id: metadata.workspace_id,
            generation: "opened".into(),
        };
        let request = RequestContext {
            binding: binding.clone(),
            caller: Caller::Gui,
            request_id: "gui-restore".into(),
            scope_grant: ScopeGrant {
                object_keys: None,
                workspace_id: binding.workspace_id.clone(),
                workspace_content: false,
                project_ids: vec![project.id],
                operations: vec!["source.read".into(), "file.restore".into()],
            },
        };
        let store = Store {
            db,
            binding,
            paths,
            fence: std::sync::Arc::new(WorkspaceCommitFence::new()),
        };
        assert_eq!(
            restore_gui_file_history(&store, &request, &input)
                .unwrap()
                .receipt
                .version_number,
            3
        );
        assert_eq!(std::fs::read(&live).unwrap(), [0, 255, 1]);
        assert_eq!(std::fs::read(&old.managed_path).unwrap(), [0, 255, 1]);
        assert_eq!(
            restore_gui_file_history(&store, &request, &input)
                .unwrap()
                .receipt
                .version_number,
            3
        );
    }
    #[test]
    fn file_read_envelopes_reject_paths_authority_and_missing_fixed_versions() {
        let input = json!({"binding":{"workspaceId":"workspace","generation":"one"},"requestId":"read","data":{"object":{"workspaceId":"workspace","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},"versionNumber":1}});
        assert!(
            serde_json::from_value::<FileReadCommandInput<FileSourceReadInput>>(input.clone())
                .is_ok()
        );
        for field in ["caller", "scopeGrant", "path"] {
            let mut forged = input.clone();
            forged[field] = json!("forged");
            assert!(
                serde_json::from_value::<FileReadCommandInput<FileSourceReadInput>>(forged)
                    .is_err()
            );
            let mut forged = input.clone();
            forged["data"][field] = json!("forged");
            assert!(
                serde_json::from_value::<FileReadCommandInput<FileSourceReadInput>>(forged)
                    .is_err()
            );
        }
        let mut missing = input;
        missing["data"]
            .as_object_mut()
            .unwrap()
            .remove("versionNumber");
        assert!(
            serde_json::from_value::<FileReadCommandInput<FileSourceReadInput>>(missing).is_err()
        );
    }
}
