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
import { ArrowDown, ArrowUp, LoaderCircle, Plus } from "lucide-react";

import {
  bindingForCapability,
  createAiProfileDraft,
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
  AI_PROVIDER_FAMILY_OPTIONS,
  aiCapabilityLabel,
  aiProviderLabel,
} from "../../lib/constants";
import type {
  AiCapability,
  AiCapabilityBindingUpsertInput,
  AiEditorSkillRecord,
  AiEditorSkillResultMode,
  AiEditorSkillUpsertInput,
  AiExecutionSettings,
  AiProfileTestResult,
  AiProviderFamily,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
} from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { queryKeys } from "../../lib/queryKeys";
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
  settingsFieldHintClassName,
  settingsFieldLabelClassName,
  settingsSelectClassName,
} from "./shared";

const EDITOR_SKILL_LIMIT = 24;

interface BindingDraft {
  profileId: string;
  model: string;
}

interface EditorSkillDraft {
  id?: string;
  name: string;
  icon: string;
  description: string;
  prompt: string;
  resultMode: AiEditorSkillResultMode;
  showInTextMenu: boolean;
  sortOrder?: number;
  enabled: boolean;
}

interface LegacyEditorRewriteAction {
  id: number;
  label: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AiSettingsPanelProps {
  open: boolean;
  section: "models" | "rewrite";
  onUnlockAiSecrets?: () => Promise<boolean>;
}

export function AiSettingsPanel({
  open,
  section,
  onUnlockAiSecrets = async () => false,
}: AiSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: open,
  });

  const snapshot = aiSettingsQuery.data;
  const editorSkills =
    snapshot?.editorSkills ??
    ((snapshot as unknown as { editorRewriteActions?: LegacyEditorRewriteAction[] } | undefined)
      ?.editorRewriteActions ?? []).map(legacyRewriteActionToSkill);
  const aiSecretsUnlocked = snapshot?.aiSecretsUnlocked ?? true;
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState<AiProviderProfileUpsertInput>(
    createAiProfileDraft(),
  );
  const [testResult, setTestResult] = useState<AiProfileTestResult | null>(null);
  const [isCreatingSkill, setIsCreatingSkill] = useState(false);
  const [skillDraft, setSkillDraft] = useState<EditorSkillDraft>(
    createEditorSkillDraft(),
  );

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

  const saveProfileMutation = useMutation({
    mutationFn: projectMindApi.aiProfileUpsert,
    onSuccess: async (profile, variables) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 接入配置已保存" });
      setSelectedProfileId(variables.id ? profile.id : null);
      setIsCreatingProfile(false);
      setProfileDraft(variables.id ? buildProfileDraft(profile) : createAiProfileDraft());
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
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
      queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) => {
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
      queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) =>
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
  const saveEditorSkillMutation = useMutation({
    mutationFn: projectMindApi.aiEditorSkillUpsert,
    onSuccess: async (skill) => {
      setStatus({ tone: "success", label: "Saved", message: "AI 技能已保存" });
      setIsCreatingSkill(false);
      setSkillDraft(createEditorSkillDraft());
      queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) =>
        current
          ? {
              ...current,
              editorSkills: upsertEditorSkillRecord(
                current.editorSkills ??
                  ((current as unknown as { editorRewriteActions?: AiEditorSkillRecord[] })
                    .editorRewriteActions ?? []),
                skill,
              ),
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "保存 AI 技能失败");
      setStatus({ tone: "error", label: "Error", message: "保存 AI 技能失败" });
      pushToast({ tone: "error", title: "保存 AI 技能失败", detail });
    },
  });
  const deleteEditorSkillMutation = useMutation({
    mutationFn: projectMindApi.aiEditorSkillDelete,
    onSuccess: async (skills) => {
      setStatus({ tone: "success", label: "Deleted", message: "AI 技能已删除" });
      queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) =>
        current
          ? {
              ...current,
              editorSkills: skills,
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "删除 AI 技能失败");
      setStatus({ tone: "error", label: "Error", message: "删除 AI 技能失败" });
      pushToast({ tone: "error", title: "删除 AI 技能失败", detail });
    },
  });
  const reorderEditorSkillMutation = useMutation({
    mutationFn: projectMindApi.aiEditorSkillReorder,
    onSuccess: async (skills) => {
      queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) =>
        current
          ? {
              ...current,
              editorSkills: skills,
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
    },
    onError: (error) => {
      const detail = getErrorMessage(error, "调整 AI 技能顺序失败");
      pushToast({ tone: "error", title: "调整 AI 技能顺序失败", detail });
    },
  });

  const enabledProfilesCount = snapshot?.profiles.filter((profile) => profile.enabled).length ?? 0;
  const bindingControlsBusy = saveBindingMutation.isPending;
  const executionBusy = saveExecutionMutation.isPending;
  const editorSkillsBusy =
    saveEditorSkillMutation.isPending ||
    deleteEditorSkillMutation.isPending ||
    reorderEditorSkillMutation.isPending;
  const canCreateSkill =
    editorSkills.length < EDITOR_SKILL_LIMIT;

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
  const beginCreateSkill = useCallback(() => {
    setIsCreatingSkill(true);
    setSkillDraft(createEditorSkillDraft());
  }, []);
  const closeCreateSkill = useCallback(() => {
    setIsCreatingSkill(false);
    setSkillDraft(createEditorSkillDraft());
  }, []);

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

  if (section === "rewrite") {
    return (
      <div className="grid gap-3">
        <SurfaceCard subtle className="px-3.5 py-3 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div>
              <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                AI Skills
              </p>
              <p className="mt-0.5 text-body text-text-muted">
                配置选中文本后可以调用的 AI 技能、结果模式和菜单显隐。
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <StatusBadge tone={editorSkills.length >= EDITOR_SKILL_LIMIT ? "warning" : "neutral"}>
                {editorSkills.length}/{EDITOR_SKILL_LIMIT} 个技能
              </StatusBadge>
              <StatusBadge tone={isAiCapabilityConfigured(snapshot, "editor_rewrite") ? "success" : "warning"}>
                {isAiCapabilityConfigured(snapshot, "editor_rewrite") ? "模型已就绪" : "模型待配置"}
              </StatusBadge>
            </div>
          </div>
        </SurfaceCard>

        <SurfaceCard className={settingsCardClassName}>
          <SectionHeader
            eyebrow="Skills"
            title="AI 技能"
            actions={
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge tone={editorSkillsBusy ? "warning" : "neutral"}>
                  {editorSkillsBusy ? "保存中" : "同步到文本菜单"}
                </StatusBadge>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Plus size={14} />}
                  disabled={!canCreateSkill && !isCreatingSkill}
                  onClick={() => {
                    if (isCreatingSkill) {
                      closeCreateSkill();
                      return;
                    }
                    beginCreateSkill();
                  }}
                >
                  {isCreatingSkill ? "取消" : "新增技能"}
                </Button>
              </div>
            }
          />

          <div className="mt-3 grid gap-2.5">
            <p className="text-body text-text-muted">
              用户选中文本后，右键即可调用启用并显示在文本菜单中的技能。交互由结果模式决定，而不是技能名称。
            </p>
            <p className="text-ui text-text-soft">
              修改原文会先进入预览，生成回答会展示卡片；禁用技能不会出现在文本菜单中。
            </p>

            {!canCreateSkill && !isCreatingSkill ? (
              <SurfaceCard subtle className="px-3 py-2.5">
                <p className="text-body text-text-muted">
                  已达到 {EDITOR_SKILL_LIMIT} 个技能上限。删除一个技能后可以继续新增。
                </p>
              </SurfaceCard>
            ) : null}

            {isCreatingSkill ? (
              <EditorSkillEditor
                draft={skillDraft}
                setDraft={setSkillDraft}
                busy={editorSkillsBusy}
                autoFocusName
                onSave={() => saveEditorSkillMutation.mutate(toEditorSkillInput(skillDraft))}
                onCancel={closeCreateSkill}
              />
            ) : null}

            {editorSkills.length > 0 ? (
              <div className="grid gap-2.5">
                {editorSkills.map((skill, index) => (
                  <EditorSkillRow
                    key={skill.id}
                    skill={skill}
                    busy={editorSkillsBusy}
                    canMoveUp={index > 0}
                    canMoveDown={index < editorSkills.length - 1}
                    onSave={(input) => saveEditorSkillMutation.mutate(input)}
                    onDelete={(skillId) =>
                      deleteEditorSkillMutation.mutate({ skillId })
                    }
                    onMove={(direction) => {
                      const nextSkills = moveEditorSkill(editorSkills, index, direction);
                      reorderEditorSkillMutation.mutate({
                        skillIds: nextSkills.map((item) => item.id),
                      });
                    }}
                  />
                ))}
              </div>
            ) : !isCreatingSkill ? (
              <EmptyState
                compact
                className="min-h-36"
                text="还没有 AI 技能。新增后，右键文本选区就能直接调用。"
              />
            ) : null}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <SurfaceCard subtle className="px-3.5 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              AI Models
            </p>
            <p className="mt-0.5 text-body text-text-muted">接入配置、模型绑定与调度。</p>
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
          title="AI 模型配置"
          actions={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leadingIcon={<Plus size={14} />}
              disabled={!aiSecretsUnlocked}
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

        {!aiSecretsUnlocked ? (
          <SurfaceCard subtle className="rounded-[var(--radius-8)] border border-dashed border-border bg-bg-subtle p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-body font-medium text-text">Workspace secrets 已锁定</p>
                <p className="mt-1 text-ui text-text-soft">
                  保存 API Key、测试连接和执行 AI 改写前，需要先输入当前 workspace 密码。
                </p>
              </div>
              <Button type="button" size="sm" variant="primary" onClick={() => void onUnlockAiSecrets()}>
                解锁 Secrets
              </Button>
            </div>
          </SurfaceCard>
        ) : null}

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
                actionsDisabled={!aiSecretsUnlocked}
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
                actionsDisabled={!aiSecretsUnlocked}
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
        <SurfaceCard className={settingsCardClassName}>
          <SectionHeader
            eyebrow="Bindings"
            title="模型绑定"
            actions={
              <StatusBadge tone={bindingControlsBusy ? "warning" : "neutral"}>
                {bindingControlsBusy ? "同步中" : "自动保存"}
              </StatusBadge>
            }
          />

          <div className="mt-3 grid gap-2.5">
            {AI_CAPABILITY_OPTIONS.map((option) => (
              <BindingRow
                key={option.value}
                snapshot={snapshot}
                capability={option.value}
                busy={bindingControlsBusy}
                onSave={(input) => saveBindingMutation.mutateAsync(input)}
              />
            ))}
          </div>
        </SurfaceCard>

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
            <StatusBadge tone="neutral">Workspace 密码加密</StatusBadge>
            <p className="text-body text-text-muted">
              AI 密钥跟随当前 workspace 一起保存，切换或复制 workspace 后可继续使用同一套配置。
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
  actionsDisabled,
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
  actionsDisabled: boolean;
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
            actionsDisabled={actionsDisabled}
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
  actionsDisabled,
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
  actionsDisabled: boolean;
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
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={savePending || actionsDisabled}
          onClick={onSave}
        >
          {savePending ? "保存中..." : "保存"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={profileTestJobActive || actionsDisabled}
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

function createEditorSkillDraft(
  skill?: AiEditorSkillRecord | null,
): EditorSkillDraft {
  return {
    id: skill?.id,
    name: skill?.name ?? "",
    icon: skill?.icon ?? "",
    description: skill?.description ?? "",
    prompt: skill?.prompt ?? "",
    resultMode: skill?.resultMode ?? "modify",
    showInTextMenu: skill?.showInTextMenu ?? true,
    sortOrder: skill?.sortOrder,
    enabled: skill?.enabled ?? true,
  };
}

function legacyRewriteActionToSkill(
  action: LegacyEditorRewriteAction,
  index: number,
): AiEditorSkillRecord {
  return {
    id: `rewrite-action-${action.id}`,
    name: action.label,
    icon: null,
    description: null,
    prompt: action.prompt,
    resultMode: "modify",
    showInTextMenu: true,
    sortOrder: index + 1,
    enabled: action.enabled,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function toEditorSkillInput(draft: EditorSkillDraft): AiEditorSkillUpsertInput {
  return {
    id: draft.id,
    name: draft.name,
    icon: draft.icon,
    description: draft.description,
    prompt: draft.prompt,
    resultMode: draft.resultMode,
    showInTextMenu: draft.showInTextMenu,
    sortOrder: draft.sortOrder,
    enabled: draft.enabled,
  };
}

function upsertEditorSkillRecord(
  skills: AiEditorSkillRecord[],
  nextSkill: AiEditorSkillRecord,
) {
  const index = skills.findIndex((skill) => skill.id === nextSkill.id);
  if (index < 0) {
    return [...skills, nextSkill].sort(sortEditorSkills);
  }

  return skills
    .map((skill, currentIndex) => (currentIndex === index ? nextSkill : skill))
    .sort(sortEditorSkills);
}

function sortEditorSkills(left: AiEditorSkillRecord, right: AiEditorSkillRecord) {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-Hans-CN");
}

function moveEditorSkill(
  skills: AiEditorSkillRecord[],
  index: number,
  direction: "up" | "down",
) {
  const next = [...skills];
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= next.length) {
    return next;
  }
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}

function EditorSkillRow({
  skill,
  busy,
  canMoveUp,
  canMoveDown,
  onSave,
  onDelete,
  onMove,
}: {
  skill: AiEditorSkillRecord;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSave: (input: AiEditorSkillUpsertInput) => void;
  onDelete: (skillId: string) => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<EditorSkillDraft>(() =>
    createEditorSkillDraft(skill),
  );

  useEffect(() => {
    setDraft(createEditorSkillDraft(skill));
  }, [skill]);

  return (
    <article
      className={[
        "rounded-[var(--radius-8)] border bg-bg transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
        expanded
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))]"
          : "border-border hover:border-border-strong",
      ].join(" ")}
    >
      <div
        className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-8)] border border-border bg-bg-muted text-ui">
              {skill.icon?.trim() || "✦"}
            </span>
            <p className="truncate text-body font-medium text-text">{skill.name}</p>
            <StatusBadge tone={skill.resultMode === "modify" ? "neutral" : "success"}>
              {skill.resultMode === "modify" ? "修改原文" : "生成回答"}
            </StatusBadge>
            <StatusBadge tone={skill.enabled ? "success" : "warning"}>
              {skill.enabled ? "启用" : "停用"}
            </StatusBadge>
            <StatusBadge tone={skill.showInTextMenu ? "neutral" : "warning"}>
              {skill.showInTextMenu ? "文本菜单" : "已隐藏"}
            </StatusBadge>
          </div>
          <p className="mt-1 line-clamp-2 text-ui text-text-soft">
            {skill.description?.trim() || skill.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-8)] text-text-soft hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:text-text-disabled"
            aria-label="上移技能"
            disabled={busy || !canMoveUp}
            onClick={(event) => {
              event.stopPropagation();
              onMove("up");
            }}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-8)] text-text-soft hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:text-text-disabled"
            aria-label="下移技能"
            disabled={busy || !canMoveDown}
            onClick={(event) => {
              event.stopPropagation();
              onMove("down");
            }}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            aria-expanded={expanded}
            className="rounded-[var(--radius-8)] px-2 py-1 text-ui font-medium text-text-muted hover:bg-bg-hover hover:text-text"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border px-3 pb-3 pt-3">
          <EditorSkillEditor
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            onSave={() =>
              onSave({
                ...toEditorSkillInput(draft),
                id: skill.id,
                sortOrder: skill.sortOrder,
              })
            }
            onDelete={() => onDelete(skill.id)}
          />
        </div>
      ) : null}
    </article>
  );
}

