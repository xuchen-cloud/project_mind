import { useEffect, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";

import { cn } from "../../ui/lib/cn";
import { formatMonthDay, parseProgressInput } from "./todo-utils";

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}

export function TodoInlineProgressEditor({
  latestProgress,
  editable,
  onSave,
  onError,
}: {
  latestProgress: { content: string; progressDate: string } | null;
  editable: boolean;
  onSave: (payload: { content: string; progressDate: string }) => Promise<unknown> | void;
  onError?: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft("");
    }
  }, [editing]);

  useEffect(() => {
    if (!editing || !textareaRef.current) {
      return;
    }
    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft, editing]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }
    const parsed = parseProgressInput(normalizeProgressDraft(draft));
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await onSave({
        content: parsed.content,
        progressDate: parsed.progressDate,
      });
      setEditing(false);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="grid gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          className="min-h-8 w-full resize-none overflow-hidden rounded-[var(--radius-6)] border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-2.5 py-1.5 text-ui leading-5 text-text outline-none"
          value={draft}
          autoFocus
          disabled={saving}
          placeholder="@0315 已与财务确认方案"
          onChange={(event) => setDraft(normalizeProgressDraft(event.target.value))}
          onBlur={() => {
            if (skipBlurSaveRef.current) {
              skipBlurSaveRef.current = false;
              return;
            }
            void handleSave();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              skipBlurSaveRef.current = true;
              setEditing(false);
              event.currentTarget.blur();
            }
          }}
        />
        <span className="inline-flex items-center gap-1 text-caption text-text-soft">
          <CornerDownLeft size={12} />
          回车保存
        </span>
      </div>
    );
  }

  const content = latestProgress ? (
    <p className="text-ui leading-5 text-text-muted">
      <span className="break-words">{latestProgress.content}</span>
      <span className="ml-2 text-caption text-text-soft" title={latestProgress.progressDate}>
        {formatMonthDay(latestProgress.progressDate)}
      </span>
    </p>
  ) : (
    <p className="text-ui text-text-soft">点击添加进展...</p>
  );

  if (!editable) {
    return <div className="grid min-w-0 gap-1">{content}</div>;
  }

  return (
    <button
      type="button"
      className={cn(
        "grid min-w-0 gap-1 rounded-[var(--radius-6)] bg-transparent p-0 text-left transition-colors duration-[160ms] ease-[var(--ease-soft)]",
        latestProgress ? "hover:text-text" : "hover:text-text-muted",
      )}
      onClick={() => setEditing(true)}
    >
      {content}
    </button>
  );
}
