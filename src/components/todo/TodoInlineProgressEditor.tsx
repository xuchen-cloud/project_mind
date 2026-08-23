import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import type { ContactMentionTarget } from "../../lib/contactMentions";
import type { InternalReferenceTarget } from "../../lib/internalReferences";
import type { InternalReferenceContext } from "../../lib/types";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { ActionContextMenu } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { InternalReferenceInlineText } from "../internal-reference";
import { parseProgressInput } from "./todo-utils";
import { TodoProgressTextEditor } from "./TodoProgressTextEditor";

function normalizeProgressDraft(value: string) {
  return value.replace(/\r?\n+/gu, " ");
}

function isProgressDatePrefixTrigger(
  source: string,
  trigger: { start: number; end: number },
) {
  if (trigger.start !== 0) {
    return false;
  }

  return /^@\d{0,8}$/u.test(source.slice(0, trigger.end));
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
  onOpenContactMention,
  onEditingChange,
}: {
  latestProgress: { id: number; content: string; progressDate: string; dueDate?: string | null } | null;
  editable: boolean;
  onSave: (payload: { content: string; progressDate: string; dueDate?: string | null }) => Promise<unknown> | void;
  onUpdateLatestProgress?: (
    progressId: number,
    payload: { content: string; progressDate: string; dueDate?: string | null; status?: "unfinished" | "finished" },
  ) => Promise<unknown> | void;
  onDeleteLatestProgress?: (progressId: number) => Promise<unknown> | void;
  onError?: (message: string) => void;
  internalReferenceContext?: InternalReferenceContext | null;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"add" | "edit" | null>(null);
  const [saving, setSaving] = useState(false);
  const [optimisticLatestProgress, setOptimisticLatestProgress] = useState<{
    id: number;
    content: string;
    progressDate: string;
    dueDate?: string | null;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contactMentionOptions = useContactMentionOptions();
  const saveInFlightRef = useRef(false);
  const editing = mode !== null;
  const displayLatestProgress =
    latestProgress === null ? null : (optimisticLatestProgress ?? latestProgress);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    if (!editing) {
      setDraft("");
    }
  }, [editing]);

  useEffect(() => {
    if (mode === "edit" && displayLatestProgress) {
      setDraft(displayLatestProgress.content);
    }
    if (mode === "add") {
      setDraft("");
    }
  }, [displayLatestProgress, mode]);

  useEffect(() => {
    if (!optimisticLatestProgress || !latestProgress) {
      return;
    }

    if (
      latestProgress.content === optimisticLatestProgress.content &&
      latestProgress.progressDate === optimisticLatestProgress.progressDate &&
      (latestProgress.dueDate ?? null) === (optimisticLatestProgress.dueDate ?? null)
    ) {
      setOptimisticLatestProgress(null);
    }
  }, [latestProgress, optimisticLatestProgress]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }
    const normalizedDraft = normalizeProgressDraft(draft).trim();
    if (!normalizedDraft || /^@(?:\d{4}|\d{8})$/u.test(normalizedDraft)) {
      setMode(null);
      return;
    }

    const parsed = parseProgressInput(
      normalizedDraft,
      new Date(),
      mode === "edit" ? latestProgress?.progressDate : undefined,
      mode === "edit" ? latestProgress?.dueDate : undefined,
    );
    if (!parsed.ok) {
      onError?.(parsed.error);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    if (mode === "edit" && displayLatestProgress) {
      setOptimisticLatestProgress({
        id: displayLatestProgress.id,
        content: parsed.content,
        progressDate: parsed.progressDate,
        dueDate: parsed.dueDate,
      });
    }
    setMode(null);
    try {
      if (mode === "edit" && displayLatestProgress && onUpdateLatestProgress) {
        await onUpdateLatestProgress(displayLatestProgress.id, {
          content: parsed.content,
          progressDate: parsed.progressDate,
          ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
        });
      } else {
        await onSave({
          content: parsed.content,
          progressDate: parsed.progressDate,
          ...(parsed.dueDate ? { dueDate: parsed.dueDate } : {}),
        });
      }
    } catch (error) {
      setOptimisticLatestProgress(null);
      setMode(mode === "edit" ? "edit" : "add");
      throw error;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="todo-subtask-editor-row">
        <span className="todo-subtask-editor-row__check-placeholder" aria-hidden="true" />
        <div className="relative min-w-0 flex-1">
          <TodoProgressTextEditor
            value={draft}
            autoFocus
            disabled={saving}
            placeholder="输入子任务，Enter 保存"
            internalReferenceContext={internalReferenceContext}
            disableMentionTrigger={(trigger) => isProgressDatePrefixTrigger(draft, trigger)}
            onChange={setDraft}
            onCommit={() => {
              void handleSave();
            }}
            onCancel={() => setMode(null)}
          />
        </div>
      </div>
    );
  }

  const content = displayLatestProgress ? (
    <p className="text-ui leading-[1.2rem] text-text-muted">
      <InternalReferenceInlineText
        value={displayLatestProgress.content}
        className="break-words"
        variant="todo-inline"
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention ?? contactMentionOptions.onOpenContact}
      />
    </p>
  ) : null;

  if (!editable) {
    return content ? <div className="grid min-w-0 gap-1">{content}</div> : null;
  }

  return (
    <div className="grid min-w-0 gap-1">
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "todo-inline-progress-trigger w-full",
          displayLatestProgress ? "text-text" : "text-text-muted",
        )}
        onClick={() => {
          if (!saving) {
            setMode("add");
          }
        }}
        onKeyDown={(event) => {
          if (saving) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMode("add");
          }
        }}
        onContextMenu={(event) => {
          if (!displayLatestProgress || saving) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {content ?? (
          <span className="todo-inline-progress-trigger__empty">
            <Plus size={12} aria-hidden="true" />
            添加子任务
          </span>
        )}
      </div>
      {contextMenu && displayLatestProgress ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="子项操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Pencil,
              label: "编辑子项",
              onSelect: () => {
                if (!saving) {
                  setMode("edit");
                }
              },
            },
            {
              icon: Trash2,
              label: "删除子项",
              tone: "danger",
              onSelect: () => {
                void onDeleteLatestProgress?.(displayLatestProgress.id);
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}
