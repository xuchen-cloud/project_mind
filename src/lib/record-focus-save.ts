export const PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-project-record-focus-save-request";

export interface ProjectRecordFocusSaveRequestDetail {
  projectId: number;
  noteId: number;
  respond: (submitted: boolean) => void;
}

export type ProjectRecordFocusSaveResult = "submitted" | "failed" | "unhandled";

export function requestProjectRecordFocusSave(input: {
  projectId: number;
  noteId: number;
}): ProjectRecordFocusSaveResult {
  let result: ProjectRecordFocusSaveResult = "unhandled";
  window.dispatchEvent(
    new CustomEvent<ProjectRecordFocusSaveRequestDetail>(
      PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
      {
        detail: {
          projectId: input.projectId,
          noteId: input.noteId,
          respond: (submitted) => {
            result = submitted ? "submitted" : "failed";
          },
        },
      },
    ),
  );
  return result;
}
