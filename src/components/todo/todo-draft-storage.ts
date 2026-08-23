import type { TodoPriority } from "../../lib/types";

export interface TodoComposerSubtaskDraft {
  content: string;
  progressDate: string;
  dueDate?: string | null;
}

export interface TodoComposerDraftSnapshot {
  content: string;
  priority: TodoPriority;
  projectId?: number | null;
  tagIds?: number[];
  subtasks?: TodoComposerSubtaskDraft[];
  creationOutcome?: "created" | "unknown" | null;
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

    const parsed = JSON.parse(rawValue) as Partial<TodoComposerDraftSnapshot> & {
      createdTodoId?: unknown;
    };
    const content = typeof parsed.content === "string" ? parsed.content : "";
    const priority = isTodoPriority(parsed.priority)
      ? parsed.priority
      : DEFAULT_TODO_PRIORITY;
    const projectId =
      typeof parsed.projectId === "number" ? parsed.projectId : null;
    const tagIds = Array.isArray(parsed.tagIds)
      ? [...new Set(parsed.tagIds.filter((tagId): tagId is number =>
          typeof tagId === "number" && Number.isSafeInteger(tagId) && tagId > 0,
        ))]
      : [];
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks.flatMap((candidate) => {
          if (!isSubtaskDraft(candidate)) return [];
          return [{
            content: candidate.content.trim(),
            progressDate: candidate.progressDate,
            ...(candidate.dueDate ? { dueDate: candidate.dueDate } : {}),
          }];
        })
      : [];
    const creationOutcome =
      parsed.creationOutcome === "created"
        ? "created"
        : parsed.creationOutcome === "unknown" ||
            parsed.createdTodoId === "unknown" ||
            (typeof parsed.createdTodoId === "number" &&
              Number.isSafeInteger(parsed.createdTodoId) &&
              parsed.createdTodoId > 0)
          ? "unknown"
          : null;

    if (
      !content.trim() &&
      priority === DEFAULT_TODO_PRIORITY &&
      projectId === null &&
      tagIds.length === 0 &&
      subtasks.length === 0 &&
      creationOutcome === null
    ) {
      return null;
    }

    return { content, priority, projectId, tagIds, subtasks, creationOutcome };
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
      snapshot.projectId == null &&
      (snapshot.tagIds?.length ?? 0) === 0 &&
      (snapshot.subtasks?.length ?? 0) === 0 &&
      snapshot.creationOutcome == null
    ) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Draft persistence is best-effort and should never block Todo editing.
  }
}

function isSubtaskDraft(value: unknown): value is TodoComposerSubtaskDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TodoComposerSubtaskDraft>;
  return (
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    typeof candidate.progressDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(candidate.progressDate) &&
    (candidate.dueDate == null ||
      (typeof candidate.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(candidate.dueDate)))
  );
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
