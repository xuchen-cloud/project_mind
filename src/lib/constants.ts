import type { TagColorKey } from "./types";
import { TODO_PRIORITY_META, todoPriorityLabel } from "./todo-priority";

export const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂缓" },
  { value: "completed", label: "已完成" },
] as const;

export const TODO_STATUS_OPTIONS = [
  { value: "unfinished", label: "未完成" },
  { value: "finished", label: "已完成" },
] as const;

export const TODO_PRIORITY_OPTIONS = TODO_PRIORITY_META.map((meta) => ({
  value: meta.value,
  label: meta.label,
})) as Array<{ value: string; label: string }>;

export const AI_PROVIDER_FAMILY_OPTIONS = [
  {
    value: "openai_compatible",
    label: "OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
  },
  {
    value: "anthropic_compatible",
    label: "Claude-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-0",
  },
  {
    value: "gemini_compatible",
    label: "Gemini-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
  },
] as const;

export const AI_CAPABILITY_OPTIONS = [
  { value: "default", label: "通用默认模型" },
  { value: "image_default", label: "图片默认模型" },
] as const;

export const FILE_TAG_COLOR_OPTIONS: Array<{
  value: TagColorKey;
  label: string;
  colorValue: string;
}> = [
  { value: "slate", label: "Slate", colorValue: "var(--color-file-tag-slate)" },
  { value: "blue", label: "Blue", colorValue: "var(--color-file-tag-blue)" },
  { value: "teal", label: "Teal", colorValue: "var(--color-file-tag-teal)" },
  { value: "green", label: "Green", colorValue: "var(--color-file-tag-green)" },
  { value: "amber", label: "Amber", colorValue: "var(--color-file-tag-amber)" },
  { value: "orange", label: "Orange", colorValue: "var(--color-file-tag-orange)" },
  { value: "red", label: "Red", colorValue: "var(--color-file-tag-red)" },
  { value: "rose", label: "Rose", colorValue: "var(--color-file-tag-rose)" },
];

export function todoStatusLabel(value: string) {
  return TODO_STATUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function priorityLabel(value: string) {
  return todoPriorityLabel(value as Parameters<typeof todoPriorityLabel>[0]);
}

export function aiProviderLabel(value: string) {
  return AI_PROVIDER_FAMILY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function aiCapabilityLabel(value: string) {
  return AI_CAPABILITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function tagColorValue(value: TagColorKey) {
  return (
    FILE_TAG_COLOR_OPTIONS.find((option) => option.value === value)?.colorValue ??
    "var(--color-file-tag-slate)"
  );
}

export function colorKeyBadgeStyle(value: TagColorKey) {
  const colorValue = tagColorValue(value);
  return {
    backgroundColor: `color-mix(in srgb, ${colorValue} 12%, transparent)`,
    color: colorValue,
  };
}

export function tagColorLabel(value: TagColorKey) {
  return FILE_TAG_COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
