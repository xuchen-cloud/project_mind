import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Pencil, Trash2 } from "lucide-react";

import { ActionContextMenu } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { formatMonthDay, parseProgressInput } from "./todo-utils";

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}

export function TodoInlineProgressEditor({
  latestProgress,
  editable,
  onSave,
  onUpdateLatestProgress,
  onDeleteLatestProgress,
  onError,
}: {
  latestProgress: { id: number; content: string; progressDate: string } | null;
  editable: boolean;
  onSave: (payload: { content: string; progressDate: string }) => Promise<unknown> | void;
  onUpdateLatestProgress?: (
    progressId: number,
    payload: { content: string; progressDate: string },
  ) => Promise<unknown> | void;
  onDeleteLatestProgress?: (progressId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"add" | "edit" | null>(null);
  const [saving, setSaving] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editing = mode !== null;

  useEffect(() => {
    if (!editing) {
      setDraft("");
    }
  }, [editing]);

  useEffect(() => {
    if (mode === "edit" && latestProgress) {
      setDraft(latestProgress.content);
    }
    if (mode === "add") {
      setDraft("");
    }
  }, [latestProgress, mode]);

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
    const normalizedDraft = normalizeProgressDraft(draft).trim();
    if (!normalizedDraft || /^@\d{4}$/u.test(normalizedDraft)) {
      setMode(null);
      return;
    }

    const parsed = parseProgressInput(
      normalizedDraft,
      new Date(),
      mode === "edit" ? latestProgress?.progressDate : undefined,
    );
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      if (mode === "edit" && latestProgress && onUpdateLatestProgress) {
        await onUpdateLatestProgress(latestProgress.id, {
          content: parsed.content,
          progressDate: parsed.progressDate,
        });
      } else {
        await onSave({
          content: parsed.content,
          progressDate: parsed.progressDate,
        });
      }
      setMode(null);
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
              setMode(null);
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
    <div className="grid min-w-0 gap-1">
      <button
        type="button"
        className={cn(
          "grid min-w-0 gap-1 rounded-[var(--radius-6)] bg-transparent p-0 text-left transition-colors duration-[160ms] ease-[var(--ease-soft)]",
          latestProgress ? "hover:text-text" : "hover:text-text-muted",
        )}
        onClick={() => setMode("add")}
        onContextMenu={(event) => {
          if (!latestProgress) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {content}
      </button>
      {contextMenu && latestProgress ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="进展操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Pencil,
              label: "编辑进展",
              onSelect: () => {
                setMode("edit");
              },
            },
            {
              icon: Trash2,
              label: "删除进展",
              tone: "danger",
              onSelect: () => {
                void onDeleteLatestProgress?.(latestProgress.id);
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}
