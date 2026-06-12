import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";

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

  return /^@\d{0,4}$/u.test(source.slice(0, trigger.end));
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
  latestProgress: { id: number; content: string; progressDate: string } | null;
  editable: boolean;
  onSave: (payload: { content: string; progressDate: string }) => Promise<unknown> | void;
  onUpdateLatestProgress?: (
    progressId: number,
    payload: { content: string; progressDate: string; status?: "unfinished" | "finished" },
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contactMentionOptions = useContactMentionOptions();
  const saveInFlightRef = useRef(false);
  const editing = mode !== null;

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

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
      <div className="relative">
        <TodoProgressTextEditor
          value={draft}
          autoFocus
          disabled={saving}
          placeholder="@0315 已与财务确认方案"
          internalReferenceContext={internalReferenceContext}
          disableMentionTrigger={(trigger) => isProgressDatePrefixTrigger(draft, trigger)}
          onChange={setDraft}
          onCommit={() => {
            void handleSave();
          }}
          onCancel={() => setMode(null)}
        />
      </div>
    );
  }

  const content = latestProgress ? (
    <p className="text-ui leading-[1.2rem] text-text-muted">
      <InternalReferenceInlineText
        value={latestProgress.content}
        className="break-words"
        variant="todo-inline"
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention ?? contactMentionOptions.onOpenContact}
      />
    </p>
  ) : (
    <p className="text-ui leading-[1.2rem] text-text-soft">点击添加子项...</p>
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
          "todo-inline-progress-trigger",
          latestProgress ? "text-text" : "text-text-muted",
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
          ariaLabel="子项操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Pencil,
              label: "编辑子项",
              onSelect: () => {
                setMode("edit");
              },
            },
            {
              icon: Trash2,
              label: "删除子项",
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
