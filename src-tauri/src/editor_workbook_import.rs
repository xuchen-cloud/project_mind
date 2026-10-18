//! Read-only inspection of bytes selected for the upstream workbook merge UI.
//! This boundary has no File identity, source path, or mutation capability.
use crate::office_worker::{AppOfficeUtility, OfficePayload, OfficeUtility};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkbookImportInput {
    base64: String,
}

pub(crate) async fn inspect_imported<W: OfficeUtility>(
    caller: &str,
    worker: &W,
    input: WorkbookImportInput,
) -> Result<Value, String> {
    let project = caller.strip_prefix("project-").is_some_and(|id| {
        !id.is_empty()
            && id.bytes().all(|c| c.is_ascii_digit())
            && id.parse::<i64>().is_ok_and(|id| id > 0)
    });
    if caller != "main" && !project {
        return Err("当前窗口不能导入工作簿".into());
    }
    // OfficeUtility validates canonical base64 and the shared 100 MiB input
    // budget before launching its restricted process. No source path crosses it.
    let result = worker
        .request(
            &format!("workbook-import:{:032x}", rand::random::<u128>()),
            "office.inspect",
            "xlsx",
            &input.base64,
            OfficePayload::Inspect,
        )
        .await
        .map_err(|error| error.message)?;
    result
        .get("model")
        .cloned()
        .ok_or_else(|| "工作簿导入没有返回内容".into())
}

#[tauri::command]
pub(crate) async fn desktop_inspect_imported_workbook(
    app: tauri::AppHandle,
    window: tauri::Window,
    input: WorkbookImportInput,
) -> Result<Value, String> {
    inspect_imported(window.label(), &AppOfficeUtility(app), input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
    use serde_json::json;
    use std::sync::Mutex;

    struct Worker {
        calls: Mutex<Vec<(String, String, String)>>,
        failed: bool,
    }
    impl OfficeUtility for Worker {
        async fn request(
            &self,
            request_id: &str,
            method: &str,
            format: &str,
            base64: &str,
            payload: OfficePayload<'_>,
        ) -> AgentResult<Value> {
            assert!(!request_id.is_empty());
            assert!(matches!(payload, OfficePayload::Inspect));
            self.calls
                .lock()
                .unwrap()
                .push((method.into(), format.into(), base64.into()));
            if self.failed {
                Err(AgentError::new(
                    ErrorCode::SourceNotReady,
                    "选中的工作簿无法读取",
                ))
            } else {
                Ok(
                    json!({"model":{"format":"xlsx","name":"workbook.xlsx","rendererData":{"file":{"sessionId":"source-only"}}}}),
                )
            }
        }
    }
    fn worker(failed: bool) -> Worker {
        Worker {
            calls: Mutex::new(vec![]),
            failed,
        }
    }
    fn input() -> WorkbookImportInput {
        WorkbookImportInput {
            base64: "UEsDBA==".into(),
        }
    }

    #[tokio::test]
    async fn selected_bytes_use_the_fixed_read_only_xlsx_utility() {
        let worker = worker(false);
        let result = inspect_imported("main", &worker, input()).await.unwrap();
        assert_eq!(result["rendererData"]["file"]["sessionId"], "source-only");
        assert_eq!(
            *worker.calls.lock().unwrap(),
            vec![("office.inspect".into(), "xlsx".into(), "UEsDBA==".into())]
        );
        inspect_imported("project-4", &worker, input())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn utility_failure_reaches_the_merge_ui_without_empty_workbook_fallback() {
        let worker = worker(true);
        assert_eq!(
            inspect_imported("main", &worker, input())
                .await
                .unwrap_err(),
            "选中的工作簿无法读取"
        );
    }

    #[tokio::test]
    async fn document_and_other_windows_cannot_start_imports() {
        let worker = worker(false);
        for caller in [
            "editor-print-random",
            "voice-caption",
            "project-0",
            "project--1",
            "project-4/popup",
            "",
        ] {
            assert!(
                inspect_imported(caller, &worker, input()).await.is_err(),
                "{caller}"
            );
        }
        assert!(worker.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn wire_input_accepts_only_bytes() {
        assert!(
            serde_json::from_value::<WorkbookImportInput>(json!({"base64":"UEsDBA=="})).is_ok()
        );
        for key in [
            "path",
            "format",
            "caller",
            "binding",
            "object",
            "edits",
            "sessionId",
        ] {
            let mut input = json!({"base64":"UEsDBA=="});
            input[key] = json!("forged");
            assert!(
                serde_json::from_value::<WorkbookImportInput>(input).is_err(),
                "{key}"
            );
        }
    }
}
