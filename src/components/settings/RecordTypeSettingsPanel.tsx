import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import { RichEditor } from "../rich-editor";
import type { FileTagColorKey } from "../../lib/types";
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
import { ColorKeyDropdown } from "./ColorKeyDropdown";
import { settingsCardClassName } from "./shared";

const EMPTY_TEMPLATE_HTML = "<p></p>";
const RECORD_TYPE_DETAIL_LABEL_ID = "record-type-detail-label";

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
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftColorKey, setDraftColorKey] = useState<FileTagColorKey>("blue");
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const [newTypeColorKey, setNewTypeColorKey] = useState<FileTagColorKey>("blue");
  const [focusDetailForTypeId, setFocusDetailForTypeId] = useState<number | null>(null);
  const lastSubmittedMetaSignatureRef = useRef<string | null>(null);

  const selectedRecordType =
    snapshot?.recordTypes.find((recordType) => recordType.id === selectedTypeId) ??
    snapshot?.recordTypes[0] ??
    null;

  useEffect(() => {
    if (!snapshot?.recordTypes.length) {
      setSelectedTypeId(null);
      return;
    }

    if (selectedTypeId && snapshot.recordTypes.some((recordType) => recordType.id === selectedTypeId)) {
      return;
    }

    setSelectedTypeId(snapshot.recordTypes[0].id);
  }, [selectedTypeId, snapshot]);

  useEffect(() => {
    if (!selectedRecordType) {
      setDraftLabel("");
      setDraftColorKey("blue");
      lastSubmittedMetaSignatureRef.current = null;
      return;
    }

    setDraftLabel(selectedRecordType.label);
    setDraftColorKey(selectedRecordType.colorKey);
    lastSubmittedMetaSignatureRef.current = null;
  }, [selectedRecordType]);

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
        setFocusDetailForTypeId(recordType.id);
      }
      setSelectedTypeId(recordType.id);
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

  const summary = useMemo(
    () => ({
      typeCount: snapshot?.recordTypes.length ?? 0,
      usedCount: snapshot?.recordTypes.filter((recordType) => recordType.usageCount > 0).length ?? 0,
    }),
    [snapshot],
  );

  const metaSnapshotSignature = selectedRecordType
    ? recordTypeMetaSignature(selectedRecordType.label, selectedRecordType.colorKey)
    : "";
  const metaDraftSignature = selectedRecordType
    ? recordTypeMetaSignature(draftLabel, draftColorKey)
    : "";
  const metaBusy = upsertMutation.isPending;
  const metaDirty =
    Boolean(selectedRecordType) && metaDraftSignature !== metaSnapshotSignature;

  const submitMeta = useCallback(
    (nextLabel: string, nextColorKey: FileTagColorKey) => {
      if (!selectedRecordType) {
        return Promise.resolve(undefined);
      }

      const normalizedLabel = nextLabel.trim();
      const signature = recordTypeMetaSignature(normalizedLabel, nextColorKey);
      const dirty =
        normalizedLabel.length > 0 &&
        (normalizedLabel !== selectedRecordType.label || nextColorKey !== selectedRecordType.colorKey);

      if (!dirty || lastSubmittedMetaSignatureRef.current === signature) {
        return Promise.resolve(undefined);
      }

      lastSubmittedMetaSignatureRef.current = signature;
      return upsertMutation.mutateAsync({
        id: selectedRecordType.id,
        label: normalizedLabel,
        colorKey: nextColorKey,
        templateHtml: selectedRecordType.templateHtml,
        isDefault: selectedRecordType.isDefault,
      }).catch((error) => {
        if (lastSubmittedMetaSignatureRef.current === signature) {
          lastSubmittedMetaSignatureRef.current = null;
        }
        throw error;
      });
    },
    [selectedRecordType, upsertMutation],
  );

  useEffect(() => {
    if (!selectedRecordType || metaBusy || !metaDirty) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void submitMeta(draftLabel, draftColorKey);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [draftColorKey, draftLabel, metaBusy, metaDirty, selectedRecordType, submitMeta]);

  useEffect(() => {
    if (focusDetailForTypeId === null || selectedRecordType?.id !== focusDetailForTypeId) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      const input = document.getElementById(RECORD_TYPE_DETAIL_LABEL_ID);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
    });

    setFocusDetailForTypeId(null);

    return () => window.cancelAnimationFrame(frame);
  }, [focusDetailForTypeId, selectedRecordType?.id]);

  const handleSaveTemplate = async (nextTemplateHtml: string) => {
    if (!selectedRecordType) {
      return;
    }

    await upsertMutation.mutateAsync({
      id: selectedRecordType.id,
      label: draftLabel.trim() || selectedRecordType.label,
      colorKey: draftColorKey,
      templateHtml: nextTemplateHtml,
      isDefault: selectedRecordType.isDefault,
    });
  };

  const handleSetDefault = async () => {
    if (!selectedRecordType || selectedRecordType.isDefault) {
      return;
    }

    await upsertMutation.mutateAsync({
      id: selectedRecordType.id,
      label: draftLabel.trim() || selectedRecordType.label,
      colorKey: draftColorKey,
      templateHtml: selectedRecordType.templateHtml,
      isDefault: true,
    });
  };

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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
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
            <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <TextField
                  autoFocus
                  value={newTypeLabel}
                  onChange={(event) => setNewTypeLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!upsertMutation.isPending && newTypeLabel.trim()) {
                        upsertMutation.mutate({
                          label: newTypeLabel.trim(),
                          colorKey: newTypeColorKey,
                          templateHtml: EMPTY_TEMPLATE_HTML,
                          isDefault: false,
                        });
                      }
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreateComposerOpen(false);
                      setNewTypeLabel("");
                      setNewTypeColorKey("blue");
                    }
                  }}
                  placeholder="例如：调研记录 / 复盘记录"
                  className="min-w-[12rem] flex-1"
                />
                <ColorKeyDropdown
                  value={newTypeColorKey}
                  disabled={upsertMutation.isPending}
                  className="w-full sm:w-[12rem]"
                  ariaLabel="颜色"
                  onChange={setNewTypeColorKey}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={upsertMutation.isPending}
                  onClick={() => {
                    setCreateComposerOpen(false);
                    setNewTypeLabel("");
                    setNewTypeColorKey("blue");
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={upsertMutation.isPending || !newTypeLabel.trim()}
                  onClick={() =>
                    upsertMutation.mutate({
                      label: newTypeLabel.trim(),
                      colorKey: newTypeColorKey,
                      templateHtml: EMPTY_TEMPLATE_HTML,
                      isDefault: false,
                    })
                  }
                >
                  创建
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            {snapshot.recordTypes.map((recordType) => {
              const active = selectedRecordType?.id === recordType.id;
              return (
                <button
                  key={recordType.id}
                  type="button"
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)]",
                    active
                      ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_6%,var(--color-bg))]"
                      : "border-border bg-bg hover:border-border-strong hover:bg-bg-hover",
                  )}
                  onClick={() => setSelectedTypeId(recordType.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: fileTagColorValue(recordType.colorKey) }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-body font-medium text-text">{recordType.label}</span>
                  </span>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {recordType.isDefault ? <StatusBadge tone="accent">默认</StatusBadge> : null}
                    <StatusBadge tone="neutral">{recordType.usageCount} 条</StatusBadge>
                  </div>
                </button>
              );
            })}
          </div>

        </SurfaceCard>

        <SurfaceCard subtle className={cn("grid gap-4", settingsCardClassName)}>
          <SectionHeader
            eyebrow="Template"
            title={selectedRecordType ? "编辑类型" : "模板编辑"}
            actions={
              selectedRecordType ? (
                <StatusBadge tone={metaBusy || metaDirty ? "warning" : "neutral"}>
                  {metaBusy || metaDirty ? "同步中" : "自动保存"}
                </StatusBadge>
              ) : null
            }
          />

          {selectedRecordType ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <TextField
                  id={RECORD_TYPE_DETAIL_LABEL_ID}
                  fieldSize="sm"
                  value={draftLabel}
                  disabled={metaBusy}
                  onChange={(event) => setDraftLabel(event.target.value)}
                  onBlur={() => {
                    void submitMeta(draftLabel, draftColorKey);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitMeta(draftLabel, draftColorKey);
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder="记录类型名称"
                  className="min-w-[12rem] flex-1"
                />
                <ColorKeyDropdown
                  value={draftColorKey}
                  size="sm"
                  disabled={metaBusy}
                  className="w-full sm:w-[10rem]"
                  ariaLabel="颜色"
                  onChange={(nextColorKey) => {
                    setDraftColorKey(nextColorKey);
                    void submitMeta(draftLabel, nextColorKey);
                  }}
                />
                {selectedRecordType.isDefault ? (
                  <span className="inline-flex h-7 items-center px-2.5 text-ui font-medium text-text-soft">
                    默认
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={upsertMutation.isPending}
                    onClick={() => void handleSetDefault()}
                  >
                    设为默认
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={
                    deleteMutation.isPending ||
                    selectedRecordType.isDefault ||
                    selectedRecordType.usageCount > 0
                  }
                  title={
                    selectedRecordType.isDefault
                      ? "默认类型不能删除"
                      : selectedRecordType.usageCount > 0
                        ? "已有记录正在使用，暂不可删除"
                        : "删除"
                  }
                  onClick={() => deleteMutation.mutate({ typeId: selectedRecordType.id })}
                >
                  删除
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <StatusBadge tone="neutral">{selectedRecordType.usageCount} 条记录</StatusBadge>
              </div>

              <div className="grid gap-2">
                <p className="text-ui font-medium text-text-muted">模板</p>
                <div className="rounded-[var(--radius-8)] border border-border bg-bg">
                  <RichEditor
                    key={`record-type-template:${selectedRecordType.id}:${selectedRecordType.updatedAt}`}
                    html={selectedRecordType.templateHtml}
                    variant="toolbar"
                    autosave={{ delay: 600 }}
                    onSave={(value) => handleSaveTemplate(value.html)}
                  />
                </div>
              </div>
            </>
          ) : (
            <EmptyState text="先从左侧选择一个记录类型。" compact />
          )}
        </SurfaceCard>
      </div>
    </div>
  );
}

function recordTypeMetaSignature(label: string, colorKey: FileTagColorKey) {
  return `${label.trim()}::${colorKey}`;
}
