import type { TodoPriority } from "../../lib/types";

export interface TodoComposerDraftSnapshot {
  content: string;
  priority: TodoPriority;
  projectId?: number | null;
}

const DEFAULT_TODO_PRIORITY: TodoPriority = "not_urgent_important";
const TODO_COMPOSER_DRAFT_STORAGE_PREFIX = "project-mind:todo-rail-draft:";

export function buildTodoComposerDraftStorageKey(projectId?: number) {
  return `${TODO_COMPOSER_DRAFT_STORAGE_PREFIX}${projectId ?? "workspace"}`;
}

export function readTodoComposerDraft(
  storageKey: string,
): TodoComposerDraftSnapshot | null {
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<TodoComposerDraftSnapshot>;
    const content = typeof parsed.content === "string" ? parsed.content : "";
    const priority = isTodoPriority(parsed.priority)
      ? parsed.priority
      : DEFAULT_TODO_PRIORITY;
    const projectId =
      typeof parsed.projectId === "number" ? parsed.projectId : null;

    if (
      !content.trim() &&
      priority === DEFAULT_TODO_PRIORITY &&
      projectId === null
    ) {
      return null;
    }

    return { content, priority, projectId };
  } catch {
    return null;
  }
}

export function writeTodoComposerDraft(
  storageKey: string,
  snapshot: TodoComposerDraftSnapshot,
) {
  try {
    if (
      !snapshot.content.trim() &&
      snapshot.priority === DEFAULT_TODO_PRIORITY &&
      snapshot.projectId == null
    ) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Draft persistence is best-effort and should never block Todo editing.
  }
}

export function clearTodoComposerDraft(storageKey: string) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore storage errors; clearing is best-effort.
  }
}

export function clearAllTodoComposerDrafts() {
  try {
    const draftKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index),
    ).filter((key): key is string => key?.startsWith(TODO_COMPOSER_DRAFT_STORAGE_PREFIX) === true);

    for (const key of draftKeys) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Workspace switching must continue even when localStorage is unavailable.
  }
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return (
    value === "urgent_important" ||
    value === "urgent_not_important" ||
    value === "not_urgent_important" ||
    value === "not_urgent_not_important"
  );
}
