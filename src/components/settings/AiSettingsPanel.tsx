import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";

import {
  bindingForCapability,
  createAiProfileDraft,
  featureSettingsFromSnapshot,
  isAiCapabilityConfigured,
  providerDefaults,
} from "../../lib/ai";
import {
  aiProfileTestJobTargetKey,
  enqueueAndWait,
  isAiJobActive,
  profileTestJobInput,
  readProfileTestJobResult,
  useAiJobTarget,
} from "../../lib/aiJobs";
import { getErrorMessage } from "../../lib/errors";
import {
  AI_CAPABILITY_OPTIONS,
  AI_FEATURE_OPTIONS,
  AI_PROVIDER_FAMILY_OPTIONS,
  AI_VISIBLE_CAPABILITY_OPTIONS,
  aiCapabilityLabel,
  aiFeatureLabel,
  aiProviderLabel,
  aiVisibleCapabilityLabel,
} from "../../lib/constants";
import type {
  AiCapability,
  AiCapabilityBindingUpsertInput,
  AiExecutionSettings,
  AiFeatureKey,
  AiFeatureSettings,
  AiManagedCapability,
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
  const profileTestTargetKey = useMemo(
    () => aiProfileTestJobTargetKey(selectedProfile?.id ?? null),
    [selectedProfile?.id],
  );
  const profileTestJob = useAiJobTarget(profileTestTargetKey);
  const profileTestJobActive = isAiJobActive(profileTestJob);

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
    onSuccess: async (profile, variables) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 接入配置已保存" });
      setSelectedProfileId(variables.id ? profile.id : null);
      setIsCreatingProfile(false);
      setProfileDraft(variables.id ? buildProfileDraft(profile) : createAiProfileDraft());
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "保存 AI 配置失败");
      setStatus({ tone: "error", label: "Error", message: "保存 AI 配置失败" });
      pushToast({ tone: "error", title: "保存 AI 配置失败", detail });
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
      const detail = getErrorMessage(error, "删除 AI 配置失败");
      setStatus({ tone: "error", label: "Error", message: "删除 AI 配置失败" });
      pushToast({ tone: "error", title: "删除 AI 配置失败", detail });
    },
  });

  const testProfileMutation = useMutation({
    mutationFn: async (input: Parameters<typeof projectMindApi.aiProfileTest>[0]) => {
      const job = await enqueueAndWait(profileTestJobInput(input));
      if (job.status !== "succeeded") {
        throw new Error(job.errorMessage ?? "AI 连通性测试失败");
      }
      return readProfileTestJobResult(job);
    },
    onSuccess: (result) => {
      setStatus({ tone: "success", label: "Connected", message: "AI 连通性测试通过" });
      setTestResult(result);
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "AI 连通性测试失败");
      const failed = { success: false, message: detail } satisfies AiProfileTestResult;
      setStatus({ tone: "error", label: "Error", message: "AI 连通性测试失败" });
      setTestResult(failed);
      pushToast({ tone: "error", title: "AI 连通性测试失败", detail });
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
      const detail = getErrorMessage(error, "更新 AI 能力绑定失败");
      setStatus({ tone: "error", label: "Error", message: "更新 AI 能力绑定失败" });
      pushToast({ tone: "error", title: "更新 AI 能力绑定失败", detail });
    },
  });

  const saveExecutionMutation = useMutation({
    mutationFn: projectMindApi.aiExecutionSettingsUpsert,
    onSuccess: (execution) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 调度设置已更新" });
      queryClient.setQueryData<AiSettingsSnapshot>(["ai-settings"], (current) =>
        current
          ? {
              ...current,
              execution,
            }
          : current,
      );
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "更新 AI 调度设置失败");
      setStatus({ tone: "error", label: "Error", message: "更新 AI 调度设置失败" });
      pushToast({ tone: "error", title: "更新 AI 调度设置失败", detail });
    },
  });
  const saveFeatureSettingsMutation = useMutation({
    mutationFn: projectMindApi.aiFeatureSettingsUpsert,
    onMutate: async (featureSettings) => {
      await queryClient.cancelQueries({ queryKey: ["ai-settings"] });
      const previousSnapshot = queryClient.getQueryData<AiSettingsSnapshot>(["ai-settings"]);
      queryClient.setQueryData<AiSettingsSnapshot>(["ai-settings"], (current) =>
        current
          ? {
              ...current,
              featureSettings,
            }
          : current,
      );
      return { previousSnapshot };
    },
    onSuccess: (featureSettings) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 能力开关已更新" });
      queryClient.setQueryData<AiSettingsSnapshot>(["ai-settings"], (current) =>
        current
          ? {
              ...current,
              featureSettings,
            }
          : current,
      );
    },
    onError: (error, _featureSettings, context) => {
      if (context?.previousSnapshot) {
        queryClient.setQueryData(["ai-settings"], context.previousSnapshot);
      }
      const detail = getErrorMessage(error, "更新 AI 能力开关失败");
      setStatus({ tone: "error", label: "Error", message: "更新 AI 能力开关失败" });
      pushToast({ tone: "error", title: "更新 AI 能力开关失败", detail });
    },
  });

  const enabledProfilesCount = snapshot?.profiles.filter((profile) => profile.enabled).length ?? 0;
  const bindingControlsBusy = saveBindingMutation.isPending || bindingModeBusy;
  const executionBusy = saveExecutionMutation.isPending;
  const featureSettings = featureSettingsFromSnapshot(snapshot);
  const featureToggleBusy = saveFeatureSettingsMutation.isPending;

  const beginCreateProfile = useCallback(() => {
    setSelectedProfileId(null);
    setIsCreatingProfile(true);
    setProfileDraft(createAiProfileDraft());
    setTestResult(null);
  }, []);

  const closeCreateProfile = useCallback(() => {
    setSelectedProfileId(null);
    setIsCreatingProfile(false);
    setProfileDraft(createAiProfileDraft());
    setTestResult(null);
  }, []);
  const openProfileEditor = useCallback((profile: AiProviderProfileRecord) => {
    setSelectedProfileId(profile.id);
    setIsCreatingProfile(false);
    setProfileDraft(buildProfileDraft(profile));
    setTestResult(null);
  }, []);
  const closeProfileEditor = useCallback(() => {
    setSelectedProfileId(null);
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
  const commitFeatureSettings = useCallback(
    (nextSettings: AiFeatureSettings) => {
      saveFeatureSettingsMutation.mutate(nextSettings);
    },
    [saveFeatureSettingsMutation],
  );
  const toggleMasterEnabled = useCallback(
    (checked: boolean) =>
      commitFeatureSettings({
        ...featureSettings,
        masterEnabled: checked,
      }),
    [commitFeatureSettings, featureSettings],
  );
  const toggleCapabilityVisibility = useCallback(
    (capability: AiManagedCapability, checked: boolean) =>
      commitFeatureSettings({
        ...featureSettings,
        capabilities: {
          ...featureSettings.capabilities,
          [capability]: checked,
        },
      }),
    [commitFeatureSettings, featureSettings],
  );
  const toggleFeatureVisibility = useCallback(
    (feature: AiFeatureKey, checked: boolean) =>
      commitFeatureSettings({
        ...featureSettings,
        features: {
          ...featureSettings.features,
          [feature]: checked,
        },
      }),
    [commitFeatureSettings, featureSettings],
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

      <SurfaceCard subtle className={`grid gap-3 ${settingsCardClassName}`}>
        <SectionHeader
          eyebrow="Profiles"
          title="接入配置"
          actions={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leadingIcon={<Plus size={14} />}
              onClick={() => {
                if (isCreatingProfile) {
                  closeCreateProfile();
                  return;
                }
                beginCreateProfile();
              }}
            >
              新建
            </Button>
          }
        />

        {isCreatingProfile ? (
          <div className="rounded-[var(--radius-8)] border border-dashed border-border bg-bg-subtle p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-body font-medium text-text">新建配置</p>
                <p className="mt-1 text-ui text-text-soft">填写后保存为新的 AI 接入配置。</p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={closeCreateProfile}>
                取消
              </Button>
            </div>

            <div className="mt-3">
              <AiProfileEditorFields
                selectedProfile={null}
                draft={profileDraft}
                setDraft={setProfileDraft}
                savePending={saveProfileMutation.isPending}
                deletePending={deleteProfileMutation.isPending}
                profileTestJob={profileTestJob}
                profileTestJobActive={profileTestJobActive}
                testResult={testResult}
                autoFocusName
                onSave={() =>
                  saveProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
                onTest={() =>
                  testProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
              />
            </div>
          </div>
        ) : null}

        {snapshot.profiles.length > 0 ? (
          <div className="grid gap-2.5">
            {snapshot.profiles.map((profile) => (
              <AiProfileRow
                key={profile.id}
                profile={profile}
                expanded={selectedProfileId === profile.id}
                draft={profileDraft}
                setDraft={setProfileDraft}
                savePending={saveProfileMutation.isPending}
                deletePending={deleteProfileMutation.isPending}
                profileTestJob={profileTestJob}
                profileTestJobActive={profileTestJobActive}
                testResult={selectedProfileId === profile.id ? testResult : null}
                onExpand={() => openProfileEditor(profile)}
                onCollapse={closeProfileEditor}
                onSave={() =>
                  saveProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
                onTest={() =>
                  testProfileMutation.mutate({
                    ...profileDraft,
                    apiKey: profileDraft.apiKey?.trim() || undefined,
                  })
                }
                onDelete={() => deleteProfileMutation.mutate({ profileId: profile.id })}
              />
            ))}
          </div>
        ) : !isCreatingProfile ? (
          <EmptyState text="还没有 AI 接入配置。" compact className="min-h-40" />
        ) : null}
      </SurfaceCard>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.88fr)]">
        <div className="grid gap-3">
          <SurfaceCard className={settingsCardClassName}>
            <SectionHeader
              eyebrow="Visibility"
              title="能力开关"
              actions={
                <StatusBadge tone={featureToggleBusy ? "warning" : "neutral"}>
                  {featureToggleBusy ? "保存中" : "实时生效"}
                </StatusBadge>
              }
            />

            <div className="mt-3 grid gap-3">
              <FeatureToggleRow
                label="全局 AI"
                description="关闭后隐藏所有 AI 模块和入口，但会保留下面每一项的开关状态。"
                checked={featureSettings.masterEnabled}
                disabled={featureToggleBusy}
                onChange={toggleMasterEnabled}
              />

              {AI_VISIBLE_CAPABILITY_OPTIONS.map((capability) => {
                const childDisabled =
                  featureToggleBusy ||
                  !featureSettings.masterEnabled ||
                  !featureSettings.capabilities[capability.value];
                const childFeatures = AI_FEATURE_OPTIONS.filter(
                  (feature) => feature.capability === capability.value,
                );

                return (
                  <div
                    key={capability.value}
                    className="rounded-[var(--radius-8)] border border-border bg-bg-subtle px-3 py-3"
                  >
                    <FeatureToggleRow
                      label={aiVisibleCapabilityLabel(capability.value)}
                      description={capabilityDescription(capability.value)}
                      checked={featureSettings.capabilities[capability.value]}
                      disabled={featureToggleBusy || !featureSettings.masterEnabled}
                      onChange={(checked) =>
                        toggleCapabilityVisibility(capability.value, checked)
                      }
                    />

                    {childFeatures.length > 0 ? (
                      <div className="mt-3 border-t border-border pt-3">
                        <p className="text-ui font-medium text-text-soft">子功能</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {childFeatures.map((feature) => (
                            <TogglePill
                              key={feature.value}
                              label={aiFeatureLabel(feature.value)}
                              ariaLabel={`${aiFeatureLabel(feature.value)}开关`}
                              checked={featureSettings.features[feature.value]}
                              disabled={childDisabled}
                              onChange={(checked) =>
                                toggleFeatureVisibility(feature.value, checked)
                              }
                            />
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
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
        </div>

        <div className="grid gap-3">
          <SurfaceCard className={settingsCardClassName}>
            <SectionHeader
              eyebrow="Execution"
              title="AI 调度"
              actions={
                <StatusBadge tone={executionBusy ? "warning" : "neutral"}>
                  {executionBusy ? "保存中" : "默认全局生效"}
                </StatusBadge>
              }
            />

            <div className="mt-3 grid gap-2">
              <p className="text-body text-text-muted">
                控制后台 AI 作业的全局并发量。串行更稳，提升并发后多个区域可以同时排队执行。
              </p>
              <ExecutionModeSwitch
                value={snapshot.execution.maxConcurrency}
                disabled={executionBusy}
                onChange={(maxConcurrency) =>
                  saveExecutionMutation.mutate({ maxConcurrency } as AiExecutionSettings)
                }
              />
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

function AiProfileRow({
  profile,
  expanded,
  draft,
  setDraft,
  savePending,
  deletePending,
  profileTestJob,
  profileTestJobActive,
  testResult,
  onExpand,
  onCollapse,
  onSave,
  onTest,
  onDelete,
}: {
  profile: AiProviderProfileRecord;
  expanded: boolean;
  draft: AiProviderProfileUpsertInput;
  setDraft: Dispatch<SetStateAction<AiProviderProfileUpsertInput>>;
  savePending: boolean;
  deletePending: boolean;
  profileTestJob: ReturnType<typeof useAiJobTarget>;
  profileTestJobActive: boolean;
  testResult: AiProfileTestResult | null;
  onExpand: () => void;
  onCollapse: () => void;
  onSave: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const capabilitySummary = formatProfileCapabilitySummary(profile);
  return (
    <article
      className={[
        "rounded-[var(--radius-8)] border bg-bg transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
        expanded
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))]"
          : "border-border hover:border-border-strong",
      ].join(" ")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left"
        onClick={expanded ? onCollapse : onExpand}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-body font-medium text-text">{profile.name}</p>
            <StatusBadge tone={profile.enabled ? "success" : "warning"}>
              {profile.enabled ? "启用" : "暂停"}
            </StatusBadge>
            <StatusBadge tone="neutral">{aiProviderLabel(profile.providerFamily)}</StatusBadge>
          </div>
          <p className="mt-1 truncate text-ui text-text-soft">
            {profile.defaultModel}
            {capabilitySummary ? ` · ${capabilitySummary}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-ui font-medium text-text-muted">
          {expanded ? "收起" : "展开"}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border px-3 pb-3 pt-3">
          <AiProfileEditorFields
            selectedProfile={profile}
            draft={draft}
            setDraft={setDraft}
            savePending={savePending}
            deletePending={deletePending}
            profileTestJob={profileTestJob}
            profileTestJobActive={profileTestJobActive}
            testResult={testResult}
            onSave={onSave}
            onTest={onTest}
            onDelete={onDelete}
          />
        </div>
      ) : null}
    </article>
  );
}

function AiProfileEditorFields({
  selectedProfile,
  draft,
  setDraft,
  savePending,
  deletePending,
  profileTestJob,
  profileTestJobActive,
  testResult,
  onSave,
  onTest,
  onDelete,
  autoFocusName = false,
}: {
  selectedProfile: AiProviderProfileRecord | null;
  draft: AiProviderProfileUpsertInput;
  setDraft: Dispatch<SetStateAction<AiProviderProfileUpsertInput>>;
  savePending: boolean;
  deletePending: boolean;
  profileTestJob: ReturnType<typeof useAiJobTarget>;
  profileTestJobActive: boolean;
  testResult: AiProfileTestResult | null;
  onSave: () => void;
  onTest: () => void;
  onDelete?: () => void;
  autoFocusName?: boolean;
}) {
  const profileCapabilitySummary = formatProfileCapabilitySummary(draft);
  const keyStatusLabel = draft.apiKey?.trim()
    ? "已输入新密钥"
    : selectedProfile?.hasStoredKey
      ? maskKey(selectedProfile.apiKeyLast4)
      : "未保存密钥";
  const failedTestDetail = testResult && !testResult.success ? testResult.message : undefined;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <StatusBadge tone="neutral">{aiProviderLabel(draft.providerFamily)}</StatusBadge>
        <StatusBadge tone={draft.enabled ? "success" : "warning"}>
          {draft.enabled ? "启用" : "暂停"}
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
            autoFocus={autoFocusName}
            value={draft.name}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Production OpenAI"
          />
        </label>

        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>接入类型</span>
          <select
            value={draft.providerFamily}
            onChange={(event) => {
              const nextFamily = event.target.value as AiProviderFamily;
              const defaults = providerDefaults(nextFamily);
              setDraft((current) => ({
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
            value={draft.baseUrl}
            onChange={(event) =>
              setDraft((current) => ({ ...current, baseUrl: event.target.value }))
            }
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>默认模型</span>
          <TextField
            fieldSize="sm"
            value={draft.defaultModel}
            onChange={(event) =>
              setDraft((current) => ({
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
            value={draft.apiKey ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, apiKey: event.target.value }))
            }
            placeholder={selectedProfile?.hasStoredKey ? "留空则保留当前密钥" : "输入 API Key"}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <TogglePill
          label="文本"
          checked={draft.supportsText}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, supportsText: checked }))
          }
        />
        <TogglePill
          label="图片"
          checked={draft.supportsImage}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, supportsImage: checked }))
          }
        />
        <TogglePill
          label="文件"
          checked={draft.supportsFile}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, supportsFile: checked }))
          }
        />
        <TogglePill
          label="启用"
          checked={draft.enabled}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, enabled: checked }))
          }
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <Button type="button" variant="primary" size="sm" disabled={savePending} onClick={onSave}>
          {savePending ? "保存中..." : "保存"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={profileTestJobActive}
          onClick={onTest}
        >
          {profileTestJob?.status === "queued"
            ? "排队中..."
            : profileTestJobActive
              ? "测试中..."
              : "测试"}
        </Button>
        {onDelete ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={deletePending}
            onClick={onDelete}
          >
            删除
          </Button>
        ) : null}
      </div>

      {testResult ? (
        <SurfaceCard
          subtle
          className="mt-3 flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
          title={failedTestDetail}
        >
          <p className="min-w-0 flex-1 text-body text-text">{testResult.message}</p>
          <div className="flex flex-wrap gap-1.5">
            {testResult.resolvedModel ? (
              <StatusBadge tone="neutral">{testResult.resolvedModel}</StatusBadge>
            ) : null}
            <StatusBadge
              tone={testResult.success ? "success" : "danger"}
              title={failedTestDetail}
              className={failedTestDetail ? "cursor-help" : undefined}
            >
              {testResult.success ? `${testResult.latencyMs ?? 0}ms` : "failed"}
            </StatusBadge>
          </div>
        </SurfaceCard>
      ) : null}
    </>
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

function ExecutionModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: AiExecutionSettings["maxConcurrency"];
  disabled: boolean;
  onChange: (value: AiExecutionSettings["maxConcurrency"]) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {([
        { value: 1, label: "串行(1)" },
        { value: 2, label: "2 并行" },
        { value: 3, label: "3 并行" },
        { value: 4, label: "4 并行" },
      ] as const).map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            className={[
              "rounded-[var(--radius-8)] border px-3 py-2 text-left text-body transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                : "border-border bg-bg text-text-muted hover:border-border-strong hover:text-text",
            ].join(" ")}
            onClick={() => {
              if (!active) {
                onChange(option.value);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function FeatureToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-text">{label}</p>
        <p className="mt-1 text-ui leading-6 text-text-muted">{description}</p>
      </div>
      <TogglePill
        label={checked ? "开启" : "关闭"}
        ariaLabel={`${label}开关`}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

function capabilityDescription(capability: AiManagedCapability) {
  switch (capability) {
    case "assistant":
      return "控制顶栏 Ask 入口与问答面板。";
    case "summary":
      return "控制 Activity / 项目 / Today 的 AI 总结类模块。";
    case "suggestion_generation":
      return "控制记录区的 AI 提炼按钮和候选写入流程。";
    default:
      return capability;
  }
}

function maskKey(last4: string) {
  return last4 ? `已存密钥 •••• ${last4}` : "已保存密钥";
}

function formatProfileCapabilitySummary(profile: {
  supportsText: boolean;
  supportsImage: boolean;
  supportsFile: boolean;
}) {
  return [
    profile.supportsText ? "文本" : null,
    profile.supportsImage ? "图片" : null,
    profile.supportsFile ? "文件" : null,
  ]
    .filter(Boolean)
    .join(" / ");
}

function TogglePill({
  label,
  ariaLabel,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={checked}
      disabled={disabled}
      className={[
        "flex h-8 items-center rounded-[var(--radius-8)] border px-3 text-ui font-medium transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] disabled:cursor-not-allowed disabled:opacity-60",
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
