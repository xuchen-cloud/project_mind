export const PROJECT_STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "paused", label: "暂缓" },
  { value: "completed", label: "已完成" },
] as const;

export const EMPTY_ACTIVITY_ATTRIBUTE_LABEL = "未设置属性";
export const DEFAULT_ACTIVITY_STATUS_LABEL = "待启动";

export const TODO_STATUS_OPTIONS = [
  { value: "unfinished", label: "未完成" },
  { value: "finished", label: "已完成" },
] as const;

export const TODO_PRIORITY_OPTIONS = [
  { value: "urgent_important", label: "紧急且重要" },
  { value: "urgent_not_important", label: "紧急但不重要" },
  { value: "not_urgent_important", label: "不紧急但重要" },
  { value: "not_urgent_not_important", label: "不紧急且不重要" },
] as const;

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
] as const;

export function activityAttributeLabel(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : EMPTY_ACTIVITY_ATTRIBUTE_LABEL;
}

export function activityStatusLabel(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : DEFAULT_ACTIVITY_STATUS_LABEL;
}

export function activityStatusTone(needsAttention: boolean) {
  return needsAttention ? "warning" : "success";
}

export function todoStatusLabel(value: string) {
  return TODO_STATUS_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function priorityLabel(value: string) {
  return TODO_PRIORITY_OPTIONS.find((o) => o.value === value)?.label ?? value;
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