function EditorSkillEditor({
  draft,
  setDraft,
  busy,
  onSave,
  onCancel,
  onDelete,
  autoFocusName = false,
}: {
  draft: EditorSkillDraft;
  setDraft: Dispatch<SetStateAction<EditorSkillDraft>>;
  busy: boolean;
  onSave: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  autoFocusName?: boolean;
}) {
  return (
    <>
      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-[5rem_minmax(0,1fr)]">
          <label className={settingsFieldClassName}>
            <span className={settingsFieldLabelClassName}>图标</span>
            <TextField
              fieldSize="sm"
              value={draft.icon}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({ ...current, icon: event.target.value }))
              }
              placeholder="✦"
            />
          </label>
          <label className={settingsFieldClassName}>
            <span className={settingsFieldLabelClassName}>技能名称</span>
            <TextField
              fieldSize="sm"
              autoFocus={autoFocusName}
              value={draft.name}
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="比如：翻译成英文"
            />
          </label>
        </div>

        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>技能描述</span>
          <TextField
            fieldSize="sm"
            value={draft.description}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
            placeholder="可选，用来说明这个技能会做什么"
          />
        </label>

        <label className={settingsFieldClassName}>
          <span className={settingsFieldLabelClassName}>提示词</span>
          <textarea
            value={draft.prompt}
            disabled={busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, prompt: event.target.value }))
            }
            rows={5}
            className="min-h-28 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2.5 text-body text-text outline-none transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent disabled:bg-bg-subtle disabled:text-text-soft"
            placeholder="比如：请保持原意，把这段文字翻译成自然、专业的英文。"
          />
          <span className={settingsFieldHintClassName}>
            这里只写技能意图即可，系统会自动注入选中文本，并按结果模式约束 AI 输出。
          </span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={draft.resultMode}
          disabled={busy}
          className={settingsSelectClassName}
          aria-label="技能结果模式"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              resultMode: event.target.value as AiEditorSkillResultMode,
            }))
          }
        >
          <option value="modify">修改原文</option>
          <option value="answer">生成回答</option>
        </select>
        <TogglePill
          label={draft.enabled ? "启用" : "停用"}
          ariaLabel="AI 技能启用开关"
          checked={draft.enabled}
          disabled={busy}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, enabled: checked }))
          }
        />
        <TogglePill
          label={draft.showInTextMenu ? "显示在文本菜单" : "从文本菜单隐藏"}
          ariaLabel="AI 技能文本菜单显示开关"
          checked={draft.showInTextMenu}
          disabled={busy}
          onChange={(checked) =>
            setDraft((current) => ({ ...current, showInTextMenu: checked }))
          }
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={onSave}>
          {busy ? "保存中..." : "保存"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        ) : null}
        {onDelete ? (
          <Button type="button" variant="danger" size="sm" disabled={busy} onClick={onDelete}>
            删除
          </Button>
        ) : null}
      </div>
    </>
  );
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
