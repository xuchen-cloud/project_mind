import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import type {
  ActivityAttributeOption,
  ActivityAttributeOptionUpsertInput,
  ActivityStatusOption,
  ActivityStatusOptionUpsertInput,
  FileTagColorKey,
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
import { ColorKeyDropdown } from "./ColorKeyDropdown";

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
  const [attributeComposerOpen, setAttributeComposerOpen] = useState(false);
  const [newAttributeLabel, setNewAttributeLabel] = useState("");
  const [newAttributeColorKey, setNewAttributeColorKey] = useState<FileTagColorKey>("blue");
  const [statusComposerOpen, setStatusComposerOpen] = useState(false);
  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [newStatusColorKey, setNewStatusColorKey] = useState<FileTagColorKey>("amber");

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
    onSuccess: async (_option, variables) => {
      if (!variables.id) {
        setStatus({ tone: "success", label: "Created", message: "活动属性已新增" });
        setNewAttributeLabel("");
        setNewAttributeColorKey("blue");
        setAttributeComposerOpen(false);
      }
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
    onSuccess: async (_option, variables) => {
      if (!variables.id) {
        setStatus({ tone: "success", label: "Created", message: "活动状态已新增" });
        setNewStatusLabel("");
        setNewStatusColorKey("amber");
        setStatusComposerOpen(false);
      }
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

  const saveAttributeOption = useCallback(
    (input: ActivityAttributeOptionUpsertInput) => attributeUpsertMutation.mutateAsync(input),
    [attributeUpsertMutation],
  );

  const saveStatusOption = useCallback(
    (input: ActivityStatusOptionUpsertInput) => statusUpsertMutation.mutateAsync(input),
    [statusUpsertMutation],
  );

  const summary = useMemo(
    () => ({
      attributes: snapshot?.activityAttributeOptions.length ?? 0,
      statuses: snapshot?.activityStatusOptions.length ?? 0,
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Activity Labels
            </p>
            <p className="mt-1 text-body text-text-muted">活动属性和状态。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">{summary.attributes} 个属性</StatusBadge>
            <StatusBadge tone="neutral">{summary.statuses} 个状态</StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SurfaceCard subtle className="grid gap-4 p-4">
          <SectionHeader
            eyebrow="Attribute"
            title="活动属性"
            actions={
              <div className="flex items-center gap-2">
                <StatusBadge tone="neutral">{summary.attributes} 项</StatusBadge>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Plus size={14} />}
                  onClick={() =>
                    setAttributeComposerOpen((current) => {
                      const nextOpen = !current;
                      if (!nextOpen) {
                        setNewAttributeLabel("");
                        setNewAttributeColorKey("blue");
                      }
                      return nextOpen;
                    })
                  }
                >
                  新建
                </Button>
              </div>
            }
          />

          {attributeComposerOpen ? (
            <OptionComposer
              label={newAttributeLabel}
              colorKey={newAttributeColorKey}
              busy={attributeUpsertMutation.isPending}
              placeholder="新增活动属性"
              colorAriaLabel="颜色"
              confirmLabel="创建属性"
              onLabelChange={setNewAttributeLabel}
              onColorChange={setNewAttributeColorKey}
              onCancel={() => {
                setAttributeComposerOpen(false);
                setNewAttributeLabel("");
                setNewAttributeColorKey("blue");
              }}
              onSubmit={() =>
                attributeUpsertMutation.mutateAsync({
                  label: newAttributeLabel.trim(),
                  colorKey: newAttributeColorKey,
                })
              }
            />
          ) : null}

          <div className="grid gap-2.5">
            {snapshot.activityAttributeOptions.length > 0 ? (
              snapshot.activityAttributeOptions.map((option) => (
                <AttributeOptionRow
                  key={option.id}
                  option={option}
                  busy={attributeUpsertMutation.isPending || attributeDeleteMutation.isPending}
                  onSave={saveAttributeOption}
                  onDelete={() => attributeDeleteMutation.mutate({ optionId: option.id })}
                />
              ))
            ) : (
              <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
                还没有活动属性。
              </p>
            )}
          </div>
        </SurfaceCard>

        <SurfaceCard subtle className="grid gap-4 p-4">
          <SectionHeader
            eyebrow="Status"
            title="活动状态"
            actions={
              <div className="flex items-center gap-2">
                <StatusBadge tone="neutral">{summary.statuses} 项</StatusBadge>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Plus size={14} />}
                  onClick={() =>
                    setStatusComposerOpen((current) => {
                      const nextOpen = !current;
                      if (!nextOpen) {
                        setNewStatusLabel("");
                        setNewStatusColorKey("amber");
                      }
                      return nextOpen;
                    })
                  }
                >
                  新建
                </Button>
              </div>
            }
          />

          {statusComposerOpen ? (
            <OptionComposer
              label={newStatusLabel}
              colorKey={newStatusColorKey}
              busy={statusUpsertMutation.isPending}
              placeholder="新增活动状态"
              colorAriaLabel="状态颜色"
              confirmLabel="创建状态"
              onLabelChange={setNewStatusLabel}
              onColorChange={setNewStatusColorKey}
              onCancel={() => {
                setStatusComposerOpen(false);
                setNewStatusLabel("");
                setNewStatusColorKey("amber");
              }}
              onSubmit={() =>
                statusUpsertMutation.mutateAsync({
                  label: newStatusLabel.trim(),
                  colorKey: newStatusColorKey,
                })
              }
            />
          ) : null}

          <div className="grid gap-2.5">
            {snapshot.activityStatusOptions.length > 0 ? (
              snapshot.activityStatusOptions.map((option) => (
                <StatusOptionRow
                  key={option.id}
                  option={option}
                  busy={statusUpsertMutation.isPending || statusDeleteMutation.isPending}
                  onSave={saveStatusOption}
                  onDelete={() => statusDeleteMutation.mutate({ optionId: option.id })}
                />
              ))
            ) : (
              <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
                还没有活动状态。
              </p>
            )}
          </div>
        </SurfaceCard>
      </div>
    </div>
  );
}

function AttributeOptionRow({
  option,
  busy,
  onSave,
  onDelete,
}: {
  option: ActivityAttributeOption;
  busy: boolean;
  onSave: (input: ActivityAttributeOptionUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(option.label);
  const [colorKey, setColorKey] = useState<FileTagColorKey>(option.colorKey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSubmittedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setLabel(option.label);
    setColorKey(option.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [option.colorKey, option.id, option.label]);

  const submit = useCallback(
    (nextLabel: string, nextColorKey: FileTagColorKey) => {
      const normalizedLabel = nextLabel.trim();
      const signature = `${normalizedLabel}::${nextColorKey}`;
      const dirty =
        normalizedLabel.length > 0 &&
        (normalizedLabel !== option.label || nextColorKey !== option.colorKey);

      if (!dirty || lastSubmittedSignatureRef.current === signature) {
        return;
      }

      lastSubmittedSignatureRef.current = signature;
      void onSave({
        id: option.id,
        label: normalizedLabel,
        colorKey: nextColorKey,
      }).catch(() => {
        if (lastSubmittedSignatureRef.current === signature) {
          lastSubmittedSignatureRef.current = null;
        }
      });
    },
    [onSave, option.colorKey, option.id, option.label],
  );

  const cancelEdit = useCallback(() => {
    setLabel(option.label);
    setColorKey(option.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [option.colorKey, option.label]);

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
    if (!normalizedLabel || (normalizedLabel === option.label && colorKey === option.colorKey)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      submit(label, colorKey);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [busy, colorKey, editing, label, option.colorKey, option.label, submit]);

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
        <AttributeColorSelect
          selectedColorKey={colorKey}
          disabled={busy}
          onSelect={(nextColorKey) => {
            setColorKey(nextColorKey);
            submit(label, nextColorKey);
          }}
        />
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>
          取消
        </Button>
        <Button type="button" size="sm" variant="danger" disabled={busy} onClick={onDelete}>
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
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: colorTokenValue(option.colorKey) }}
          aria-hidden="true"
        />
        <span className="truncate text-body text-text">{option.label}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
          编辑
        </Button>
        <Button type="button" size="sm" variant="danger" disabled={busy} onClick={onDelete}>
          删除
        </Button>
      </div>
    </div>
  );
}

function StatusOptionRow({
  option,
  busy,
  onSave,
  onDelete,
}: {
  option: ActivityStatusOption;
  busy: boolean;
  onSave: (input: ActivityStatusOptionUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(option.label);
  const [colorKey, setColorKey] = useState<FileTagColorKey>(option.colorKey);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastSubmittedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    setLabel(option.label);
    setColorKey(option.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [option.colorKey, option.id, option.label]);

  const submit = useCallback(
    (nextLabel: string, nextColorKey: FileTagColorKey) => {
      const normalizedLabel = nextLabel.trim();
      const signature = `${normalizedLabel}::${nextColorKey}`;
      const dirty =
        normalizedLabel.length > 0 &&
        (normalizedLabel !== option.label || nextColorKey !== option.colorKey);

      if (!dirty || lastSubmittedSignatureRef.current === signature) {
        return;
      }

      lastSubmittedSignatureRef.current = signature;
      void onSave({
        id: option.id,
        label: normalizedLabel,
        colorKey: nextColorKey,
      }).catch(() => {
        if (lastSubmittedSignatureRef.current === signature) {
          lastSubmittedSignatureRef.current = null;
        }
      });
    },
    [onSave, option.colorKey, option.id, option.label],
  );

  const cancelEdit = useCallback(() => {
    setLabel(option.label);
    setColorKey(option.colorKey);
    setEditing(false);
    lastSubmittedSignatureRef.current = null;
  }, [option.colorKey, option.label]);

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
    if (!normalizedLabel || (normalizedLabel === option.label && colorKey === option.colorKey)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      submit(label, colorKey);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [busy, colorKey, editing, label, option.colorKey, option.label, submit]);

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
        <StatusColorSelect
          selectedColorKey={colorKey}
          disabled={busy}
          onSelect={(nextColorKey) => {
            setColorKey(nextColorKey);
            submit(label, nextColorKey);
          }}
        />
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>
          取消
        </Button>
        {option.isSystem ? (
          <span className="inline-flex h-7 items-center px-2.5 text-ui font-medium text-text-soft">
            默认
          </span>
        ) : (
          <Button type="button" size="sm" variant="danger" disabled={busy} onClick={onDelete}>
            删除
          </Button>
        )}
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
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: colorTokenValue(option.colorKey) }}
          aria-hidden="true"
        />
        <span className="truncate text-body text-text">{option.label}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
          编辑
        </Button>
        {option.isSystem ? (
          <span className="inline-flex h-7 items-center px-2.5 text-ui font-medium text-text-soft">
            默认
          </span>
        ) : (
          <Button type="button" size="sm" variant="danger" disabled={busy} onClick={onDelete}>
            删除
          </Button>
        )}
      </div>
    </div>
  );
}

function OptionComposer({
  label,
  colorKey,
  busy,
  placeholder,
  colorAriaLabel,
  confirmLabel,
  onLabelChange,
  onColorChange,
  onCancel,
  onSubmit,
}: {
  label: string;
  colorKey: FileTagColorKey;
  busy: boolean;
  placeholder: string;
  colorAriaLabel: string;
  confirmLabel: string;
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
          placeholder={placeholder}
          className="min-w-[12rem] flex-1"
        />
        <ColorKeyDropdown
          value={colorKey}
          disabled={busy}
          className="min-w-[8.5rem]"
          ariaLabel={colorAriaLabel}
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
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function AttributeColorSelect({
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

function StatusColorSelect({
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
      ariaLabel="状态颜色"
      onChange={onSelect}
    />
  );
}

function colorTokenValue(colorKey: FileTagColorKey) {
  return fileTagColorValue(colorKey);
}
