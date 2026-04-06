import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  TestTube2,
  Trash2,
} from "lucide-react";

import { bindingForCapability, createAiProfileDraft, isAiCapabilityConfigured } from "../../lib/ai";
import {
  AI_CAPABILITY_OPTIONS,
  AI_PROVIDER_FAMILY_OPTIONS,
  aiCapabilityLabel,
  aiProviderLabel,
} from "../../lib/constants";
import type {
  AiCapability,
  AiCapabilityBindingUpsertInput,
  AiProfileTestResult,
  AiProviderFamily,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
} from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, EmptyState, SectionHeader, StatusBadge, SurfaceCard, TextField } from "../../ui/components";
import { settingsSelectClassName } from "./shared";

type SelectedProfileState = "new" | number;

interface BindingDraft {
  capability: AiCapability;
  useDefault: boolean;
  profileId: string;
  model: string;
}

interface AiSettingsPanelProps {
  open: boolean;
}

export function AiSettingsPanel({ open }: AiSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
    enabled: open,
  });

  const snapshot = aiSettingsQuery.data;
  const [selectedProfileId, setSelectedProfileId] = useState<SelectedProfileState>("new");
  const [profileDraft, setProfileDraft] = useState<AiProviderProfileUpsertInput>(
    createAiProfileDraft(),
  );
  const [bindingDrafts, setBindingDrafts] = useState<Record<AiCapability, BindingDraft>>(
    emptyBindingDrafts(),
  );
  const [testResult, setTestResult] = useState<AiProfileTestResult | null>(null);

  const selectedProfile = useMemo(
    () =>
      typeof selectedProfileId === "number"
        ? snapshot?.profiles.find((profile) => profile.id === selectedProfileId) ?? null
        : null,
    [selectedProfileId, snapshot?.profiles],
  );

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    setBindingDrafts(buildBindingDrafts(snapshot));

    if (typeof selectedProfileId !== "number") {
      return;
    }

    const nextProfile = snapshot.profiles.find((profile) => profile.id === selectedProfileId) ?? null;
    if (nextProfile) {
      setProfileDraft(buildProfileDraft(nextProfile));
    } else {
      setSelectedProfileId("new");
      setProfileDraft(createAiProfileDraft());
    }
  }, [selectedProfileId, snapshot]);

  const saveProfileMutation = useMutation({
    mutationFn: projectMindApi.aiProfileUpsert,
    onSuccess: async (profile) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 接入配置已保存" });
      setSelectedProfileId(profile.id);
      setProfileDraft(buildProfileDraft(profile));
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存 AI 配置失败" });
      pushToast({ tone: "error", title: "保存 AI 配置失败", detail: String(error) });
    },
  });

  const deleteProfileMutation = useMutation({
    mutationFn: projectMindApi.aiProfileDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "AI 接入配置已删除" });
      setSelectedProfileId("new");
      setProfileDraft(createAiProfileDraft());
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除 AI 配置失败" });
      pushToast({ tone: "error", title: "删除 AI 配置失败", detail: String(error) });
    },
  });

  const testProfileMutation = useMutation({
    mutationFn: projectMindApi.aiProfileTest,
    onSuccess: (result) => {
      setStatus({ tone: "success", label: "Connected", message: "AI 连通性测试通过" });
      setTestResult(result);
    },
    onError: (error) => {
      const failed = { success: false, message: String(error) } satisfies AiProfileTestResult;
      setStatus({ tone: "error", label: "Error", message: "AI 连通性测试失败" });
      setTestResult(failed);
      pushToast({ tone: "error", title: "AI 连通性测试失败", detail: String(error) });
    },
  });

  const saveBindingMutation = useMutation({
    mutationFn: projectMindApi.aiBindingUpsert,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Saved", message: "AI 能力绑定已更新" });
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新 AI 能力绑定失败" });
      pushToast({ tone: "error", title: "更新 AI 能力绑定失败", detail: String(error) });
    },
  });

  const enabledProfilesCount = snapshot?.profiles.filter((profile) => profile.enabled).length ?? 0;

  if (aiSettingsQuery.isLoading) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载 AI 设置...
      </div>
    );
  }

  if (aiSettingsQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="AI 设置暂时不可用"
          text="读取本地接入配置失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => aiSettingsQuery.refetch()}>
              重新加载
            </Button>
          }
          className="w-full max-w-lg"
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <SurfaceCard subtle className="px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Workspace AI
            </p>
            <p className="mt-1 text-body text-text-muted">
              管理本地模型接入、能力绑定和密钥存储策略。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone={snapshot.hasUsableDefault ? "success" : "warning"}>
              {snapshot.hasUsableDefault ? "默认模型已就绪" : "默认模型待配置"}
            </StatusBadge>
            <StatusBadge tone="neutral">{snapshot.profiles.length} 条配置</StatusBadge>
            <StatusBadge tone={enabledProfilesCount > 0 ? "neutral" : "warning"}>
              {enabledProfilesCount} 条启用中
            </StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <div className="grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <SurfaceCard subtle className="flex min-h-[18rem] flex-col overflow-hidden p-3">
          <SectionHeader
            eyebrow="Profiles"
            title="接入配置"
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSelectedProfileId("new");
                  setProfileDraft(createAiProfileDraft());
                  setTestResult(null);
                }}
              >
                新建
              </Button>
            }
          />

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {snapshot.profiles.length > 0 ? (
              <div className="grid gap-2">
                {snapshot.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={[
                      "rounded-[var(--radius-8)] border px-3 py-3 text-left transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
                      selectedProfileId === profile.id
                        ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))]"
                        : "border-border bg-bg hover:border-border-strong hover:bg-bg-hover",
                    ].join(" ")}
                    onClick={() => {
                      setSelectedProfileId(profile.id);
                      setProfileDraft(buildProfileDraft(profile));
                      setTestResult(null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-body font-medium text-text">{profile.name}</p>
                      <StatusBadge tone={profile.enabled ? "success" : "warning"}>
                        {profile.enabled ? "启用" : "暂停"}
                      </StatusBadge>
                    </div>
                    <p className="mt-1 text-ui text-text-soft">
                      {aiProviderLabel(profile.providerFamily)}
                    </p>
                    <p className="mt-2 truncate text-ui text-text-soft">{profile.defaultModel}</p>
                    <p className="mt-2 text-caption text-text-soft">
                      {profile.supportsText ? "text" : null}
                      {profile.supportsImage ? " · image" : null}
                      {profile.supportsFile ? " · file" : null}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState text="还没有 AI 接入配置。" compact className="h-full min-h-40" />
            )}
          </div>
        </SurfaceCard>

        <div className="grid gap-4">
          <SurfaceCard className="p-4 sm:p-5">
            <SectionHeader
              eyebrow="Editor"
              title={selectedProfile ? "编辑接入配置" : "新增接入配置"}
              actions={
                selectedProfile?.hasStoredKey ? (
                  <StatusBadge tone="neutral">{maskKey(selectedProfile.apiKeyLast4)}</StatusBadge>
                ) : null
              }
            />

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">配置名称</span>
                <TextField
                  value={profileDraft.name}
                  onChange={(event) =>
                    setProfileDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="例如：Production OpenAI"
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">接入类型</span>
                <select
                  value={profileDraft.providerFamily}
                  onChange={(event) => {
                    const nextFamily = event.target.value as AiProviderFamily;
                    const defaults = providerDefaults(nextFamily);
                    setProfileDraft((current) => ({
                      ...current,
                      providerFamily: nextFamily,
                      baseUrl: defaults.baseUrl,
                      defaultModel: defaults.defaultModel,
                    }));
                  }}
                  className={settingsSelectClassName}
                >
                  {AI_PROVIDER_FAMILY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5 md:col-span-2">
                <span className="text-ui font-medium text-text-muted">Base URL</span>
                <TextField
                  value={profileDraft.baseUrl}
                  onChange={(event) =>
                    setProfileDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">默认模型</span>
                <TextField
                  value={profileDraft.defaultModel}
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value,
                    }))
                  }
                  placeholder="gpt-4.1-mini"
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">API Key</span>
                <TextField
                  type="password"
                  value={profileDraft.apiKey ?? ""}
                  onChange={(event) =>
                    setProfileDraft((current) => ({ ...current, apiKey: event.target.value }))
                  }
                  placeholder={selectedProfile?.hasStoredKey ? "留空则保留当前密钥" : "输入 API Key"}
                />
              </label>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <TogglePill
                label="文本"
                checked={profileDraft.supportsText}
                onChange={(checked) =>
                  setProfileDraft((current) => ({ ...current, supportsText: checked }))
                }
              />
              <TogglePill
                label="图片"
                checked={profileDraft.supportsImage}
                onChange={(checked) =>
                  setProfileDraft((current) => ({ ...current, supportsImage: checked }))
                }
              />
              <TogglePill
                label="文件"
                checked={profileDraft.supportsFile}
                onChange={(checked) =>
                  setProfileDraft((current) => ({ ...current, supportsFile: checked }))
                }
              />
              <TogglePill
                label="启用"
                checked={profileDraft.enabled}
                onChange={(checked) =>
                  setProfileDraft((current) => ({ ...current, enabled: checked }))
                }
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                leadingIcon={<KeyRound size={14} />}
                disabled={saveProfileMutation.isPending}
                onClick={() =>
                  saveProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
              >
                {saveProfileMutation.isPending ? "保存中..." : "保存配置"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                leadingIcon={<TestTube2 size={14} />}
                disabled={testProfileMutation.isPending}
                onClick={() =>
                  testProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
              >
                {testProfileMutation.isPending ? "测试中..." : "测试连接"}
              </Button>
              {selectedProfile ? (
                <Button
                  type="button"
                  variant="danger"
                  leadingIcon={<Trash2 size={14} />}
                  disabled={deleteProfileMutation.isPending}
                  onClick={() => deleteProfileMutation.mutate({ profileId: selectedProfile.id })}
                >
                  删除配置
                </Button>
              ) : null}
            </div>

            {testResult ? (
              <SurfaceCard subtle className="mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-body font-medium text-text">{testResult.message}</p>
                  <p className="mt-1 text-ui text-text-soft">
                    {testResult.resolvedModel
                      ? `模型：${testResult.resolvedModel}`
                      : "测试通过，但未返回模型标识"}
                  </p>
                </div>
                <StatusBadge tone={testResult.success ? "success" : "danger"}>
                  {testResult.success ? `${testResult.latencyMs ?? 0}ms` : "failed"}
                </StatusBadge>
              </SurfaceCard>
            ) : null}
          </SurfaceCard>

          <SurfaceCard className="p-4 sm:p-5">
            <SectionHeader eyebrow="Bindings" title="能力绑定" />

            <div className="mt-4 overflow-hidden rounded-[var(--radius-8)] border border-border bg-bg-subtle">
              {AI_CAPABILITY_OPTIONS.map((option, index) => {
                const draft = bindingDrafts[option.value];
                const configured = isAiCapabilityConfigured(snapshot, option.value);
                const selectedProfileName =
                  snapshot.profiles.find((profile) => profile.id === Number(draft.profileId))?.name ??
                  null;

                return (
                  <div
                    key={option.value}
                    className={[
                      "grid gap-4 px-4 py-4 lg:grid-cols-[14rem_minmax(0,1fr)]",
                      index > 0 ? "border-t border-border" : "",
                    ].join(" ")}
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-body font-medium text-text">
                          {aiCapabilityLabel(option.value)}
                        </p>
                        <StatusBadge tone={configured ? "success" : "warning"}>
                          {configured ? "已就绪" : "待配置"}
                        </StatusBadge>
                      </div>
                      <p className="mt-1 text-ui leading-5 text-text-soft">
                        {bindingDescription(option.value)}
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                      {option.value !== "default" ? (
                        <label className="grid gap-1.5">
                          <span className="text-ui font-medium text-text-muted">模式</span>
                          <select
                            value={draft.useDefault ? "inherit" : "custom"}
                            onChange={(event) =>
                              setBindingDrafts((current) => ({
                                ...current,
                                [option.value]: {
                                  ...current[option.value],
                                  useDefault: event.target.value === "inherit",
                                  profileId:
                                    event.target.value === "inherit" ? "" : current[option.value].profileId,
                                  model: event.target.value === "inherit" ? "" : current[option.value].model,
                                },
                              }))
                            }
                            className={settingsSelectClassName}
                          >
                            <option value="inherit">继承默认</option>
                            <option value="custom">单独配置</option>
                          </select>
                        </label>
                      ) : (
                        <div className="hidden xl:block" />
                      )}

                      <label className="grid gap-1.5">
                        <span className="text-ui font-medium text-text-muted">接入配置</span>
                        <select
                          value={draft.profileId}
                          disabled={option.value !== "default" && draft.useDefault}
                          onChange={(event) =>
                            setBindingDrafts((current) => ({
                              ...current,
                              [option.value]: {
                                ...current[option.value],
                                profileId: event.target.value,
                              },
                            }))
                          }
                          className={settingsSelectClassName}
                        >
                          <option value="">选择配置</option>
                          {snapshot.profiles.map((profile) => (
                            <option key={profile.id} value={String(profile.id)}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="grid gap-1.5">
                        <span className="text-ui font-medium text-text-muted">覆盖模型</span>
                        <TextField
                          value={draft.model}
                          disabled={option.value !== "default" && draft.useDefault}
                          onChange={(event) =>
                            setBindingDrafts((current) => ({
                              ...current,
                              [option.value]: {
                                ...current[option.value],
                                model: event.target.value,
                              },
                            }))
                          }
                          placeholder={
                            selectedProfileName
                              ? `${selectedProfileName} 的默认模型`
                              : "留空则使用配置默认模型"
                          }
                          className="disabled:bg-bg-subtle disabled:text-text-soft"
                        />
                      </label>

                      <div className="flex items-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={saveBindingMutation.isPending}
                          onClick={() => saveBindingMutation.mutate(toBindingInput(option.value, draft))}
                        >
                          保存绑定
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </SurfaceCard>

          <details className="group rounded-[var(--radius-8)] border border-border bg-bg-subtle px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <p className="text-body font-medium text-text">存储与迁移说明</p>
                  <p className="mt-1 text-ui leading-5 text-text-soft">
                    密钥会以设备绑定方式加密存储，迁移机器后需要重新录入。
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge tone="neutral">设备绑定加密</StatusBadge>
                <ChevronDown
                  size={16}
                  className="text-text-soft transition-transform duration-[160ms] ease-[var(--ease-soft)] group-open:rotate-180"
                />
              </div>
            </summary>

            <div className="mt-3 grid gap-2 border-t border-border pt-3 text-body leading-6 text-text-muted">
              <p>
                API Key 会先在本机使用设备标识派生密钥，再以加密形式写入本地数据库；不会明文落盘。
              </p>
              <p>
                把数据库直接拷到另一台设备时，原有密钥无法解密，需要重新录入后才能继续使用。
              </p>
              <p>
                多模态能力当前只保留到配置层：可以声明文本、图片、文件支持，但业务调用仍以文本链路优先。
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function buildProfileDraft(profile: AiProviderProfileRecord): AiProviderProfileUpsertInput {
  return {
    id: profile.id,
    name: profile.name,
    providerFamily: profile.providerFamily,
    baseUrl: profile.baseUrl,
    apiKey: "",
    defaultModel: profile.defaultModel,
    supportsText: profile.supportsText,
    supportsImage: profile.supportsImage,
    supportsFile: profile.supportsFile,
    enabled: profile.enabled,
  };
}

function buildBindingDrafts(snapshot: AiSettingsSnapshot): Record<AiCapability, BindingDraft> {
  return {
    default: buildBindingDraft(snapshot, "default"),
    assistant: buildBindingDraft(snapshot, "assistant"),
    summary: buildBindingDraft(snapshot, "summary"),
    suggestion_generation: buildBindingDraft(snapshot, "suggestion_generation"),
  };
}

function buildBindingDraft(snapshot: AiSettingsSnapshot, capability: AiCapability): BindingDraft {
  const binding = bindingForCapability(snapshot, capability);
  return {
    capability,
    useDefault: binding.useDefault,
    profileId: binding.profileId ? String(binding.profileId) : "",
    model: binding.model ?? "",
  };
}

function emptyBindingDrafts(): Record<AiCapability, BindingDraft> {
  return {
    default: { capability: "default", useDefault: false, profileId: "", model: "" },
    assistant: { capability: "assistant", useDefault: true, profileId: "", model: "" },
    summary: { capability: "summary", useDefault: true, profileId: "", model: "" },
    suggestion_generation: {
      capability: "suggestion_generation",
      useDefault: true,
      profileId: "",
      model: "",
    },
  };
}

function toBindingInput(
  capability: AiCapability,
  draft: BindingDraft,
): AiCapabilityBindingUpsertInput {
  return {
    capability,
    useDefault: capability === "default" ? false : draft.useDefault,
    profileId: draft.profileId ? Number(draft.profileId) : undefined,
    model: draft.model.trim() || undefined,
  };
}

function providerDefaults(providerFamily: AiProviderFamily) {
  const option = AI_PROVIDER_FAMILY_OPTIONS.find((item) => item.value === providerFamily);
  return option
    ? { baseUrl: option.baseUrl, defaultModel: option.defaultModel }
    : { baseUrl: "", defaultModel: "" };
}

function maskKey(last4: string) {
  return last4 ? `已存密钥 •••• ${last4}` : "已保存密钥";
}

function bindingDescription(capability: AiCapability) {
  if (capability === "suggestion_generation") {
    return "Activity 页里的 AI 建议生成功能会优先读取这里。";
  }
  if (capability === "summary") {
    return "为后续 AI 总结能力预留单独模型。";
  }
  if (capability === "assistant") {
    return "为后续 AI 助手入口预留专用绑定。";
  }
  return "其他未单独指定的能力都会回退到这里。";
}

function TogglePill({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={[
        "flex items-center justify-between gap-3 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
        checked
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
          : "border-border bg-bg text-text-muted hover:border-border-strong hover:text-text",
      ].join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className="text-body font-medium">{label}</span>
      {checked ? <CheckCircle2 size={14} /> : <Cpu size={14} />}
    </button>
  );
}
