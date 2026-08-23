export const PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-project-record-focus-save-request";

export interface ProjectRecordFocusSaveRequestDetail {
  projectId: number;
  recordId: number;
  respond: (submitted: boolean) => void;
}

export type ProjectRecordFocusSaveResult = "submitted" | "failed" | "unhandled";

export function requestProjectRecordFocusSave(input: {
  projectId: number;
  recordId: number;
}): ProjectRecordFocusSaveResult {
  let result: ProjectRecordFocusSaveResult = "unhandled";
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
