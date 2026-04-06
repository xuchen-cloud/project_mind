import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RotateCcw, Save, Type } from "lucide-react";

import {
  buildRichTextStyleInlineCssVariables,
  cloneRichTextStyleSettings,
  DEFAULT_RICH_TEXT_STYLE_SETTINGS,
  RICH_TEXT_FONT_PRESET_OPTIONS,
  RICH_TEXT_STYLE_PREVIEW_HTML,
} from "../../lib/richTextStyle";
import type { RichTextFontPreset, RichTextStyleSettings } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, EmptyState, SectionHeader, StatusBadge, SurfaceCard, TextField } from "../../ui/components";
import { settingsSelectClassName } from "./shared";

interface RichTextStylePanelProps {
  open: boolean;
}

export function RichTextStylePanel({ open }: RichTextStylePanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const richTextStyleQuery = useQuery({
    queryKey: ["rich-text-style"],
    queryFn: projectMindApi.richTextStyleGet,
    enabled: open,
    refetchOnWindowFocus: false,
  });

  const [draft, setDraft] = useState<RichTextStyleSettings>(DEFAULT_RICH_TEXT_STYLE_SETTINGS);
  const lastSnapshotSignatureRef = useRef<string>("");

  const snapshot = richTextStyleQuery.data ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS;
  const snapshotSignature = useMemo(() => styleSignature(snapshot), [snapshot]);
  const draftSignature = useMemo(() => styleSignature(draft), [draft]);
  const isDirty = draftSignature !== snapshotSignature;

  useEffect(() => {
    if (!open) {
      return;
    }

    if (snapshotSignature === lastSnapshotSignatureRef.current) {
      return;
    }

    lastSnapshotSignatureRef.current = snapshotSignature;
    setDraft(cloneRichTextStyleSettings(snapshot));
  }, [open, snapshot, snapshotSignature]);

  const saveMutation = useMutation({
    mutationFn: projectMindApi.richTextStyleUpsert,
    onSuccess: (nextSettings) => {
      queryClient.setQueryData(["rich-text-style"], nextSettings);
      setDraft(cloneRichTextStyleSettings(nextSettings));
      lastSnapshotSignatureRef.current = styleSignature(nextSettings);
      setStatus({ tone: "success", label: "Saved", message: "富文本排版设置已更新" });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存富文本排版设置失败" });
      pushToast({ tone: "error", title: "保存富文本排版设置失败", detail: String(error) });
    },
  });

  if (richTextStyleQuery.isLoading && !richTextStyleQuery.data) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载富文本样式...
      </div>
    );
  }

  if (richTextStyleQuery.isError && !richTextStyleQuery.data) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="富文本样式暂时不可用"
          text="读取本地排版设置失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => richTextStyleQuery.refetch()}>
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
              Rich Text Style
            </p>
            <p className="mt-1 text-body text-text-muted">
              保存后会统一作用于编辑态、只读态和记录预览区，不改写已有内容本身。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">正文</StatusBadge>
            <StatusBadge tone="neutral">标题</StatusBadge>
            <StatusBadge tone="neutral">列表</StatusBadge>
            <StatusBadge tone={isDirty ? "warning" : "success"}>
              {isDirty ? "未保存更改" : "已同步"}
            </StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <div className="grid gap-4">
          <StyleSectionCard
            eyebrow="Body"
            title="正文"
            description="控制段落正文的字体、字号、行距和段间距。"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FontPresetField
                label="字体"
                value={draft.body.fontPreset}
                onChange={(fontPreset) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, fontPreset },
                  }))
                }
              />
              <NumericField
                label="字号"
                value={draft.body.fontSizePx}
                min={12}
                max={28}
                step={1}
                suffix="px"
                onChange={(fontSizePx) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, fontSizePx },
                  }))
                }
              />
              <NumericField
                label="行间距"
                value={draft.body.lineHeight}
                min={1}
                max={2.4}
                step={0.05}
                onChange={(lineHeight) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, lineHeight },
                  }))
                }
              />
              <NumericField
                label="段间距"
                value={draft.body.paragraphSpacingPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onChange={(paragraphSpacingPx) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, paragraphSpacingPx },
                  }))
                }
              />
            </div>
          </StyleSectionCard>

          <StyleSectionCard
            eyebrow="Headings"
            title="标题"
            description="H1/H2/H3 共享字体、行距和段间距，只拆字号层级。"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FontPresetField
                label="字体"
                value={draft.headings.fontPreset}
                onChange={(fontPreset) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, fontPreset },
                  }))
                }
              />
              <NumericField
                label="行间距"
                value={draft.headings.lineHeight}
                min={1}
                max={2.4}
                step={0.05}
                onChange={(lineHeight) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, lineHeight },
                  }))
                }
              />
              <NumericField
                label="段间距"
                value={draft.headings.paragraphSpacingPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onChange={(paragraphSpacingPx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, paragraphSpacingPx },
                  }))
                }
              />
              <div />
              <NumericField
                label="H1 字号"
                value={draft.headings.h1SizePx}
                min={14}
                max={48}
                step={1}
                suffix="px"
                onChange={(h1SizePx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, h1SizePx },
                  }))
                }
              />
              <NumericField
                label="H2 字号"
                value={draft.headings.h2SizePx}
                min={14}
                max={40}
                step={1}
                suffix="px"
                onChange={(h2SizePx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, h2SizePx },
                  }))
                }
              />
              <NumericField
                label="H3 字号"
                value={draft.headings.h3SizePx}
                min={12}
                max={32}
                step={1}
                suffix="px"
                onChange={(h3SizePx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, h3SizePx },
                  }))
                }
              />
            </div>
          </StyleSectionCard>

          <StyleSectionCard
            eyebrow="Lists"
            title="列表"
            description="列表独立控制字体、字号、行距和列表块间距，不改变缩进与标记样式。"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FontPresetField
                label="字体"
                value={draft.list.fontPreset}
                onChange={(fontPreset) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, fontPreset },
                  }))
                }
              />
              <NumericField
                label="字号"
                value={draft.list.fontSizePx}
                min={12}
                max={28}
                step={1}
                suffix="px"
                onChange={(fontSizePx) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, fontSizePx },
                  }))
                }
              />
              <NumericField
                label="行间距"
                value={draft.list.lineHeight}
                min={1}
                max={2.4}
                step={0.05}
                onChange={(lineHeight) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, lineHeight },
                  }))
                }
              />
              <NumericField
                label="段间距"
                value={draft.list.paragraphSpacingPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onChange={(paragraphSpacingPx) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, paragraphSpacingPx },
                  }))
                }
              />
            </div>
          </StyleSectionCard>
        </div>

        <div className="grid content-start gap-4">
          <SurfaceCard className="p-4 sm:p-5">
            <SectionHeader
              eyebrow="Preview"
              title="实时预览"
              actions={<StatusBadge tone="neutral">仅在此面板内预览</StatusBadge>}
            />
            <p className="mt-3 text-body text-text-muted">
              修改后会立即更新这张示例卡；点击保存后才会全局生效。
            </p>

            <div className="mt-4 overflow-hidden rounded-[var(--radius-8)] border border-border bg-bg">
              <div
                className="rich-editor__surface min-h-0 bg-transparent"
                style={buildRichTextStyleInlineCssVariables(draft)}
                dangerouslySetInnerHTML={{ __html: RICH_TEXT_STYLE_PREVIEW_HTML }}
              />
            </div>
          </SurfaceCard>

          <SurfaceCard subtle className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                leadingIcon={<Save size={14} />}
                disabled={!isDirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate(draft)}
              >
                {saveMutation.isPending ? "保存中..." : "保存设置"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!isDirty}
                onClick={() => setDraft(cloneRichTextStyleSettings(snapshot))}
              >
                取消更改
              </Button>
              <Button
                type="button"
                variant="ghost"
                leadingIcon={<RotateCcw size={14} />}
                disabled={styleSignature(draft) === styleSignature(DEFAULT_RICH_TEXT_STYLE_SETTINGS)}
                onClick={() => setDraft(cloneRichTextStyleSettings(DEFAULT_RICH_TEXT_STYLE_SETTINGS))}
              >
                恢复默认
              </Button>
            </div>
            <p className="mt-3 text-ui leading-5 text-text-soft">
              保存后会同步刷新所有 `.rich-editor__surface` 展示位，包括编辑器正文、只读内容和 HTML 预览区。
            </p>
          </SurfaceCard>
        </div>
      </div>
    </div>
  );
}

