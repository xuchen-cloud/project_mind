import { useEffect, useRef, useState } from "react";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  findInternalReferenceTextTrigger,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import type { ContactMentionTarget } from "../../lib/contactMentions";
import type {
  InternalReferenceContext,
  InternalReferenceSearchResult,
} from "../../lib/types";
import {
  InternalReferenceInlineText,
  InternalReferencePicker,
  useInternalReferenceSearch,
} from "../internal-reference";
import { TodoReferenceEditor } from "./TodoReferenceEditor";
import { cn } from "../../ui/lib/cn";

export function TodoInlineContentEditor({
  value,
  editable,
  onSave,
  internalReferenceContext,
  onOpenInternalReference,
  onOpenContactMention,
}: {
  value: string;
  editable: boolean;
  onSave: (content: string) => Promise<unknown> | void;
  internalReferenceContext?: InternalReferenceContext | null;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
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
      setDraft(value);
      setSelectionStart(null);
      setDismissedTriggerKey(null);
    }
  }, [editing, value]);

  useEffect(() => {
    if (!savedPulse) {
      return;
    }
    const timer = window.setTimeout(() => setSavedPulse(false), 160);
    return () => window.clearTimeout(timer);
  }, [savedPulse]);

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
  }, [referenceTrigger?.query, referencePickerOpen]);

  async function handleSave() {
    if (saveInFlightRef.current) {
      return;
    }
    const next = draft.replace(/\r?\n+/gu, " ").trim();
    if (!next) {
      setDraft(value);
      setEditing(false);
      return;
    }
    if (next === value.trim()) {
      setEditing(false);
      return;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
      setSavedPulse(true);
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
      <div className="relative">
        <TodoReferenceEditor
          editorRef={editorRef}
          value={draft}
          selectionOffset={selectionStart}
          autoFocus
          disabled={saving}
          textClassName="text-body leading-6 font-medium"
          onChange={(nextValue, nextSelection) => {
            setDraft(nextValue);
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
              setDraft(value);
              setEditing(false);
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
    );
  }

  return (
    <div
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      className={cn(
        "w-full rounded-[var(--radius-6)] bg-transparent px-0 py-0 text-left text-body font-medium leading-6 text-text transition-[background-color,color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] whitespace-pre-wrap break-words",
        editable &&
          "hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--color-text)_92%,var(--color-accent))]",
        savedPulse && "shadow-[0_0_0_4px_var(--color-accent-ring)]",
      )}
      onClick={() => {
        if (editable) {
          setEditing(true);
        }
      }}
      onKeyDown={(event) => {
        if (!editable) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      <InternalReferenceInlineText
        value={value}
        variant="todo-inline"
        onOpenInternalReference={onOpenInternalReference}
        onOpenContactMention={onOpenContactMention}
      />
    </div>
  );
}
