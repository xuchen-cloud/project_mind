export const PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-project-record-focus-save-request";
export const WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-workspace-record-focus-save-request";

export interface ProjectRecordFocusSaveRequestDetail {
  projectId: number;
  recordId: number;
  respond: (submitted: boolean | "not_needed") => void;
}

export type RecordFocusSaveResult = "submitted" | "not_needed" | "failed" | "unhandled";

// A page with no loaded draft has nothing to capture before navigation.
// A failed or missing response still protects an existing editor's content.
export function canLeaveRecordFocus(result: RecordFocusSaveResult): boolean {
  return result === "submitted" || result === "not_needed";
}

export interface WorkspaceRecordFocusSaveRequestDetail {
  recordId: number;
  respond: (submitted: boolean | "not_needed") => void;
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
            result = submitted === "not_needed" ? "not_needed" : submitted ? "submitted" : "failed";
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
            result = submitted === "not_needed" ? "not_needed" : submitted ? "submitted" : "failed";
          },
        },
      },
    ),
  );
  return result;
}
