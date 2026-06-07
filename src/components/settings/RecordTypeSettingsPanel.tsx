import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import type {
  FileTagColorKey,
  RecordTypeOptionUpsertInput,
  RecordTypeRecord,
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
import { cn } from "../../ui/lib/cn";
import { RichEditor, type RichEditorPersistState } from "../rich-editor";
import { ColorKeyDropdown } from "./ColorKeyDropdown";
import { settingsCardClassName } from "./shared";

const EMPTY_TEMPLATE_HTML = "<p></p>";

interface RecordTypeSettingsPanelProps {
  open: boolean;
}

export function RecordTypeSettingsPanel({ open }: RecordTypeSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const recordTypeSettingsQuery = useQuery({
    queryKey: ["record-type-settings"],
    queryFn: projectMindApi.recordTypeSettingsGet,
    enabled: open,
  });

  const snapshot = recordTypeSettingsQuery.data;
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const [newTypeColorKey, setNewTypeColorKey] = useState<FileTagColorKey>("blue");
  const [expandedTypeId, setExpandedTypeId] = useState<number | null>(null);
  const [collapseOnPristineBlurTypeId, setCollapseOnPristineBlurTypeId] = useState<number | null>(null);

  useEffect(() => {
    if (!snapshot?.recordTypes.length) {
      setExpandedTypeId(null);
      setCollapseOnPristineBlurTypeId(null);
      return;
    }

    if (
      expandedTypeId !== null &&
      !snapshot.recordTypes.some((recordType) => recordType.id === expandedTypeId)
    ) {
      setExpandedTypeId(null);
    }

    if (
      collapseOnPristineBlurTypeId !== null &&
      !snapshot.recordTypes.some((recordType) => recordType.id === collapseOnPristineBlurTypeId)
    ) {
      setCollapseOnPristineBlurTypeId(null);
    }
  }, [collapseOnPristineBlurTypeId, expandedTypeId, snapshot]);

  useEffect(() => {
    if (
      collapseOnPristineBlurTypeId !== null &&
      expandedTypeId !== null &&
      expandedTypeId !== collapseOnPristineBlurTypeId
    ) {
      setCollapseOnPristineBlurTypeId(null);
    }
  }, [collapseOnPristineBlurTypeId, expandedTypeId]);

  const refreshViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["record-type-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["activities"] }),
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };

  const upsertMutation = useMutation({
    mutationFn: projectMindApi.recordTypeOptionUpsert,
    onSuccess: async (recordType, variables) => {
      if (!variables.id) {
        setNewTypeLabel("");
        setNewTypeColorKey("blue");
        setCreateComposerOpen(false);
        setExpandedTypeId(recordType.id);
        setCollapseOnPristineBlurTypeId(recordType.id);
      }

      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存记录类型失败" });
      pushToast({ tone: "error", title: "保存记录类型失败", detail: String(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: projectMindApi.recordTypeOptionDelete,
    onSuccess: async () => {
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除记录类型失败" });
      pushToast({ tone: "error", title: "删除记录类型失败", detail: String(error) });
    },
  });

  const saveRecordType = useCallback(
    (input: RecordTypeOptionUpsertInput) => upsertMutation.mutateAsync(input),
    [upsertMutation],
  );

  const summary = useMemo(
    () => ({
      typeCount: snapshot?.recordTypes.length ?? 0,
      usedCount: snapshot?.recordTypes.filter((recordType) => recordType.usageCount > 0).length ?? 0,
    }),
    [snapshot],
  );

  if (recordTypeSettingsQuery.isLoading && !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载记录类型设置...
      </div>
    );
  }

  if (recordTypeSettingsQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="记录类型设置暂时不可用"
          text="读取记录类型字典失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => recordTypeSettingsQuery.refetch()}>
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
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Record Types
            </p>
            <p className="mt-0.5 text-body text-text-muted">记录类型与模板。</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge tone="neutral">{summary.typeCount} 个类型</StatusBadge>
            <StatusBadge tone="neutral">{summary.usedCount} 个已使用</StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard subtle className={cn("grid gap-4", settingsCardClassName)}>
        <SectionHeader
          eyebrow="Dictionary"
          title="记录类型"
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
                    setNewTypeLabel("");
                    setNewTypeColorKey("blue");
                  }
                  return nextOpen;
                })
              }
            >
              新建
            </Button>
          }
        />

        {createComposerOpen ? (
          <RecordTypeComposer
            label={newTypeLabel}
            colorKey={newTypeColorKey}
            busy={upsertMutation.isPending}
            onLabelChange={setNewTypeLabel}
            onColorChange={setNewTypeColorKey}
            onCancel={() => {
              setCreateComposerOpen(false);
              setNewTypeLabel("");
              setNewTypeColorKey("blue");
            }}
            onSubmit={() =>
              upsertMutation.mutateAsync({
                label: newTypeLabel.trim(),
                colorKey: newTypeColorKey,
                templateHtml: EMPTY_TEMPLATE_HTML,
                isDefault: false,
              })
            }
          />
        ) : null}

        <div className="grid gap-3">
          {snapshot.recordTypes.map((recordType) => (
            <RecordTypeRow
              key={recordType.id}
              recordType={recordType}
              expanded={expandedTypeId === recordType.id}
              collapseOnPristineBlur={collapseOnPristineBlurTypeId === recordType.id}
              saving={upsertMutation.isPending}
              deleting={deleteMutation.isPending}
              onExpand={() => setExpandedTypeId(recordType.id)}
              onCollapse={() => {
                setExpandedTypeId((current) => (current === recordType.id ? null : current));
                setCollapseOnPristineBlurTypeId((current) =>
                  current === recordType.id ? null : current,
                );
              }}
              onDirty={() => {
                setCollapseOnPristineBlurTypeId((current) =>
                  current === recordType.id ? null : current,
                );
              }}
              onSave={saveRecordType}
              onDelete={() => deleteMutation.mutate({ typeId: recordType.id })}
            />
          ))}
        </div>
      </SurfaceCard>
    </div>
  );
}

