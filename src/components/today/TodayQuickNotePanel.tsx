import { type FocusEvent, useCallback, useEffect, useRef, useState } from "react";

import type { InternalReferenceTarget } from "../../lib/internalReferences";
import { getEditableRichTextHtml } from "../../lib/richTextContent";
import type { WorkspaceNoteRecord } from "../../lib/types";
import {
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorValue,
} from "../rich-editor";

interface TodayQuickNotePanelProps {
  note: WorkspaceNoteRecord | null;
  saving?: boolean;
  onUpsertNote: (input: {
    markdown: string;
    html: string;
  }) => Promise<WorkspaceNoteRecord>;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}

export function TodayQuickNotePanel({
  note,
  saving = false,
  onUpsertNote,
  onOpenInternalReference,
}: TodayQuickNotePanelProps) {
  const [draft, setDraft] = useState<RichEditorValue>(() => buildTodayQuickNoteDraft(note));
  const skipBlurRef = useRef(false);

  useEffect(() => {
    setDraft(buildTodayQuickNoteDraft(note));
  }, [note?.contentHtml, note?.contentMarkdown, note?.id]);

  const handleSave = useCallback(async () => {
    if (saving) {
      return undefined;
    }

    const normalizedDraft = normalizeRichEditorValue(draft);
    const initialDraft = normalizeRichEditorValue(buildTodayQuickNoteDraft(note));

    if (
      normalizedDraft.markdown === initialDraft.markdown &&
      normalizedDraft.html === initialDraft.html
    ) {
      return note ?? undefined;
    }

    if (!normalizedDraft.markdown && !note) {
      return undefined;
    }

    return onUpsertNote({
      markdown: normalizedDraft.markdown,
      html: normalizedDraft.html,
    });
  }, [draft, note, onUpsertNote, saving]);

  return (
    <section
      onBlurCapture={(event) => {
        if (isFocusMovingWithinCurrentTarget(event)) {
          return;
        }
        if (skipBlurRef.current) {
          skipBlurRef.current = false;
          return;
        }
        void handleSave();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          skipBlurRef.current = true;
          setDraft(buildTodayQuickNoteDraft(note));
          blurKeyboardTarget(event.target);
          return;
        }
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          blurKeyboardTarget(event.target);
        }
      }}
    >
      <RichEditor
        html={draft.html}
        variant="toolbar"
        enableTables={false}
        placeholder="记下今天最需要先抓住的背景、判断、临时结论或提醒。"
        internalReferences={{
          context: { scope: "workspace" },
          onOpenReference: onOpenInternalReference,
        }}
        onChange={setDraft}
      />
    </section>
  );
}

function buildTodayQuickNoteDraft(note: WorkspaceNoteRecord | null): RichEditorValue {
  return {
    html: getEditableRichTextHtml({
      html: note?.contentHtml,
      markdown: note?.contentMarkdown,
    }),
    text: note?.contentMarkdown ?? "",
    markdown: note?.contentMarkdown ?? "",
  };
}

function isFocusMovingWithinCurrentTarget(event: FocusEvent<HTMLElement>) {
  const nextFocusedElement = event.relatedTarget;
  return nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement);
}

function isSubmitShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}

function blurKeyboardTarget(target: EventTarget | null) {
  if (target instanceof HTMLElement) {
    target.blur();
  }
}
