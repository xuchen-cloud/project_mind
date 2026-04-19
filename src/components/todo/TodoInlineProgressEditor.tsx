import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Pencil, Trash2 } from "lucide-react";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import type {
  InternalReferenceContext,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { ActionContextMenu } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  InternalReferenceInlineText,
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { formatMonthDay, parseProgressInput } from "./todo-utils";
import { TodoReferenceEditor } from "./TodoReferenceEditor";

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
  internalReferenceContext,
  onOpenInternalReference,
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
  internalReferenceContext?: InternalReferenceContext | null;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"add" | "edit" | null>(null);
  const [saving, setSaving] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editing = mode !== null;
  const referenceTrigger = editing
    ? findInternalReferenceTextTrigger(draft, selectionStart)
    : null;
  const referenceTriggerKey = referenceTrigger
    ? `${referenceTrigger.start}:${referenceTrigger.end}:${referenceTrigger.query}`
    : null;
  const referencePickerOpen =
    Boolean(referenceTrigger) &&
    Boolean(internalReferenceContext) &&
    dismissedTriggerKey !== referenceTriggerKey;
  const { results: referenceResults, loading: referenceLoading } = useInternalReferenceSearch({
    open: referencePickerOpen,
    query: referenceTrigger?.query ?? "",
    context: internalReferenceContext,
    limit: 8,
  });

  useEffect(() => {
    if (!editing) {
      setDraft("");
      setSelectionStart(null);
      setDismissedTriggerKey(null);
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
    if (!referencePickerOpen) {
      setReferenceActiveIndex(0);
      return;
    }

    setReferenceActiveIndex((current) => {
      if (referenceResults.length === 0) {
        return 0;
      }

      return Math.min(current, referenceResults.length - 1);
    });
  }, [referencePickerOpen, referenceResults.length]);

  useEffect(() => {
    if (!referencePickerOpen) {
      return;
    }

    setReferenceActiveIndex(0);
  }, [referencePickerOpen, referenceTrigger?.query]);

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

  function handleReferenceInsert(reference: InternalReferenceSearchResult) {
    if (!referenceTrigger) {
      return;
    }

    const target = buildInternalReferenceTarget(reference);
    const token = `${buildInternalReferenceToken(target)} `;
    const nextDraft =
      draft.slice(0, referenceTrigger.start) + token + draft.slice(referenceTrigger.end);
    const nextSelection = referenceTrigger.start + token.length;

    setDraft(nextDraft);
    setSelectionStart(nextSelection);
    setDismissedTriggerKey(null);

    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }

  if (editing) {
    return (
      <div className="grid gap-2">
        <div className="relative">
          <TodoReferenceEditor
            editorRef={editorRef}
            value={draft}
            selectionOffset={selectionStart}
            autoFocus
            disabled={saving}
            placeholder="@0315 已与财务确认方案"
            textClassName="text-ui leading-5"
            onChange={(nextValue, nextSelection) => {
              setDraft(normalizeProgressDraft(nextValue));
              setSelectionStart(nextSelection);
            }}
            onSelectionChange={setSelectionStart}
            onBlur={() => {
              if (skipBlurSaveRef.current) {
                skipBlurSaveRef.current = false;
                return;
              }
              void handleSave();
            }}
            onKeyDown={(event) => {
              if (referencePickerOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setReferenceActiveIndex((current) => {
                    if (referenceResults.length === 0) {
                      return 0;
                    }

                    return (current + 1) % referenceResults.length;
                  });
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setReferenceActiveIndex((current) => {
                    if (referenceResults.length === 0) {
                      return 0;
                    }

                    return current === 0 ? referenceResults.length - 1 : current - 1;
                  });
                  return;
                }

                if (event.key === "Enter" && referenceResults.length > 0) {
                  event.preventDefault();
                  handleReferenceInsert(referenceResults[referenceActiveIndex] ?? referenceResults[0]);
                  return;
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedTriggerKey(referenceTriggerKey);
                  return;
                }
              }

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
          <InternalReferencePicker
            open={referencePickerOpen}
            loading={referenceLoading}
            results={referenceResults}
            activeIndex={referenceActiveIndex}
            className="absolute left-0 top-[calc(100%+6px)] z-20 w-[22rem]"
            onHoverIndex={setReferenceActiveIndex}
            onSelect={handleReferenceInsert}
          />
        </div>
        <span className="inline-flex items-center gap-1 text-caption text-text-soft">
          <CornerDownLeft size={12} />
          回车保存
        </span>
      </div>
    );
  }

  const content = latestProgress ? (
    <p className="text-ui leading-5 text-text-muted">
      <InternalReferenceInlineText
        value={latestProgress.content}
        className="break-words"
        variant="todo-inline"
        onOpenInternalReference={onOpenInternalReference}
      />
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
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "grid min-w-0 gap-1 rounded-[var(--radius-6)] bg-transparent p-0 text-left transition-colors duration-[160ms] ease-[var(--ease-soft)]",
          latestProgress ? "hover:text-text" : "hover:text-text-muted",
        )}
        onClick={() => setMode("add")}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMode("add");
          }
        }}
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
      </div>
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
