import type { AiFeatureKey, AiManagedCapability, FileTagColorKey } from "./types";
import { TODO_PRIORITY_META, todoPriorityLabel } from "./todo-priority";

export const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂缓" },
  { value: "completed", label: "已完成" },
] as const;

export const EMPTY_ACTIVITY_ATTRIBUTE_LABEL = "未设置属性";
export const DEFAULT_ACTIVITY_STATUS_LABEL = "待启动";
export const UNTITLED_ACTIVITY_PREFIX = "未命名 Activity";

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
  { value: "default", label: "全局默认" },
  { value: "assistant", label: "AI 助手" },
  { value: "summary", label: "AI 总结" },
  { value: "suggestion_generation", label: "建议生成" },
  { value: "editor_rewrite", label: "编辑改写" },
] as const;

export const AI_VISIBLE_CAPABILITY_OPTIONS: Array<{
  value: AiManagedCapability;
  label: string;
}> = [
  { value: "assistant", label: "Ask" },
  { value: "summary", label: "AI 总结" },
  { value: "suggestion_generation", label: "AI 提炼" },
  { value: "editor_rewrite", label: "编辑改写" },
];

export const AI_FEATURE_OPTIONS: Array<{
  value: AiFeatureKey;
  capability: AiManagedCapability;
  label: string;
}> = [
  {
    value: "summary.activity_summary",
    capability: "summary",
    label: "Activity 总结",
  },
  {
    value: "summary.project_brief",
    capability: "summary",
    label: "项目概览",
  },
  {
    value: "summary.daily_brief",
    capability: "summary",
    label: "Today",
  },
  {
    value: "suggestion_generation.conclusion",
    capability: "suggestion_generation",
    label: "结论候选",
  },
  {
    value: "suggestion_generation.todo",
    capability: "suggestion_generation",
    label: "Todo 候选",
  },
];

export const FILE_TAG_COLOR_OPTIONS: Array<{
  value: FileTagColorKey;
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

export function activityAttributeLabel(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : EMPTY_ACTIVITY_ATTRIBUTE_LABEL;
}

export function activityStatusLabel(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : DEFAULT_ACTIVITY_STATUS_LABEL;
}

export function untitledActivityTitle(activityId: number) {
  return `${UNTITLED_ACTIVITY_PREFIX} ${activityId}`;
}

export function resolveActivityTitle(value: string | null | undefined, activityId: number) {
  const normalized = value?.trim();
  return normalized ? normalized : untitledActivityTitle(activityId);
}

export function todoStatusLabel(value: string) {
  return TODO_STATUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function priorityLabel(value: string) {
  return todoPriorityLabel(value as Parameters<typeof todoPriorityLabel>[0]);
}

export function suggestionLabel(type: string) {
  switch (type) {
    case "activity_title":
      return "标题建议";
    case "conclusion":
      return "结论建议";
    case "todo":
      return "待办建议";
    default:
      return type;
  }
}

export function aiProviderLabel(value: string) {
  return AI_PROVIDER_FAMILY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function aiCapabilityLabel(value: string) {
  return AI_CAPABILITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function aiVisibleCapabilityLabel(value: AiManagedCapability) {
  return AI_VISIBLE_CAPABILITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function aiFeatureLabel(value: AiFeatureKey) {
  return AI_FEATURE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function fileTagColorValue(value: FileTagColorKey) {
  return (
    FILE_TAG_COLOR_OPTIONS.find((option) => option.value === value)?.colorValue ??
    "var(--color-file-tag-slate)"
  );
}

export function colorKeyBadgeStyle(value: FileTagColorKey) {
  const colorValue = fileTagColorValue(value);
  return {
    backgroundColor: `color-mix(in srgb, ${colorValue} 12%, transparent)`,
    color: colorValue,
  };
}

export function fileTagColorLabel(value: FileTagColorKey) {
  return FILE_TAG_COLOR_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
