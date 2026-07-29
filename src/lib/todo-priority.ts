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
    colorValue: "var(--color-todo-p1)",
    order: 0,
  },
  {
    value: "urgent_not_important",
    code: "P2",
    label: "紧急但不重要",
    tone: "warning",
    colorValue: "var(--color-todo-p2)",
    order: 1,
  },
  {
    value: "not_urgent_important",
    code: "P3",
    label: "不紧急但重要",
    tone: "accent",
    colorValue: "var(--color-todo-p3)",
    order: 2,
  },
  {
    value: "not_urgent_not_important",
    code: "P4",
    label: "不紧急且不重要",
    tone: "neutral",
    colorValue: "var(--color-todo-p4)",
    order: 3,
  },
] as const;

export const DEFAULT_TODO_PRIORITY: TodoPriority = "not_urgent_important";

const TODO_PRIORITY_VALUES = new Set<TodoPriority>(
  TODO_PRIORITY_META.map((item) => item.value),
);

const TODO_URGENCY_KEYWORDS = [
  "今天",
  "今日",
  "当天",
  "明天",
  "本周",
  "周内",
  "周五前",
  "尽快",
  "尽早",
  "立即",
  "马上",
  "立刻",
  "紧急",
  "加急",
  "asap",
  "urgent",
  "immediately",
  "today",
  "tomorrow",
] as const;

const TODO_IMPORTANCE_KEYWORDS = [
  "预算",
  "合同",
  "法务",
  "审批",
  "客户",
  "上线",
  "发布",
  "交付",
  "回款",
  "付款",
  "风险",
  "合规",
  "方案",
  "决策",
  "评审",
  "blocking",
  "blocker",
  "launch",
  "release",
  "legal",
  "finance",
] as const;

const TODO_PRIORITY_META_BY_VALUE = new Map(
  TODO_PRIORITY_META.map((item) => [item.value, item] satisfies [TodoPriority, TodoPriorityMeta]),
);

export function isTodoPriority(value: string | null | undefined): value is TodoPriority {
  return value ? TODO_PRIORITY_VALUES.has(value as TodoPriority) : false;
}

export function inferTodoPriorityFromText(text: string): TodoPriority {
  const normalized = text.trim().toLowerCase();
  const hasUrgency = TODO_URGENCY_KEYWORDS.some((keyword) => normalized.includes(keyword));
  const hasImportance = TODO_IMPORTANCE_KEYWORDS.some((keyword) => normalized.includes(keyword));

  if (hasUrgency && hasImportance) {
    return "urgent_important";
  }
  if (hasUrgency) {
    return "urgent_not_important";
  }
  if (hasImportance) {
    return "not_urgent_important";
  }
  return "not_urgent_not_important";
}

export function resolveSuggestedTodoPriority(
  text: string,
  rawPriority?: string | null,
): TodoPriority {
  if (isTodoPriority(rawPriority)) {
    return rawPriority;
  }
  return inferTodoPriorityFromText(text) ?? DEFAULT_TODO_PRIORITY;
}

export function todoPriorityMeta(priority: TodoPriority) {
  return TODO_PRIORITY_META_BY_VALUE.get(priority) ?? TODO_PRIORITY_META[2];
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
