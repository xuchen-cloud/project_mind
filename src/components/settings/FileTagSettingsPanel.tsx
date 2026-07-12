import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import type { FileTagColorKey, FileTagOptionUpsertInput, FileTagRecord } from "../../lib/types";
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

interface FileTagSettingsPanelProps {
  open: boolean;
  projectId: number | null;
}

export function FileTagSettingsPanel({ open, projectId }: FileTagSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const fileTagSettingsQuery = useQuery({
    queryKey: queryKeys.fileTags.project(projectId),
    queryFn: () => projectMindApi.fileTagSettingsGet({ projectId: projectId as number }),
    enabled: open && projectId !== null,
  });

  const snapshot = fileTagSettingsQuery.data;
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [newTagColorKey, setNewTagColorKey] = useState<FileTagColorKey>("blue");

  const refreshViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.fileTags.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
      queryClient.invalidateQueries({ queryKey: ["project-page"] }),
    ]);
  };

  const upsertMutation = useMutation({
    mutationFn: projectMindApi.fileTagOptionUpsert,
    onSuccess: async (_tag, variables) => {
      if (!variables.id) {
        setStatus({ tone: "success", label: "Created", message: "文件标签已新增" });
        setNewTagLabel("");
        setNewTagColorKey("blue");
        setCreateComposerOpen(false);
      }
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存文件标签失败" });
      pushToast({ tone: "error", title: "保存文件标签失败", detail: String(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: projectMindApi.fileTagOptionDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "文件标签已删除" });
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除文件标签失败" });
      pushToast({ tone: "error", title: "删除文件标签失败", detail: String(error) });
    },
  });

  const saveTag = useCallback(
    (input: FileTagOptionUpsertInput) => upsertMutation.mutateAsync(input),
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

  if (projectId === null) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="请先进入一个项目"
          text="项目标签现在按项目独立管理。进入任意项目后，再打开这里配置该项目自己的标签字典。"
          className="w-full max-w-lg"
        />
      </div>
    );
  }

  if (fileTagSettingsQuery.isLoading && !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载文件标签设置...
      </div>
    );
  }

  if (fileTagSettingsQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="文件标签设置暂时不可用"
          text="读取文件标签字典失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => fileTagSettingsQuery.refetch()}>
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
              File Tags
            </p>
            <p className="mt-1 text-body text-text-muted">管理当前项目的文件标签。</p>
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
          title="文件标签"
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
          <FileTagComposer
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
              <FileTagRow
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
                          `删除“${tag.label}”后，会从 ${tag.usageCount} 个文件上移除该标签。确定继续吗？`,
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
              还没有文件标签。先创建几个常用 tag，文件导入和右键菜单里就可以直接复用。
            </p>
          )}
        </div>
      </SurfaceCard>
    </div>
  );
}

function FileTagRow({
  projectId,
  tag,
  busy,
  onSave,
  onDelete,
}: {
  projectId: number;
  tag: FileTagRecord;
  busy: boolean;
  onSave: (input: FileTagOptionUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(tag.label);
  const [colorKey, setColorKey] = useState<FileTagColorKey>(tag.colorKey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSubmittedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setLabel(tag.label);
    setColorKey(tag.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [tag.colorKey, tag.id, tag.label]);

  const submit = useCallback(
    (nextLabel: string, nextColorKey: FileTagColorKey) => {
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
        <FileTagColorPicker
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
          style={{ backgroundColor: fileTagColorValue(tag.colorKey) }}
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

function FileTagComposer({
  label,
  colorKey,
  busy,
  onLabelChange,
  onColorChange,
  onCancel,
  onSubmit,
}: {
  label: string;
  colorKey: FileTagColorKey;
  busy: boolean;
  onLabelChange: (value: string) => void;
  onColorChange: (value: FileTagColorKey) => void;
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
        <FileTagColorPicker
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

function FileTagColorPicker({
  selectedColorKey,
  disabled = false,
  onSelect,
}: {
  selectedColorKey: FileTagColorKey;
  disabled?: boolean;
  onSelect: (colorKey: FileTagColorKey) => void;
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