function StyleSectionCard({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <SurfaceCard className="p-4 sm:p-5">
      <SectionHeader eyebrow={eyebrow} title={title} actions={<Type size={14} className="text-text-soft" />} />
      <p className="mt-3 text-body text-text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </SurfaceCard>
  );
}

function FontPresetField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RichTextFontPreset;
  onChange: (value: RichTextFontPreset) => void;
}) {
  const selected = RICH_TEXT_FONT_PRESET_OPTIONS.find((option) => option.value === value);

  return (
    <label className="grid gap-1.5">
      <span className="text-ui font-medium text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as RichTextFontPreset)}
        className={settingsSelectClassName}
      >
        {RICH_TEXT_FONT_PRESET_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {selected ? <span className="text-ui leading-5 text-text-soft">{selected.description}</span> : null}
    </label>
  );
}

function NumericField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-ui font-medium text-text-muted">{label}</span>
      <div className="relative">
        <TextField
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const nextValue = event.target.valueAsNumber;
            if (Number.isFinite(nextValue)) {
              onChange(nextValue);
            }
          }}
          className={suffix ? "pr-10" : undefined}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 inline-flex items-center text-ui text-text-soft">
            {suffix}
          </span>
        ) : null}
      </div>
      <span className="text-ui text-text-soft">
        {min} - {max}
      </span>
    </label>
  );
}

function styleSignature(settings: RichTextStyleSettings) {
  return JSON.stringify(settings);
}
