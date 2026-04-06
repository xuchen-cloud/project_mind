import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Tags, Trash2 } from "lucide-react";

import {
  DEFAULT_ACTIVITY_STATUS_LABEL,
  EMPTY_ACTIVITY_ATTRIBUTE_LABEL,
} from "../../lib/constants";
import type {
  ActivityAttributeOption,
  ActivityStatusOption,
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

interface ActivitySettingsPanelProps {
  open: boolean;
}

export function ActivitySettingsPanel({ open }: ActivitySettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const activitySettingsQuery = useQuery({
    queryKey: ["activity-settings"],
    queryFn: projectMindApi.activitySettingsGet,
    enabled: open,
  });

  const snapshot = activitySettingsQuery.data;
  const [attributeDrafts, setAttributeDrafts] = useState<Record<number, string>>({});
  const [statusDrafts, setStatusDrafts] = useState<
    Record<number, { label: string; needsAttention: boolean }>
  >({});
  const [newAttributeLabel, setNewAttributeLabel] = useState("");
  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [newStatusNeedsAttention, setNewStatusNeedsAttention] = useState(true);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    setAttributeDrafts(
      Object.fromEntries(
        snapshot.activityAttributeOptions.map((option) => [option.id, option.label]),
      ),
    );
    setStatusDrafts(
      Object.fromEntries(
        snapshot.activityStatusOptions.map((option) => [
          option.id,
          {
            label: option.label,
            needsAttention: option.needsAttention,
          },
        ]),
      ),
    );
  }, [snapshot]);

  const refreshAllActivityViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["activity-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["activities"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };

  const attributeUpsertMutation = useMutation({
    mutationFn: projectMindApi.activityAttributeOptionUpsert,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Saved", message: "活动属性已更新" });
      setNewAttributeLabel("");
      await refreshAllActivityViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存活动属性失败" });
      pushToast({ tone: "error", title: "保存活动属性失败", detail: String(error) });
    },
  });

  const attributeDeleteMutation = useMutation({
    mutationFn: projectMindApi.activityAttributeOptionDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "活动属性已删除" });
      await refreshAllActivityViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除活动属性失败" });
      pushToast({ tone: "error", title: "删除活动属性失败", detail: String(error) });
    },
  });

  const statusUpsertMutation = useMutation({
    mutationFn: projectMindApi.activityStatusOptionUpsert,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Saved", message: "活动状态已更新" });
      setNewStatusLabel("");
      setNewStatusNeedsAttention(true);
      await refreshAllActivityViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存活动状态失败" });
      pushToast({ tone: "error", title: "保存活动状态失败", detail: String(error) });
    },
  });

  const statusDeleteMutation = useMutation({
    mutationFn: projectMindApi.activityStatusOptionDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "活动状态已删除" });
      await refreshAllActivityViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除活动状态失败" });
      pushToast({ tone: "error", title: "删除活动状态失败", detail: String(error) });
    },
  });

  const summary = useMemo(
    () => ({
      attributes: snapshot?.activityAttributeOptions.length ?? 0,
      statuses: snapshot?.activityStatusOptions.length ?? 0,
      attentionStatuses:
        snapshot?.activityStatusOptions.filter((option) => option.needsAttention).length ?? 0,
    }),
    [snapshot],
  );

  if (activitySettingsQuery.isLoading && !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载活动标签设置...
      </div>
    );
  }

  if (activitySettingsQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="活动标签设置暂时不可用"
          text="读取活动属性和状态字典失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => activitySettingsQuery.refetch()}>
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
              Activity Labels
            </p>
            <p className="mt-1 text-body text-text-muted">
              统一管理活动属性和活动状态。状态里的“需关注”会直接影响列表警示和项目统计。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">{summary.attributes} 个属性</StatusBadge>
            <StatusBadge tone="neutral">{summary.statuses} 个状态</StatusBadge>
            <StatusBadge tone={summary.attentionStatuses > 0 ? "warning" : "success"}>
              {summary.attentionStatuses} 个需关注
            </StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <SurfaceCard subtle className="grid gap-4 p-4">
          <SectionHeader
            eyebrow="Attribute"
            title="活动属性"
            description={`为空时，活动页头部会显示“${EMPTY_ACTIVITY_ATTRIBUTE_LABEL}”。`}
          />

          <div className="grid gap-3">
            {snapshot.activityAttributeOptions.length > 0 ? (
              snapshot.activityAttributeOptions.map((option) => (
                <AttributeOptionRow
                  key={option.id}
                  option={option}
                  draft={attributeDrafts[option.id] ?? option.label}
                  busy={attributeUpsertMutation.isPending || attributeDeleteMutation.isPending}
                  onDraftChange={(label) =>
                    setAttributeDrafts((current) => ({
                      ...current,
                      [option.id]: label,
                    }))
                  }
                  onSave={() =>
                    attributeUpsertMutation.mutate({
                      id: option.id,
                      label: attributeDrafts[option.id] ?? option.label,
                    })
                  }
                  onDelete={() => attributeDeleteMutation.mutate({ optionId: option.id })}
                />
              ))
            ) : (
              <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
                还没有活动属性。你可以先新增一项，也可以让活动保持不设置属性。
              </p>
            )}
          </div>

          <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">新增活动属性</span>
                <TextField
                  value={newAttributeLabel}
                  onChange={(event) => setNewAttributeLabel(event.target.value)}
                  placeholder="例如：LEGAL / 商务沟通 / 合同推进"
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leadingIcon={<Plus size={14} />}
                disabled={attributeUpsertMutation.isPending || !newAttributeLabel.trim()}
                onClick={() => attributeUpsertMutation.mutate({ label: newAttributeLabel })}
              >
                新增属性
              </Button>
            </div>
          </div>
        </SurfaceCard>

        <SurfaceCard subtle className="grid gap-4 p-4">
          <SectionHeader
            eyebrow="Status"
            title="活动状态"
            description={`未设置状态的活动会自动回落到系统状态“${DEFAULT_ACTIVITY_STATUS_LABEL}”。`}
          />

          <div className="grid gap-3">
            {snapshot.activityStatusOptions.map((option) => (
              <StatusOptionRow
                key={option.id}
                option={option}
                draft={statusDrafts[option.id] ?? { label: option.label, needsAttention: option.needsAttention }}
                busy={statusUpsertMutation.isPending || statusDeleteMutation.isPending}
                onDraftChange={(draft) =>
                  setStatusDrafts((current) => ({
                    ...current,
                    [option.id]: draft,
                  }))
                }
                onSave={() =>
                  statusUpsertMutation.mutate({
                    id: option.id,
                    label: statusDrafts[option.id]?.label ?? option.label,
                    needsAttention:
                      statusDrafts[option.id]?.needsAttention ?? option.needsAttention,
                  })
                }
                onDelete={() => statusDeleteMutation.mutate({ optionId: option.id })}
              />
            ))}
          </div>

          <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
              <label className="grid gap-1.5">
                <span className="text-ui font-medium text-text-muted">新增活动状态</span>
                <TextField
                  value={newStatusLabel}
                  onChange={(event) => setNewStatusLabel(event.target.value)}
                  placeholder="例如：待法务确认 / 已归档 / 待外部反馈"
                />
              </label>
              <AttentionToggle
                label="需关注"
                checked={newStatusNeedsAttention}
                onChange={setNewStatusNeedsAttention}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                leadingIcon={<Plus size={14} />}
                disabled={statusUpsertMutation.isPending || !newStatusLabel.trim()}
                onClick={() =>
                  statusUpsertMutation.mutate({
                    label: newStatusLabel,
                    needsAttention: newStatusNeedsAttention,
                  })
                }
              >
                新增状态
              </Button>
            </div>
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}

