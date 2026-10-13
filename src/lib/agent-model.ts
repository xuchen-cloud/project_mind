import { bindingForCapability, findAiProfile } from "./ai";
import type { AiSettingsSnapshot } from "./types";

export function assistantModel(settings: AiSettingsSnapshot | undefined, overrideId: number | null = null) {
  const general = settings ? bindingForCapability(settings, "default") : null;
  const profile = settings ? findAiProfile(settings.profiles, overrideId ?? general?.profileId) : null;
  const model = overrideId === null ? general?.model?.trim() || profile?.defaultModel : profile?.defaultModel;
  const reason = settings?.aiSecretsUnlocked === false ? "AI 密钥已锁定，请到模型设置解锁。"
    : !profile ? "尚未配置可用模型，请到模型设置选择通用模型。"
    : !profile.enabled ? "当前模型配置已停用，请到模型设置启用或更换。"
    : profile.providerFamily !== "openai_compatible" || !profile.supportsText ? "当前模型不支持助手，请选择兼容的文本模型。"
    : !profile.hasStoredKey ? "当前模型缺少 API 密钥，请到模型设置填写。"
    : !model?.trim() ? "尚未填写模型名称，请到模型设置补充。" : null;
  return {
    ready: reason === null, reason,
    label: overrideId !== null && !profile ? "所选模型配置已删除或不可用"
      : profile ? `${profile.name} · ${model || "未配置模型"}` : "尚未配置通用模型",
  };
}
