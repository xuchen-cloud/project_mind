import type { TodoPriority, TodoProgressRecord, TodoRecord } from "../../lib/types";

export type TodoSortMode = "time" | "priority";

export const TODO_PRIORITY_OPTIONS: Array<{ value: TodoPriority; label: string }> = [
  { value: "urgent_important", label: "紧急且重要" },
  { value: "urgent_not_important", label: "紧急但不重要" },
  { value: "not_urgent_important", label: "不紧急但重要" },
  { value: "not_urgent_not_important", label: "不紧急且不重要" },
];

const TODO_PRIORITY_ORDER: Record<TodoPriority, number> = {
  urgent_important: 0,
  urgent_not_important: 1,
  not_urgent_important: 2,
  not_urgent_not_important: 3,
};

export function priorityLabel(priority: TodoPriority) {
  return TODO_PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? priority;
}

export function latestTodoProgress(todo: TodoRecord): TodoProgressRecord | null {
  return todo.progresses[0] ?? null;
}

export function sortTodoProgresses(progresses: TodoProgressRecord[]) {
  return [...progresses].sort((left, right) => {
    const dateDelta =
      new Date(right.progressDate).getTime() - new Date(left.progressDate).getTime();
    if (dateDelta !== 0) {
      return dateDelta;
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

export function sortTodos(todos: TodoRecord[], mode: TodoSortMode) {
  return [...todos].sort((left, right) => {
    if (mode === "priority") {
      const priorityDelta =
        TODO_PRIORITY_ORDER[left.priority] - TODO_PRIORITY_ORDER[right.priority];
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

export function resolveTodoSource(
  activityId: number | null | undefined,
  activityNameById: ReadonlyMap<number, string>,
) {
  if (!activityId) {
    return "项目级";
  }
  return activityNameById.get(activityId) ?? "关联 Activity 已删除";
}

export function formatMonthDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatFullDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidCalendarDate(year: number, month: number, day: number) {
  const candidate = new Date(year, month - 1, day);
  return (
    candidate.getFullYear() === year &&
    candidate.getMonth() === month - 1 &&
    candidate.getDate() === day
  );
}

export function parseProgressInput(input: string, now = new Date()) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false as const, error: "进展内容不能为空。" };
  }

  const match = trimmed.match(/^@(\d{2})(\d{2})(?:\s+|$)(.*)$/u);
  if (!match) {
    return {
      ok: true as const,
      progressDate: formatLocalDate(now),
      content: trimmed,
    };
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = now.getFullYear();
  const content = match[3]?.trim() ?? "";

  if (!isValidCalendarDate(year, month, day)) {
    return { ok: false as const, error: "日期格式无效，请使用开头的 @MMDD，例如 @0315。" };
  }

  if (!content) {
    return { ok: false as const, error: "日期后还需要填写进展内容。" };
  }

  return {
    ok: true as const,
    progressDate: `${year}-${`${month}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`,
    content,
  };
}
