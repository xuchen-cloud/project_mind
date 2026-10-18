use crate::{
    agent::{
        errors::{AgentError, ApiResponse, ErrorCode},
        models::WorkspaceBinding,
    },
    file_office::gui_request,
    file_text::{self, FileTextSaveInput},
    file_version_service::FileVersionCommitResult,
    AppState,
};
use serde::Deserialize;
use tauri::{Manager, State};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextCommandInput {
    binding: WorkspaceBinding,
    request_id: String,
    data: FileTextSaveInput,
}
#[tauri::command]
pub(crate) async fn file_text_save(
    state: State<'_, AppState>,
    input: TextCommandInput,
) -> Result<ApiResponse<FileVersionCommitResult>, String> {
    let id = input.request_id.clone();
    let app = state.app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let request = gui_request(
            &*state,
            &input.binding,
            &input.request_id,
            &input.data.object,
            true,
        )?;
        file_text::save(&*state, &request, &input.data)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AgentError::new(
            ErrorCode::IoFailed,
            "Markdown save task failed",
        ))
    });
    Ok(ApiResponse::from_result(id, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn text_command_accepts_only_fixed_file_source_and_server_owned_authority() {
        let input = json!({"binding":{"workspaceId":"w","generation":"g"},"requestId":"save","data":{"object":{"workspaceId":"w","scope":{"kind":"project","projectId":1},"kind":"file","id":"2"},"versionNumber":1,"expectedContentHash":format!("sha256:{}","a".repeat(64)),"text":"# Markdown"}});
        assert!(serde_json::from_value::<TextCommandInput>(input.clone()).is_ok());
        for key in ["caller", "scopeGrant", "path"] {
            let mut forged = input.clone();
            forged[key] = json!("forged");
            assert!(serde_json::from_value::<TextCommandInput>(forged).is_err());
            let mut forged = input.clone();
            forged["data"][key] = json!("forged");
            assert!(serde_json::from_value::<TextCommandInput>(forged).is_err());
        }
    }
}
