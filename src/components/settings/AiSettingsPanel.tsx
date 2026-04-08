import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import {
  bindingForCapability,
  createAiProfileDraft,
  isAiCapabilityConfigured,
  providerDefaults,
} from "../../lib/ai";
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
import {
  Button,
  EmptyState,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
  TextField,
} from "../../ui/components";
import {
  settingsCardClassName,
  settingsFieldClassName,
  settingsFieldLabelClassName,
  settingsSelectClassName,
} from "./shared";

type BindingMode = "normal" | "advanced";

interface BindingDraft {
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
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [bindingMode, setBindingMode] = useState<BindingMode>("normal");
  const [bindingModeBusy, setBindingModeBusy] = useState(false);
  const [profileDraft, setProfileDraft] = useState<AiProviderProfileUpsertInput>(
    createAiProfileDraft(),
  );
  const [testResult, setTestResult] = useState<AiProfileTestResult | null>(null);

  const hasCustomBindings =
    snapshot?.bindings.some((binding) => binding.capability !== "default" && !binding.useDefault) ??
    false;
  const selectedProfile = useMemo(
    () =>
      selectedProfileId !== null
        ? snapshot?.profiles.find((profile) => profile.id === selectedProfileId) ?? null
        : null,
    [selectedProfileId, snapshot?.profiles],
  );

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (selectedProfileId === null) {
      return;
    }

