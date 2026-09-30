/** Completion feedback: readable checked state, then a short rightward exit. */
export const TODO_COMPLETION_HOLD_MS = 320;
export const TODO_COMPLETION_EXIT_MS = 240;
export const TODO_LAYOUT_DURATION_MS = 220;
export const TODO_MOTION_EASING = "cubic-bezier(0.23, 1, 0.32, 1)";

export function waitForTodoCompletion() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, TODO_COMPLETION_HOLD_MS + TODO_COMPLETION_EXIT_MS);
  });
}