function RecordTypeRow({
  recordType,
  expanded,
  collapseOnPristineBlur,
  saving,
  deleting,
  onExpand,
  onCollapse,
  onDirty,
  onSave,
  onDelete,
}: {
  recordType: RecordTypeRecord;
  expanded: boolean;
  collapseOnPristineBlur: boolean;
  saving: boolean;
  deleting: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onDirty: () => void;
  onSave: (input: RecordTypeOptionUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(recordType.label);
  const [colorKey, setColorKey] = useState<FileTagColorKey>(recordType.colorKey);
  const [templatePersistState, setTemplatePersistState] = useState<RichEditorPersistState>("idle");
  const [hasEditedSinceOpen, setHasEditedSinceOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const templateHtmlRef = useRef(recordType.templateHtml);
  const lastSubmittedMetaSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setLabel(recordType.label);
    setColorKey(recordType.colorKey);
    templateHtmlRef.current = recordType.templateHtml;
    lastSubmittedMetaSignatureRef.current = null;
  }, [recordType.colorKey, recordType.id, recordType.label, recordType.templateHtml]);

  useEffect(() => {
    if (!expanded) {
      setTemplatePersistState("idle");
      return;
    }

    setHasEditedSinceOpen(false);
  }, [expanded, recordType.id]);

  const metaSnapshotSignature = recordTypeMetaSignature(recordType.label, recordType.colorKey);
  const metaDraftSignature = recordTypeMetaSignature(label, colorKey);
  const metaDirty = expanded && metaDraftSignature !== metaSnapshotSignature;
  const syncPending =
    saving || metaDirty || templatePersistState === "dirty" || templatePersistState === "saving";

  const submitMeta = useCallback(
    (nextLabel: string, nextColorKey: FileTagColorKey) => {
      const normalizedLabel = nextLabel.trim();
      const signature = recordTypeMetaSignature(normalizedLabel, nextColorKey);
      const dirty =
        normalizedLabel.length > 0 &&
        (normalizedLabel !== recordType.label || nextColorKey !== recordType.colorKey);

      if (!dirty || lastSubmittedMetaSignatureRef.current === signature) {
        return Promise.resolve(undefined);
      }

      lastSubmittedMetaSignatureRef.current = signature;
      return onSave({
        id: recordType.id,
        label: normalizedLabel,
        colorKey: nextColorKey,
        templateHtml: templateHtmlRef.current,
        isDefault: recordType.isDefault,
      }).catch((error) => {
        if (lastSubmittedMetaSignatureRef.current === signature) {
          lastSubmittedMetaSignatureRef.current = null;
        }
        throw error;
      });
    },
    [onSave, recordType.colorKey, recordType.id, recordType.isDefault, recordType.label],
  );

  useEffect(() => {
    if (!expanded || saving || !metaDirty) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void submitMeta(label, colorKey);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [colorKey, expanded, label, metaDirty, saving, submitMeta]);

  const markDirty = useCallback(() => {
    if (!hasEditedSinceOpen) {
      setHasEditedSinceOpen(true);
    }
    onDirty();
  }, [hasEditedSinceOpen, onDirty]);

  return (
    <article
      ref={rootRef}
      className={cn(
        "rounded-[var(--radius-8)] border bg-bg transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
        expanded
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_4%,var(--color-bg))]"
          : "border-border hover:border-border-strong hover:bg-bg-hover",
      )}
      onBlurCapture={(event) => {
        if (!expanded || !collapseOnPristineBlur || hasEditedSinceOpen) {
          return;
        }

        const nextFocus = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (nextFocus && rootRef.current?.contains(nextFocus)) {
          return;
        }

        if (!syncPending) {
          onCollapse();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-6)] bg-transparent py-1 text-left transition-colors hover:text-text-soft"
          disabled={saving || deleting}
          onClick={() => {
            if (expanded) {
              onCollapse();
              return;
            }
            onExpand();
          }}
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: fileTagColorValue(recordType.colorKey) }}
            aria-hidden="true"
          />
          <span className="truncate text-body font-medium text-text">{recordType.label}</span>
        </button>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {recordType.isDefault ? <StatusBadge tone="accent">默认</StatusBadge> : null}
          <StatusBadge tone="neutral">{recordType.usageCount} 条</StatusBadge>
          {expanded ? (
            <StatusBadge tone={templatePersistState === "error" ? "danger" : syncPending ? "warning" : "neutral"}>
              {templatePersistState === "error" ? "保存失败" : syncPending ? "同步中" : "自动保存"}
            </StatusBadge>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving || deleting}
            onClick={() => {
              if (expanded) {
                onCollapse();
                return;
              }
              onExpand();
            }}
          >
            {expanded ? "收起" : "编辑"}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="grid gap-4 border-t border-border px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              autoFocus
              fieldSize="sm"
              value={label}
              disabled={saving}
              onChange={(event) => {
                setLabel(event.target.value);
                markDirty();
              }}
              onBlur={() => {
                void submitMeta(label, colorKey);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitMeta(label, colorKey);
                  event.currentTarget.blur();
                }
              }}
              placeholder="记录类型名称"
              className="min-w-[12rem] flex-1"
            />
            <ColorKeyDropdown
              value={colorKey}
              size="sm"
              disabled={saving}
              className="w-full sm:w-[10rem]"
              ariaLabel="颜色"
              onChange={(nextColorKey) => {
                setColorKey(nextColorKey);
                markDirty();
                void submitMeta(label, nextColorKey);
              }}
            />
            {recordType.isDefault ? (
              <span className="inline-flex h-7 items-center px-2.5 text-ui font-medium text-text-soft">
                默认
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() =>
                  onSave({
                    id: recordType.id,
                    label: label.trim() || recordType.label,
                    colorKey,
                    templateHtml: templateHtmlRef.current,
                    isDefault: true,
                  })
                }
              >
                设为默认
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={deleting || recordType.isDefault || recordType.usageCount > 0}
              title={
                recordType.isDefault
                  ? "默认类型不能删除"
                  : recordType.usageCount > 0
                    ? "已有记录正在使用，暂不可删除"
                    : "删除"
              }
              onClick={onDelete}
            >
              删除
            </Button>
          </div>

          <div className="grid gap-2">
            <p className="text-ui font-medium text-text-muted">模板</p>
            <div className="rounded-[var(--radius-8)] border border-border bg-bg">
              <RichEditor
                key={`record-type-template:${recordType.id}`}
                html={recordType.templateHtml}
                variant="bare"
                autosave={{ delay: 600 }}
                onChange={(value) => {
                  templateHtmlRef.current = value.html;
                  markDirty();
                }}
                onPersistStateChange={setTemplatePersistState}
                onSave={(value) => {
                  templateHtmlRef.current = value.html;
                  markDirty();
                  return onSave({
                    id: recordType.id,
                    label: label.trim() || recordType.label,
                    colorKey,
                    templateHtml: value.html,
                    isDefault: recordType.isDefault,
                  });
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RecordTypeComposer({
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
          placeholder="例如：调研记录 / 复盘记录"
          className="min-w-[12rem] flex-1"
        />
        <ColorKeyDropdown
          value={colorKey}
          disabled={busy}
          className="w-full sm:w-[12rem]"
          ariaLabel="颜色"
          onChange={onColorChange}
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
          创建
        </Button>
      </div>
    </div>
  );
}

function recordTypeMetaSignature(label: string, colorKey: FileTagColorKey) {
  return `${label.trim()}::${colorKey}`;
}
