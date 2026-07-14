import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";

import { tagColorValue } from "../../lib/constants";
import type { TagColorKey, ProjectTagUpsertInput, ProjectTagRecord } from "../../lib/types";
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
import { ColorKeyDropdown } from "./ColorKeyDropdown";

interface ProjectTagSettingsPanelProps {
  open: boolean;
  projectId: number | null;
}

export function ProjectTagSettingsPanel({ open, projectId }: ProjectTagSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const isWorkspaceScope = projectId === null;
  const scopeTagLabel = isWorkspaceScope ? "Workspace 标签" : "项目标签";
  const projectTagSettingsQuery = useQuery({
    queryKey: isWorkspaceScope
      ? queryKeys.projectTags.workspace
      : queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
    enabled: open,
  });

  const snapshot = projectTagSettingsQuery.data;
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [newTagColorKey, setNewTagColorKey] = useState<TagColorKey>("blue");

  const refreshViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
      queryClient.invalidateQueries({ queryKey: ["project-page"] }),
    ]);
  };

  const upsertMutation = useMutation({
    mutationFn: projectMindApi.projectTagUpsert,
    onSuccess: async (_tag, variables) => {
      if (!variables.id) {
        setStatus({ tone: "success", label: "Created", message: `${scopeTagLabel}已新增` });
        setNewTagLabel("");
        setNewTagColorKey("blue");
        setCreateComposerOpen(false);
      }
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: `保存${scopeTagLabel}失败` });
      pushToast({ tone: "error", title: `保存${scopeTagLabel}失败`, detail: String(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: projectMindApi.projectTagDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: `${scopeTagLabel}已删除` });
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: `删除${scopeTagLabel}失败` });
      pushToast({ tone: "error", title: `删除${scopeTagLabel}失败`, detail: String(error) });
    },
  });

  const saveTag = useCallback(
    (input: ProjectTagUpsertInput) => upsertMutation.mutateAsync(input),
    [upsertMutation],
  );

  const summary = useMemo(
    () => ({
      tagCount: snapshot?.tags.length ?? 0,
      usedCount: snapshot?.tags.filter((tag) => tag.usageCount > 0).length ?? 0,
      assignmentCount: snapshot?.tags.reduce((sum, tag) => sum + tag.usageCount, 0) ?? 0,
    }),
    [snapshot],
  );

  if (projectTagSettingsQuery.isLoading && !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载{scopeTagLabel}设置...
      </div>
    );
  }

  if (projectTagSettingsQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title={`${scopeTagLabel}设置暂时不可用`}
          text={`读取${scopeTagLabel}字典失败。可以重试一次，或稍后再打开。`}
          action={
            <Button type="button" variant="secondary" onClick={() => projectTagSettingsQuery.refetch()}>
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
              {isWorkspaceScope ? "Workspace Tags" : "Project Tags"}
            </p>
            <p className="mt-1 text-body text-text-muted">
              {isWorkspaceScope
                ? "管理 Workspace 快速笔记和 Record 使用的独立标签。"
                : "管理当前项目中 Record、Todo 和文件共用的标签。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">{summary.tagCount} 个标签</StatusBadge>
            <StatusBadge tone={summary.usedCount > 0 ? "accent" : "neutral"}>
              {summary.usedCount} 个已使用
            </StatusBadge>
            <StatusBadge tone="neutral">{summary.assignmentCount} 条关联</StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard subtle className="grid gap-4 p-4">
        <SectionHeader
          eyebrow="Dictionary"
          title={scopeTagLabel}
          actions={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leadingIcon={<Plus size={14} />}
              onClick={() =>
                setCreateComposerOpen((current) => {
                  const nextOpen = !current;
                  if (!nextOpen) {
                    setNewTagLabel("");
                    setNewTagColorKey("blue");
                  }
                  return nextOpen;
                })
              }
            >
              新建标签
            </Button>
          }
        />

        {createComposerOpen ? (
          <ProjectTagComposer
            label={newTagLabel}
            colorKey={newTagColorKey}
            busy={upsertMutation.isPending}
            onLabelChange={setNewTagLabel}
            onColorChange={setNewTagColorKey}
            onCancel={() => {
              setCreateComposerOpen(false);
              setNewTagLabel("");
              setNewTagColorKey("blue");
            }}
            onSubmit={() =>
              upsertMutation.mutateAsync({
                projectId,
                label: newTagLabel.trim(),
                colorKey: newTagColorKey,
              })
            }
          />
        ) : null}

        <div className="grid gap-3">
          {snapshot.tags.length > 0 ? (
            snapshot.tags.map((tag) => (
              <ProjectTagRow
                key={tag.id}
                projectId={projectId}
                tag={tag}
                busy={upsertMutation.isPending || deleteMutation.isPending}
                onSave={saveTag}
                onDelete={() => {
                  const confirmed =
                    typeof window === "undefined"
                      ? true
                      : window.confirm(
                          `删除“${tag.label}”后，会从 ${tag.usageCount} 处关联内容中移除该标签。确定继续吗？`,
                        );
                  if (!confirmed) {
                    return;
                  }
                  deleteMutation.mutate({ projectId, tagId: tag.id });
                }}
              />
            ))
          ) : (
            <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
              {isWorkspaceScope
                ? "还没有 Workspace 标签。创建后可以在 Workspace 记录中复用。"
                : "还没有项目标签。创建后可以在 Record、Todo 和文件中复用。"}
            </p>
          )}
        </div>
      </SurfaceCard>
    </div>
  );
}

function ProjectTagRow({
  projectId,
  tag,
  busy,
  onSave,
  onDelete,
}: {
  projectId: number | null;
  tag: ProjectTagRecord;
  busy: boolean;
  onSave: (input: ProjectTagUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(tag.label);
  const [colorKey, setColorKey] = useState<TagColorKey>(tag.colorKey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSubmittedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setLabel(tag.label);
    setColorKey(tag.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [tag.colorKey, tag.id, tag.label]);

  const submit = useCallback(
    (nextLabel: string, nextColorKey: TagColorKey) => {
      const normalizedLabel = nextLabel.trim();
      const signature = `${normalizedLabel}::${nextColorKey}`;
      const dirty =
        normalizedLabel.length > 0 &&
        (normalizedLabel !== tag.label || nextColorKey !== tag.colorKey);

      if (!dirty || lastSubmittedSignatureRef.current === signature) {
        return;
      }

      lastSubmittedSignatureRef.current = signature;
      void onSave({
        projectId,
        id: tag.id,
        label: normalizedLabel,
        colorKey: nextColorKey,
      }).catch(() => {
        if (lastSubmittedSignatureRef.current === signature) {
          lastSubmittedSignatureRef.current = null;
        }
      });
    },
    [onSave, tag.colorKey, tag.id, tag.label],
  );

  const cancelEdit = useCallback(() => {
    setLabel(tag.label);
    setColorKey(tag.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [tag.colorKey, tag.label]);

  const commitAndClose = useCallback(() => {
    if (!label.trim()) {
      cancelEdit();
      return;
    }

    submit(label, colorKey);
    setEditing(false);
  }, [cancelEdit, colorKey, label, submit]);

  useEffect(() => {
    if (!editing || busy) {
      return undefined;
    }

    const normalizedLabel = label.trim();
    if (!normalizedLabel || (normalizedLabel === tag.label && colorKey === tag.colorKey)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      submit(label, colorKey);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [busy, colorKey, editing, label, submit, tag.colorKey, tag.label]);

  if (editing) {
    return (
      <div
        ref={rootRef}
        className="flex flex-wrap items-center gap-2 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2.5"
        onBlurCapture={(event) => {
          const nextFocus = event.relatedTarget instanceof Node ? event.relatedTarget : null;
          if (nextFocus && rootRef.current?.contains(nextFocus)) {
            return;
          }
          commitAndClose();
        }}
      >
        <TextField
          autoFocus
          fieldSize="sm"
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitAndClose();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          className="min-w-[12rem] flex-1"
        />
        <ProjectTagColorPicker
          selectedColorKey={colorKey}
          disabled={busy}
          onSelect={(nextColorKey) => {
            setColorKey(nextColorKey);
            submit(label, nextColorKey);
          }}
        />
        {tag.usageCount > 0 ? <StatusBadge tone="neutral">{tag.usageCount} 文件</StatusBadge> : null}
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>
          取消
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
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-6)] bg-transparent py-1 text-left transition-colors hover:text-text-soft"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={{ backgroundColor: tagColorValue(tag.colorKey) }}
          aria-hidden="true"
        />
        <span className="truncate text-body text-text">{tag.label}</span>
        {tag.usageCount > 0 ? <StatusBadge tone="neutral">{tag.usageCount} 文件</StatusBadge> : null}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
          编辑
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
  );
}

function ProjectTagComposer({
  label,
  colorKey,
  busy,
  onLabelChange,
  onColorChange,
  onCancel,
  onSubmit,
}: {
  label: string;
  colorKey: TagColorKey;
  busy: boolean;
  onLabelChange: (value: string) => void;
  onColorChange: (value: TagColorKey) => void;
  onCancel: () => void;
  onSubmit: () => Promise<unknown>;
}) {
  const canSubmit = label.trim().length > 0 && !busy;

  return (
    <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <TextField
          autoFocus
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (canSubmit) {
                void onSubmit().catch(() => undefined);
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          placeholder="例如：法务 / 合同 / 待审核"
          className="min-w-[12rem] flex-1"
        />
        <ProjectTagColorPicker
          selectedColorKey={colorKey}
          disabled={busy}
          onSelect={onColorChange}
        />
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canSubmit}
          onClick={() => {
            void onSubmit().catch(() => undefined);
          }}
        >
          创建标签
        </Button>
      </div>
    </div>
  );
}

function ProjectTagColorPicker({
  selectedColorKey,
  disabled = false,
  onSelect,
}: {
  selectedColorKey: TagColorKey;
  disabled?: boolean;
  onSelect: (colorKey: TagColorKey) => void;
}) {
  return (
    <ColorKeyDropdown
      value={selectedColorKey}
      size="sm"
      disabled={disabled}
      className="min-w-[8.5rem]"
      ariaLabel="颜色"
      onChange={onSelect}
    />
  );
}
