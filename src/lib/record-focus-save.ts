export const PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-project-record-focus-save-request";
export const WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-workspace-record-focus-save-request";

export interface ProjectRecordFocusSaveRequestDetail {
  projectId: number;
  recordId: number;
  respond: (submitted: boolean) => void;
}

export type RecordFocusSaveResult = "submitted" | "failed" | "unhandled";

export interface WorkspaceRecordFocusSaveRequestDetail {
  recordId: number;
  respond: (submitted: boolean) => void;
}

export function requestProjectRecordFocusSave(input: {
  projectId: number;
  recordId: number;
}): RecordFocusSaveResult {
  let result: RecordFocusSaveResult = "unhandled";
  window.dispatchEvent(
    new CustomEvent<ProjectRecordFocusSaveRequestDetail>(
      PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
      {
        detail: {
          projectId: input.projectId,
          recordId: input.recordId,
          respond: (submitted) => {
            result = submitted ? "submitted" : "failed";
          },
        },
      },
    ),
  );
  return result;
}

export function requestWorkspaceRecordFocusSave(input: {
  recordId: number;
}): RecordFocusSaveResult {
  let result: RecordFocusSaveResult = "unhandled";
  window.dispatchEvent(
    new CustomEvent<WorkspaceRecordFocusSaveRequestDetail>(
      WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT,
      {
        detail: {
          recordId: input.recordId,
          respond: (submitted) => {
            result = submitted ? "submitted" : "failed";
          },
        },
      },
    ),
  );
  return result;
}
