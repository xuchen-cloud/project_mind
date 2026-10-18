//! Local GUI authority comes from the native Workspace and actual File owner.
use crate::{
    agent::{
        errors::{AgentError, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    file_office::{
        gui_request, FileOfficeEditInput, FileOfficeInput, FileOfficeInspection,
        FileOfficeRecalculateInput, FileOfficeSaved, FileOfficeService,
    },
    office_worker::{AppOfficeUtility, OfficeRecalculationResult},
    AppState,
};
use serde::Deserialize;
use tauri::{Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfficeCommandInput<T> {
    binding: WorkspaceBinding,
    request_id: String,
    data: T,
}

#[tauri::command]
pub(crate) async fn file_office_inspect(
    state: State<'_, AppState>,
    input: OfficeCommandInput<FileOfficeInput>,
) -> Result<ApiResponse<FileOfficeInspection>, String> {
    let id = input.request_id.clone();
    let app = state.app_handle.clone();
    let handle = tokio::runtime::Handle::current();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let request = gui_request(
            &*state,
            &input.binding,
            &input.request_id,
            &input.data.object,
            false,
        )?;
        handle.block_on(
            FileOfficeService::new(&*state, &AppOfficeUtility(app.clone()))
                .inspect(&request, &input.data),
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(
            ErrorCode::IoFailed,
            "Office inspection task failed",
        ))
    });
    Ok(ApiResponse::from_result(id, result))
}
#[tauri::command]
pub(crate) async fn file_office_recalculate(
    state: State<'_, AppState>,
    input: OfficeCommandInput<FileOfficeRecalculateInput>,
) -> Result<ApiResponse<OfficeRecalculationResult>, String> {
    let id = input.request_id.clone();
    let app = state.app_handle.clone();
    let handle = tokio::runtime::Handle::current();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let request = gui_request(
            &*state,
            &input.binding,
            &input.request_id,
            &input.data.object,
            false,
        )?;
        handle.block_on(
            FileOfficeService::new(&*state, &AppOfficeUtility(app.clone()))
                .recalculate(&request, &input.data),
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(
            ErrorCode::IoFailed,
            "Office recalculation task failed",
        ))
    });
    Ok(ApiResponse::from_result(id, result))
}
#[tauri::command]
pub(crate) async fn file_office_save(
    state: State<'_, AppState>,
    input: OfficeCommandInput<FileOfficeEditInput>,
) -> Result<ApiResponse<FileOfficeSaved>, String> {
    let id = input.request_id.clone();
    let app = state.app_handle.clone();
    let handle = tokio::runtime::Handle::current();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let request = gui_request(
            &*state,
            &input.binding,
            &input.request_id,
            &input.data.object,
            true,
        )?;
        handle.block_on(
            FileOfficeService::new(&*state, &AppOfficeUtility(app.clone()))
                .save(&request, &input.data),
        )
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(
            ErrorCode::IoFailed,
            "Office save task failed",
        ))
    });
    Ok(ApiResponse::from_result(id, result))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn office_gui_input_cannot_mint_authority_or_paths() {
        let baseline = json!({"object":{"workspaceId":"w","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},"versionNumber":1,"expectedContentHash":format!("sha256:{}","a".repeat(64))});
        let input = json!({"binding":{"workspaceId":"w","generation":"one"},"requestId":"read","data":baseline});
        assert!(
            serde_json::from_value::<OfficeCommandInput<FileOfficeInput>>(input.clone()).is_ok()
        );
        for key in ["caller", "scopeGrant", "path"] {
            let mut forged = input.clone();
            forged[key] = json!("forged");
            assert!(serde_json::from_value::<OfficeCommandInput<FileOfficeInput>>(forged).is_err());
            let mut forged = input.clone();
            forged["data"][key] = json!("forged");
            assert!(serde_json::from_value::<OfficeCommandInput<FileOfficeInput>>(forged).is_err());
        }
        let mut historical = input;
        historical["data"]
            .as_object_mut()
            .unwrap()
            .remove("versionNumber");
        assert!(serde_json::from_value::<OfficeCommandInput<FileOfficeInput>>(historical).is_err());
    }

    #[test]
    fn office_recalculate_dto_rejects_paths_capabilities_and_unknown_nested_fields() {
        let input = json!({"binding":{"workspaceId":"w","generation":"open"},"requestId":"calculate",
            "data":{"object":{"workspaceId":"w","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},
                "versionNumber":1,"expectedContentHash":format!("sha256:{}","a".repeat(64)),
                "recalculation":{"edits":[{"sheetId":"s","row":0,"column":0,"input":"=1+1"}],
                    "reads":[{"sheetId":"s","range":{"startRow":0,"endRow":0,"startColumn":0,"endColumn":0}}]}}});
        assert!(
            serde_json::from_value::<OfficeCommandInput<FileOfficeRecalculateInput>>(input.clone())
                .is_ok()
        );
        for pointer in [
            "",
            "/data",
            "/data/recalculation",
            "/data/recalculation/edits/0",
            "/data/recalculation/reads/0",
            "/data/recalculation/reads/0/range",
        ] {
            for field in [
                "path",
                "sessionId",
                "credentials",
                "scopeGrant",
                "unexpected",
            ] {
                let mut forged = input.clone();
                forged
                    .pointer_mut(pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert(field.into(), json!("forged"));
                assert!(
                    serde_json::from_value::<OfficeCommandInput<FileOfficeRecalculateInput>>(
                        forged
                    )
                    .is_err(),
                    "{pointer}/{field}"
                );
            }
        }
        for value in [json!(-1), json!(1.5), json!("0")] {
            let mut invalid = input.clone();
            invalid["data"]["recalculation"]["edits"][0]["row"] = value;
            assert!(
                serde_json::from_value::<OfficeCommandInput<FileOfficeRecalculateInput>>(invalid)
                    .is_err()
            );
        }
    }
}