function AttributeOptionRow({
  option,
  draft,
  busy,
  onDraftChange,
  onSave,
  onDelete,
}: {
  option: ActivityAttributeOption;
  draft: string;
  busy: boolean;
  onDraftChange: (label: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const isDirty = draft.trim() !== option.label;

  return (
    <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-8)] bg-bg-subtle text-text-soft">
          <Tags size={15} />
        </div>
        <div className="min-w-0 flex-1 grid gap-2">
          <TextField value={draft} onChange={(event) => onDraftChange(event.target.value)} />
          <p className="text-ui text-text-soft">
            删除后，使用该属性的活动会直接回到“未设置属性”。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!isDirty || !draft.trim() || busy}
            onClick={onSave}
          >
            保存
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            leadingIcon={<Trash2 size={14} />}
            disabled={busy}
            onClick={onDelete}
          >
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusOptionRow({
  option,
  draft,
  busy,
  onDraftChange,
  onSave,
  onDelete,
}: {
  option: ActivityStatusOption;
  draft: { label: string; needsAttention: boolean };
  busy: boolean;
  onDraftChange: (draft: { label: string; needsAttention: boolean }) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const isDirty =
    draft.label.trim() !== option.label || draft.needsAttention !== option.needsAttention;

  return (
    <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={draft.needsAttention ? "warning" : "success"}>
              {draft.needsAttention ? "需关注" : "正常"}
            </StatusBadge>
            {option.isSystem ? <StatusBadge tone="neutral">系统内置</StatusBadge> : null}
          </div>
          <TextField
            value={draft.label}
            disabled={option.isSystem}
            onChange={(event) =>
              onDraftChange({
                ...draft,
                label: event.target.value,
              })
            }
          />
          <p className="text-ui text-text-soft">
            这个状态会影响活动列表警示和项目里的待关注统计。
          </p>
        </div>
        <AttentionToggle
          label="需关注"
          checked={draft.needsAttention}
          disabled={option.isSystem}
          onChange={(checked) =>
            onDraftChange({
              ...draft,
              needsAttention: checked,
            })
          }
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={option.isSystem || !isDirty || !draft.label.trim() || busy}
            onClick={onSave}
          >
            保存
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            leadingIcon={<Trash2 size={14} />}
            disabled={option.isSystem || busy}
            onClick={onDelete}
          >
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

function AttentionToggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={[
        "flex h-9 items-center justify-between gap-3 rounded-[var(--radius-8)] border px-3 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] disabled:pointer-events-none disabled:opacity-60",
        checked
          ? "border-[color-mix(in_srgb,var(--color-warning)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-warning)_10%,var(--color-bg))] text-warning"
          : "border-border bg-bg text-text-muted hover:border-border-strong hover:text-text",
      ].join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className="text-ui font-medium">{label}</span>
      <span className="text-caption uppercase tracking-[0.14em]">
        {checked ? "ON" : "OFF"}
      </span>
    </button>
  );
}
