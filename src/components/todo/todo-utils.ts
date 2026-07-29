import {
  TODO_PRIORITY_META,
  todoPriorityColorValue,
  todoPriorityCode,
  todoPriorityLabel,
  todoPriorityOptionLabel,
  todoPriorityOrder,
  todoPriorityTone,
} from "../../lib/todo-priority";
import type { TodoPriority, TodoProgressRecord, TodoRecord } from "../../lib/types";

export type TodoSortMode = "time" | "priority";

export const TODO_PRIORITY_OPTIONS = TODO_PRIORITY_META.map((meta) => ({
  value: meta.value,
  code: meta.code,
  label: meta.label,
  optionLabel: todoPriorityOptionLabel(meta.value),
  colorValue: meta.colorValue,
}));

export function priorityLabel(priority: TodoPriority) {
  return todoPriorityLabel(priority);
}

export function priorityCode(priority: TodoPriority) {
  return todoPriorityCode(priority);
}

export function priorityOptionLabel(priority: TodoPriority) {
  return todoPriorityOptionLabel(priority);
}

export function priorityTone(priority: TodoPriority) {
  return todoPriorityTone(priority);
}

export function priorityColorValue(priority: TodoPriority) {
  return todoPriorityColorValue(priority);
}

export function latestTodoProgress(todo: TodoRecord): TodoProgressRecord | null {
  return sortTodoProgresses(todo.progresses).find((progress) => progress.status !== "finished") ?? null;
}

export function sortTodoProgresses(progresses: TodoProgressRecord[]) {
  return [...progresses].sort((left, right) => {
    const leftFinished = left.status === "finished";
    const rightFinished = right.status === "finished";
    if (leftFinished !== rightFinished) {
      return leftFinished ? 1 : -1;
    }
    const orderDelta = (left.orderIndex ?? 0) - (right.orderIndex ?? 0);
    if (orderDelta !== 0) {
      return orderDelta;
    }
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
      const priorityDelta = todoPriorityOrder(left.priority) - todoPriorityOrder(right.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
    }
    const createdDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return right.id - left.id;
  });
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

export function parseProgressInput(
  input: string,
  now = new Date(),
  fallbackDate?: string,
  fallbackDueDate?: string | null,
) {
  const parsed = parseDueDateInput(input, now, fallbackDueDate);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ...parsed,
    progressDate: fallbackDate ?? formatLocalDate(now),
  };
}

export function parseDueDateInput(
  input: string,
  now = new Date(),
  fallbackDueDate?: string | null,
) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false as const, error: "内容不能为空。" };
  }

  const match = trimmed.match(/@(\d+)(?=\s|$)/u);
  if (!match) {
    return {
      ok: true as const,
      dueDate: fallbackDueDate ?? null,
      content: trimmed,
    };
  }

  const dateDigits = match[1];
  if (dateDigits.length !== 4 && dateDigits.length !== 8) {
    return {
      ok: false as const,
      error: "日期格式无效，请使用 @MMDD 或 @YYYYMMDD，例如 @0315 或 @20270315。",
    };
  }

  const hasExplicitYear = dateDigits.length === 8;
  const year = hasExplicitYear ? Number(dateDigits.slice(0, 4)) : now.getFullYear();
  const month = Number(dateDigits.slice(hasExplicitYear ? 4 : 0, hasExplicitYear ? 6 : 2));
  const day = Number(dateDigits.slice(hasExplicitYear ? 6 : 2));
  const matchIndex = match.index ?? 0;
  const content = `${trimmed.slice(0, matchIndex)}${trimmed.slice(matchIndex + match[0].length)}`
    .trim()
    .replace(/\s{2,}/gu, " ");

  if (!isValidCalendarDate(year, month, day)) {
    return {
      ok: false as const,
      error: "日期格式无效，请使用 @MMDD 或 @YYYYMMDD，例如 @0315 或 @20270315。",
    };
  }

  if (!content) {
    return { ok: false as const, error: "日期后还需要填写进展内容。" };
  }

  return {
    ok: true as const,
    dueDate: `${year}-${`${month}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`,
    content,
  };
}
