import type { TodoPriority } from "./types";

export type TodoPriorityTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface TodoPriorityMeta {
  value: TodoPriority;
  code: "P1" | "P2" | "P3" | "P4";
  label: string;
  tone: TodoPriorityTone;
  colorValue: string;
  order: number;
}

export const TODO_PRIORITY_META: TodoPriorityMeta[] = [
  {
    value: "urgent_important",
    code: "P1",
    label: "紧急且重要",
    tone: "danger",
    colorValue: "var(--color-danger)",
    order: 0,
  },
  {
    value: "urgent_not_important",
    code: "P2",
    label: "紧急但不重要",
    tone: "warning",
    colorValue: "var(--color-warning)",
    order: 1,
  },
  {
    value: "not_urgent_important",
    code: "P3",
    label: "不紧急但重要",
    tone: "accent",
    colorValue: "var(--color-accent)",
    order: 2,
  },
  {
    value: "not_urgent_not_important",
    code: "P4",
    label: "不紧急且不重要",
    tone: "neutral",
    colorValue: "var(--color-text-muted)",
    order: 3,
  },
] as const;

const TODO_PRIORITY_META_BY_VALUE = new Map(
  TODO_PRIORITY_META.map((item) => [item.value, item] satisfies [TodoPriority, TodoPriorityMeta]),
);

export function todoPriorityMeta(priority: TodoPriority) {
  return TODO_PRIORITY_META_BY_VALUE.get(priority) ?? TODO_PRIORITY_META[0];
}

export function todoPriorityCode(priority: TodoPriority) {
  return todoPriorityMeta(priority).code;
}

export function todoPriorityLabel(priority: TodoPriority) {
  return todoPriorityMeta(priority).label;
}

export function todoPriorityOptionLabel(priority: TodoPriority) {
  const meta = todoPriorityMeta(priority);
  return `${meta.code} · ${meta.label}`;
}

export function todoPriorityTone(priority: TodoPriority) {
  return todoPriorityMeta(priority).tone;
}

export function todoPriorityColorValue(priority: TodoPriority) {
  return todoPriorityMeta(priority).colorValue;
}

export function todoPriorityOrder(priority: TodoPriority) {
  return todoPriorityMeta(priority).order;
}
