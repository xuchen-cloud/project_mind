import { useEffect, useRef, useState } from "react";

import { cn } from "../../ui/lib/cn";

export function TodoInlineContentEditor({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (content: string) => Promise<unknown> | void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);
  const saveInFlightRef = useRef(false);
  const skipBlurSaveRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
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

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        rows={1}
        className="min-h-8 w-full resize-none overflow-hidden rounded-[var(--radius-6)] border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-2.5 py-1.5 text-body leading-6 text-text outline-none"
        value={draft}
        autoFocus
        disabled={saving}
        onChange={(event) => setDraft(event.target.value.replace(/\r?\n+/gu, " "))}
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
            setDraft(value);
            setEditing(false);
            event.currentTarget.blur();
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "w-full rounded-[var(--radius-6)] bg-transparent px-0 py-0 text-left text-body font-medium leading-6 text-text transition-[background-color,color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] whitespace-pre-wrap break-words",
        editable &&
          "hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--color-text)_92%,var(--color-accent))]",
        savedPulse && "shadow-[0_0_0_4px_var(--color-accent-ring)]",
      )}
      disabled={!editable}
      onClick={() => {
        if (editable) {
          setEditing(true);
        }
      }}
    >
      {value}
    </button>
  );
}
