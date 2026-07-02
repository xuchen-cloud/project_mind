export const PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT =
  "project-mind-project-record-focus-save-request";

export interface ProjectRecordFocusSaveRequestDetail {
  projectId: number;
  noteId: number;
  respond: (saved: boolean | Promise<boolean>) => void;
}

export type ProjectRecordFocusSaveResult = "saved" | "failed" | "unhandled";

export function requestProjectRecordFocusSave(input: {
  projectId: number;
  noteId: number;
}): Promise<ProjectRecordFocusSaveResult> {
  return new Promise((resolve) => {
    let settled = false;
    let handled = false;

    const settle = (result: ProjectRecordFocusSaveResult) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    window.dispatchEvent(
      new CustomEvent<ProjectRecordFocusSaveRequestDetail>(
        PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
        {
          detail: {
            projectId: input.projectId,
            noteId: input.noteId,
            respond: (saved) => {
              handled = true;
              void Promise.resolve(saved)
                .then((ok) => settle(ok ? "saved" : "failed"))
                .catch(() => settle("failed"));
            },
          },
        },
      ),
    );

    window.setTimeout(() => {
      if (!handled) {
        settle("unhandled");
      }
    }, 0);
  });
}