    const nextProfile = snapshot.profiles.find((profile) => profile.id === selectedProfileId) ?? null;
    if (nextProfile) {
      setProfileDraft(buildProfileDraft(nextProfile));
    } else {
      setSelectedProfileId(null);
      setIsCreatingProfile(false);
      setProfileDraft(createAiProfileDraft());
    }
  }, [selectedProfileId, snapshot]);

  useEffect(() => {
    setBindingMode(hasCustomBindings ? "advanced" : "normal");
  }, [hasCustomBindings]);

  const saveProfileMutation = useMutation({
    mutationFn: projectMindApi.aiProfileUpsert,
    onSuccess: async (profile) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 接入配置已保存" });
      setSelectedProfileId(profile.id);
      setIsCreatingProfile(false);
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
      setSelectedProfileId(null);
      setIsCreatingProfile(false);
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
    onSuccess: (binding) => {
      queryClient.setQueryData<AiSettingsSnapshot>(["ai-settings"], (current) => {
        if (!current) {
          return current;
        }
        const bindings = upsertBindingRecord(current.bindings, binding);
        const nextSnapshot: AiSettingsSnapshot = {
          ...current,
          bindings,
        };
        return {
          ...nextSnapshot,
          hasUsableDefault: isAiCapabilityConfigured(nextSnapshot, "default"),
        };
      });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新 AI 能力绑定失败" });
      pushToast({ tone: "error", title: "更新 AI 能力绑定失败", detail: String(error) });
    },
  });

  const enabledProfilesCount = snapshot?.profiles.filter((profile) => profile.enabled).length ?? 0;
  const bindingControlsBusy = saveBindingMutation.isPending || bindingModeBusy;
  const profileCapabilitySummary = [
    profileDraft.supportsText ? "文本" : null,
    profileDraft.supportsImage ? "图片" : null,
    profileDraft.supportsFile ? "文件" : null,
  ]
    .filter(Boolean)
    .join(" / ");
  const keyStatusLabel = profileDraft.apiKey?.trim()
    ? "已输入新密钥"
    : selectedProfile?.hasStoredKey
      ? maskKey(selectedProfile.apiKeyLast4)
      : "未保存密钥";

  const beginCreateProfile = useCallback(() => {
    setSelectedProfileId(null);
    setIsCreatingProfile(true);
    setProfileDraft(createAiProfileDraft());
    setTestResult(null);
  }, []);

  const closeCreateProfile = useCallback(() => {
    setIsCreatingProfile(false);
    setProfileDraft(createAiProfileDraft());
    setTestResult(null);
  }, []);

  const handleBindingModeChange = useCallback(
    async (nextMode: BindingMode) => {
      if (!snapshot || nextMode === bindingMode) {
        return;
      }

      if (nextMode === "advanced") {
        setBindingMode("advanced");
        return;
      }

      const customBindings = snapshot.bindings.filter(
        (binding) => binding.capability !== "default" && !binding.useDefault,
      );

      setBindingModeBusy(true);
      try {
        for (const binding of customBindings) {
          await saveBindingMutation.mutateAsync({
            capability: binding.capability,
            useDefault: true,
          });
        }
        setBindingMode("normal");
      } finally {
        setBindingModeBusy(false);
      }
    },
    [bindingMode, saveBindingMutation, snapshot],
  );

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
    <div className="grid gap-3">
      <SurfaceCard subtle className="px-3.5 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Workspace AI
            </p>
            <p className="mt-0.5 text-body text-text-muted">接入配置与能力绑定。</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
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

      <div className="grid gap-3 xl:grid-cols-[15rem_minmax(0,1fr)]">
        <SurfaceCard subtle className="flex min-h-[16rem] flex-col overflow-hidden p-3">
          <SectionHeader eyebrow="Profiles" title="接入配置" />

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {snapshot.profiles.length > 0 ? (
              <div className="grid gap-1.5">
                {snapshot.profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={[
                      "rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
                      selectedProfileId === profile.id
                        ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))]"
                        : "border-border bg-bg hover:border-border-strong hover:bg-bg-hover",
                    ].join(" ")}
                    onClick={() => {
                      setSelectedProfileId(profile.id);
                      setIsCreatingProfile(false);
                      setProfileDraft(buildProfileDraft(profile));
                      setTestResult(null);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-body font-medium text-text">{profile.name}</p>
                      <StatusBadge tone={profile.enabled ? "success" : "warning"}>
                        {profile.enabled ? "启用" : "暂停"}
                      </StatusBadge>
                    </div>
                    <p className="mt-1 truncate text-ui text-text-soft">
                      {aiProviderLabel(profile.providerFamily)} · {profile.defaultModel}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState text="还没有 AI 接入配置。" compact className="h-full min-h-40" />
            )}
          </div>
        </SurfaceCard>

        <div className="grid gap-3">
          <SurfaceCard className={settingsCardClassName}>
            {selectedProfile || isCreatingProfile ? (
              <>
                <SectionHeader
                  eyebrow="Editor"
                  title={selectedProfile ? "当前配置" : "新建配置"}
                  actions={
                    isCreatingProfile && snapshot.profiles.length > 0 ? (
                      <Button type="button" size="sm" variant="ghost" onClick={closeCreateProfile}>
                        取消
                      </Button>
                    ) : selectedProfile ? (
                      <Button type="button" size="sm" variant="secondary" onClick={beginCreateProfile}>
                        新建
                      </Button>
                    ) : null
                  }
                />

                <div className="mt-3 flex flex-wrap gap-1.5">
                  <StatusBadge tone="neutral">{aiProviderLabel(profileDraft.providerFamily)}</StatusBadge>
                  <StatusBadge tone={profileDraft.enabled ? "success" : "warning"}>
                    {profileDraft.enabled ? "启用" : "暂停"}
                  </StatusBadge>
                  <StatusBadge tone="neutral">{keyStatusLabel}</StatusBadge>
                  <StatusBadge tone={profileCapabilitySummary ? "neutral" : "warning"}>
                    {profileCapabilitySummary || "未声明能力"}
                  </StatusBadge>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className={settingsFieldClassName}>
                    <span className={settingsFieldLabelClassName}>名称</span>
                    <TextField
                      fieldSize="sm"
                      value={profileDraft.name}
                      onChange={(event) =>
                        setProfileDraft((current) => ({ ...current, name: event.target.value }))
                      }
                      placeholder="Production OpenAI"
                    />
                  </label>

                  <label className={settingsFieldClassName}>
                    <span className={settingsFieldLabelClassName}>接入类型</span>
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

                  <label className={`${settingsFieldClassName} md:col-span-2`}>
                    <span className={settingsFieldLabelClassName}>Base URL</span>
                    <TextField
                      fieldSize="sm"
                      value={profileDraft.baseUrl}
                      onChange={(event) =>
                        setProfileDraft((current) => ({ ...current, baseUrl: event.target.value }))
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>

                  <label className={settingsFieldClassName}>
                    <span className={settingsFieldLabelClassName}>默认模型</span>
                    <TextField
                      fieldSize="sm"
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

                  <label className={settingsFieldClassName}>
                    <span className={settingsFieldLabelClassName}>API Key</span>
                    <TextField
                      fieldSize="sm"
                      type="password"
                      value={profileDraft.apiKey ?? ""}
                      onChange={(event) =>
                        setProfileDraft((current) => ({ ...current, apiKey: event.target.value }))
                      }
                      placeholder={selectedProfile?.hasStoredKey ? "留空则保留当前密钥" : "输入 API Key"}
                    />
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
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

                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={saveProfileMutation.isPending}
                    onClick={() =>
                      saveProfileMutation.mutate({
                        ...profileDraft,
                        apiKey: profileDraft.apiKey?.trim() || undefined,
                      })
                    }
                  >
                    {saveProfileMutation.isPending ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={testProfileMutation.isPending}
                    onClick={() =>
                      testProfileMutation.mutate({
                        ...profileDraft,
                        apiKey: profileDraft.apiKey?.trim() || undefined,
                      })
                    }
                  >
                    {testProfileMutation.isPending ? "测试中..." : "测试"}
                  </Button>
                  {selectedProfile ? (
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={deleteProfileMutation.isPending}
                      onClick={() => deleteProfileMutation.mutate({ profileId: selectedProfile.id })}
                    >
                      删除
                    </Button>
                  ) : null}
                </div>

                {testResult ? (
                  <SurfaceCard subtle className="mt-3 flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                    <p className="min-w-0 flex-1 text-body text-text">{testResult.message}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {testResult.resolvedModel ? (
                        <StatusBadge tone="neutral">{testResult.resolvedModel}</StatusBadge>
                      ) : null}
                      <StatusBadge tone={testResult.success ? "success" : "danger"}>
                        {testResult.success ? `${testResult.latencyMs ?? 0}ms` : "failed"}
                      </StatusBadge>
                    </div>
                  </SurfaceCard>
                ) : null}
              </>
            ) : (
              <>
                <SectionHeader eyebrow="Editor" title="接入配置" />
                <div className="mt-3">
                  <Button type="button" size="sm" variant="secondary" onClick={beginCreateProfile}>
                    新建配置
                  </Button>
                </div>
              </>
            )}
          </SurfaceCard>

          <SurfaceCard className={settingsCardClassName}>
            <SectionHeader
              eyebrow="Bindings"
              title="能力绑定"
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone={bindingControlsBusy ? "warning" : "neutral"}>
                    {bindingControlsBusy ? "同步中" : "自动保存"}
                  </StatusBadge>
                  <BindingModeSwitch
                    value={bindingMode}
                    disabled={bindingControlsBusy}
                    onChange={handleBindingModeChange}
                  />
                </div>
              }
            />

            <div className="mt-3 grid gap-2.5">
              <BindingRow
                snapshot={snapshot}
                capability="default"
                busy={bindingControlsBusy}
                onSave={(input) => saveBindingMutation.mutateAsync(input)}
              />
              {bindingMode === "advanced"
                ? AI_CAPABILITY_OPTIONS.filter((option) => option.value !== "default").map((option) => (
                    <BindingRow
                      key={option.value}
                      snapshot={snapshot}
                      capability={option.value}
                      busy={bindingControlsBusy}
                      onSave={(input) => saveBindingMutation.mutateAsync(input)}
                    />
                  ))
                : null}
            </div>
          </SurfaceCard>

          <SurfaceCard subtle className="flex flex-wrap items-center gap-2 px-3.5 py-3">
            <StatusBadge tone="neutral">本机加密</StatusBadge>
            <p className="text-body text-text-muted">
              密钥按设备绑定加密存储，迁移机器后需要重新录入。
            </p>
          </SurfaceCard>
        </div>
      </div>
    </div>
  );
}

