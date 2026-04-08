import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

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
  const lastSubmittedSignatureRef = useRef<string | null>(null);

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
      lastSnapshotSignatureRef.current = styleSignature(nextSettings);
      lastSubmittedSignatureRef.current = styleSignature(nextSettings);
      setDraft((current) =>
        styleSignature(current) === styleSignature(nextSettings)
          ? cloneRichTextStyleSettings(nextSettings)
          : current,
      );
    },
    onError: (error) => {
      lastSubmittedSignatureRef.current = null;
      setStatus({ tone: "error", label: "Error", message: "保存富文本排版设置失败" });
      pushToast({ tone: "error", title: "保存富文本排版设置失败", detail: String(error) });
    },
  });

  useEffect(() => {
    if (!open || saveMutation.isPending || !isDirty || lastSubmittedSignatureRef.current === draftSignature) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      lastSubmittedSignatureRef.current = draftSignature;
      saveMutation.mutate(cloneRichTextStyleSettings(draft));
    }, 500);

    return () => window.clearTimeout(timer);
  }, [draft, draftSignature, isDirty, open, saveMutation]);

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
    <div className="grid gap-3">
      <SurfaceCard subtle className="px-3.5 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
            Rich Text Style
          </p>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge tone="neutral">实时预览</StatusBadge>
            <StatusBadge tone={saveMutation.isPending || isDirty ? "warning" : "success"}>
              {saveMutation.isPending ? "同步中" : isDirty ? "待同步" : "已同步"}
            </StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.08fr)_minmax(20rem,0.92fr)]">
        <div className="grid gap-3">
          <StyleSectionCard eyebrow="Body" title="正文">
            <div className="grid gap-2.5">
              <CompactFieldRow>
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
                  label="行距"
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
              </CompactFieldRow>

              <NumericPairField
                label="段距"
                firstLabel="段前"
                firstValue={draft.body.paragraphSpacingBeforePx}
                secondLabel="段后"
                secondValue={draft.body.paragraphSpacingAfterPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onFirstChange={(paragraphSpacingBeforePx) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, paragraphSpacingBeforePx },
                  }))
                }
                onSecondChange={(paragraphSpacingAfterPx) =>
                  setDraft((current) => ({
                    ...current,
                    body: { ...current.body, paragraphSpacingAfterPx },
                  }))
                }
              />
            </div>
          </StyleSectionCard>

          <StyleSectionCard eyebrow="Headings" title="标题">
            <div className="grid gap-2.5">
              <CompactFieldRow className="md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
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
                  label="行距"
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
              </CompactFieldRow>

              <NumericPairField
                label="段距"
                firstLabel="段前"
                firstValue={draft.headings.paragraphSpacingBeforePx}
                secondLabel="段后"
                secondValue={draft.headings.paragraphSpacingAfterPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onFirstChange={(paragraphSpacingBeforePx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, paragraphSpacingBeforePx },
                  }))
                }
                onSecondChange={(paragraphSpacingAfterPx) =>
                  setDraft((current) => ({
                    ...current,
                    headings: { ...current.headings, paragraphSpacingAfterPx },
                  }))
                }
              />

              <NumericTripleField
                label="标题字号"
                items={[
                  {
                    itemLabel: "H1",
                    value: draft.headings.h1SizePx,
                    min: 14,
                    max: 48,
                    step: 1,
                    suffix: "px",
                    onChange: (h1SizePx) =>
                      setDraft((current) => ({
                        ...current,
                        headings: { ...current.headings, h1SizePx },
                      })),
                  },
                  {
                    itemLabel: "H2",
                    value: draft.headings.h2SizePx,
                    min: 14,
                    max: 40,
                    step: 1,
                    suffix: "px",
                    onChange: (h2SizePx) =>
                      setDraft((current) => ({
                        ...current,
                        headings: { ...current.headings, h2SizePx },
                      })),
                  },
                  {
                    itemLabel: "H3",
                    value: draft.headings.h3SizePx,
                    min: 12,
                    max: 32,
                    step: 1,
                    suffix: "px",
                    onChange: (h3SizePx) =>
                      setDraft((current) => ({
                        ...current,
                        headings: { ...current.headings, h3SizePx },
                      })),
                  },
                ]}
              />
            </div>
          </StyleSectionCard>

          <StyleSectionCard eyebrow="Lists" title="列表">
            <div className="grid gap-2.5">
              <CompactFieldRow>
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
                  label="行距"
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
              </CompactFieldRow>

              <NumericPairField
                label="段距"
                firstLabel="段前"
                firstValue={draft.list.paragraphSpacingBeforePx}
                secondLabel="段后"
                secondValue={draft.list.paragraphSpacingAfterPx}
                min={0}
                max={48}
                step={1}
                suffix="px"
                onFirstChange={(paragraphSpacingBeforePx) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, paragraphSpacingBeforePx },
                  }))
                }
                onSecondChange={(paragraphSpacingAfterPx) =>
                  setDraft((current) => ({
                    ...current,
                    list: { ...current.list, paragraphSpacingAfterPx },
                  }))
                }
              />
            </div>
          </StyleSectionCard>
        </div>

        <div className="grid content-start gap-3 xl:sticky xl:top-0">
          <SurfaceCard className="overflow-hidden">
            <div className={settingsCardClassName}>
              <SectionHeader eyebrow="Preview" title="实时预览" />

              <div className="mt-3 overflow-hidden rounded-[var(--radius-8)] border border-border bg-bg">
                <div
                  className="rich-editor__surface min-h-0 bg-transparent"
                  style={{
                    ...buildRichTextStyleInlineCssVariables(draft),
                    minHeight: 0,
                    padding: "12px 14px",
                  }}
                  dangerouslySetInnerHTML={{ __html: RICH_TEXT_STYLE_PREVIEW_HTML }}
                />
              </div>
            </div>

            <div className="border-t border-border bg-bg-subtle px-3.5 py-3 sm:px-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={styleSignature(draft) === styleSignature(DEFAULT_RICH_TEXT_STYLE_SETTINGS)}
                  onClick={() => setDraft(cloneRichTextStyleSettings(DEFAULT_RICH_TEXT_STYLE_SETTINGS))}
                >
                  恢复默认
                </Button>
              </div>
            </div>
          </SurfaceCard>
        </div>
      </div>
    </div>
  );
}

function StyleSectionCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <SurfaceCard className={settingsCardClassName}>
      <SectionHeader eyebrow={eyebrow} title={title} />
      <div className="mt-2.5">{children}</div>
    </SurfaceCard>
  );
}

function CompactFieldRow({
  children,
  className = "md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={["grid gap-2.5", className].join(" ")}>{children}</div>;
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
  return (
    <label className={settingsFieldClassName}>
      <span className={settingsFieldLabelClassName}>{label}</span>
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
    <label className={settingsFieldClassName}>
      <span className={settingsFieldLabelClassName}>{label}</span>
      <NumericInputControl
        value={value}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        onChange={onChange}
      />
    </label>
  );
}

function NumericPairField({
  label,
  firstLabel,
  firstValue,
  secondLabel,
  secondValue,
  min,
  max,
  step,
  suffix,
  onFirstChange,
  onSecondChange,
}: {
  label: string;
  firstLabel: string;
  firstValue: number;
  secondLabel: string;
  secondValue: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onFirstChange: (value: number) => void;
  onSecondChange: (value: number) => void;
}) {
  return (
    <div className={settingsFieldClassName}>
      <span className={settingsFieldLabelClassName}>{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <NumericSubField
          label={firstLabel}
          value={firstValue}
          min={min}
          max={max}
          step={step}
          suffix={suffix}
          onChange={onFirstChange}
        />
        <NumericSubField
          label={secondLabel}
          value={secondValue}
          min={min}
          max={max}
          step={step}
          suffix={suffix}
          onChange={onSecondChange}
        />
      </div>
    </div>
  );
}

function NumericTripleField({
  label,
  items,
}: {
  label: string;
  items: Array<{
    itemLabel: string;
    value: number;
    min: number;
    max: number;
    step: number;
    suffix?: string;
    onChange: (value: number) => void;
  }>;
}) {
  return (
    <div className={settingsFieldClassName}>
      <span className={settingsFieldLabelClassName}>{label}</span>
      <div className="grid gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <NumericSubField
            key={item.itemLabel}
            label={item.itemLabel}
            value={item.value}
            min={item.min}
            max={item.max}
            step={item.step}
            suffix={item.suffix}
            onChange={item.onChange}
          />
        ))}
      </div>
    </div>
  );
}

function NumericSubField({
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
    <label className="grid gap-1">
      <span className="text-caption font-medium uppercase tracking-[0.12em] text-text-soft">
        {label}
      </span>
      <NumericInputControl
        value={value}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        onChange={onChange}
      />
    </label>
  );
}

function NumericInputControl({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="relative">
      <TextField
        fieldSize="sm"
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
  );
}

function styleSignature(settings: RichTextStyleSettings) {
  return JSON.stringify(settings);
}