function BindingRow({
  snapshot,
  capability,
  busy,
  onSave,
}: {
  snapshot: AiSettingsSnapshot;
  capability: AiCapability;
  busy: boolean;
  onSave: (input: AiCapabilityBindingUpsertInput) => Promise<unknown>;
}) {
  const snapshotDraft = useMemo(() => buildBindingDraft(snapshot, capability), [capability, snapshot]);
  const [draft, setDraft] = useState<BindingDraft>(snapshotDraft);
  const lastSubmittedSignatureRef = useRef<string | null>(null);
  const configured = isAiCapabilityConfigured(snapshot, capability);
  const canSubmit = draft.profileId.trim().length > 0;
  const draftInput = useMemo(() => toBindingInput(capability, draft), [capability, draft]);
  const snapshotInput = useMemo(
    () => toBindingInput(capability, snapshotDraft),
    [capability, snapshotDraft],
  );
  const draftSignature = bindingInputSignature(draftInput);
  const snapshotSignature = bindingInputSignature(snapshotInput);

  useEffect(() => {
    setDraft(snapshotDraft);
    lastSubmittedSignatureRef.current = null;
  }, [snapshotDraft]);

  const submit = useCallback(
    (input: AiCapabilityBindingUpsertInput) => {
      const signature = bindingInputSignature(input);
      if (
        input.profileId == null ||
        signature === snapshotSignature ||
        lastSubmittedSignatureRef.current === signature
      ) {
        return;
      }

      lastSubmittedSignatureRef.current = signature;
      void onSave(input).catch(() => {
        if (lastSubmittedSignatureRef.current === signature) {
          lastSubmittedSignatureRef.current = null;
        }
      });
    },
    [onSave, snapshotSignature],
  );

  useEffect(() => {
    if (busy || !canSubmit || draftSignature === snapshotSignature) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      submit(draftInput);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [busy, canSubmit, draftInput, draftSignature, snapshotSignature, submit]);

  return (
    <div className="rounded-[var(--radius-8)] border border-border bg-bg-subtle px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-body font-medium text-text">{aiCapabilityLabel(capability)}</p>
          <StatusBadge tone={configured ? "success" : "warning"}>
            {configured ? "已就绪" : "待配置"}
          </StatusBadge>
        </div>
      </div>

      <div
        className={[
          "mt-2.5 grid gap-2",
          "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
        ].join(" ")}
      >
        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>接入配置</span>
          <select
            value={draft.profileId}
            disabled={busy}
            onChange={(event) =>
              setDraft({
                ...draft,
                profileId: event.target.value,
              })
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

        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>模型</span>
          <TextField
            fieldSize="sm"
            value={draft.model}
            disabled={busy || !canSubmit}
            onChange={(event) =>
              setDraft({
                ...draft,
                model: event.target.value,
              })
            }
            onBlur={() => submit(draftInput)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit(draftInput);
                event.currentTarget.blur();
              }
            }}
            placeholder="留空则使用配置默认模型"
          />
        </label>
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

function buildBindingDraft(snapshot: AiSettingsSnapshot, capability: AiCapability): BindingDraft {
  const binding = bindingForCapability(snapshot, capability);
  if (capability !== "default" && binding.useDefault) {
    const defaultBinding = bindingForCapability(snapshot, "default");
    return {
      profileId: defaultBinding.profileId ? String(defaultBinding.profileId) : "",
      model: defaultBinding.model ?? "",
    };
  }

  return {
    profileId: binding.profileId ? String(binding.profileId) : "",
    model: binding.model ?? "",
  };
}

function toBindingInput(
  capability: AiCapability,
  draft: BindingDraft,
): AiCapabilityBindingUpsertInput {
  return {
    capability,
    useDefault: false,
    profileId: draft.profileId ? Number(draft.profileId) : undefined,
    model: draft.model.trim() || undefined,
  };
}

function bindingInputSignature(input: AiCapabilityBindingUpsertInput) {
  return [
    input.capability,
    input.useDefault ? "1" : "0",
    input.profileId ?? "",
    input.model ?? "",
  ].join("::");
}

function upsertBindingRecord(
  bindings: AiSettingsSnapshot["bindings"],
  nextBinding: AiSettingsSnapshot["bindings"][number],
) {
  const existingIndex = bindings.findIndex((binding) => binding.capability === nextBinding.capability);
  if (existingIndex < 0) {
    return [...bindings, nextBinding];
  }
  return bindings.map((binding, index) => (index === existingIndex ? nextBinding : binding));
}

function BindingModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: BindingMode;
  disabled: boolean;
  onChange: (value: BindingMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-[var(--radius-8)] border border-border bg-bg p-0.5">
      {([
        { value: "normal", label: "普通模式" },
        { value: "advanced", label: "专业模式" },
      ] as const).map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            className={[
              "rounded-[var(--radius-6)] px-2.5 py-1 text-ui font-medium transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)] disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                : "text-text-muted hover:text-text",
            ].join(" ")}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function maskKey(last4: string) {
  return last4 ? `已存密钥 •••• ${last4}` : "已保存密钥";
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
      aria-pressed={checked}
      className={[
        "flex h-8 items-center rounded-[var(--radius-8)] border px-3 text-ui font-medium transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
        checked
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
          : "border-border bg-bg text-text-muted hover:border-border-strong hover:text-text",
      ].join(" ")}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  );
}
