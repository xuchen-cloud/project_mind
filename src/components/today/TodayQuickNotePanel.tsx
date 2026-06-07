import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, StickyNote } from "lucide-react";

import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import type { InternalReferenceTarget } from "../../lib/internalReferences";
import { getEditableRichTextHtml } from "../../lib/richTextContent";
import type { ProjectListItem, WorkspaceNoteRecord } from "../../lib/types";
import { Button, Dialog } from "../../ui/components";
import {
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorSelectionAction,
  type RichEditorSelectionPayload,
  type RichEditorValue,
} from "../rich-editor";

interface TodayQuickNotePanelProps {
  note: WorkspaceNoteRecord | null;
  saving?: boolean;
  onUpsertNote: (input: {
    markdown: string;
    html: string;
  }) => Promise<WorkspaceNoteRecord>;
  projects?: ProjectListItem[];
  onAppendSelectionToProjectNote?: (input: TodayQuickNoteSelectionProjectNoteInput) => Promise<unknown>;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}

interface TodayQuickNoteSelectionProjectNoteInput {
  projectId: number;
  selection: RichEditorSelectionPayload;
}

type PendingSelectionAction =
  | { kind: "append"; selection: RichEditorSelectionPayload };

export function TodayQuickNotePanel({
  note,
  saving = false,
  onUpsertNote,
  projects = [],
  onAppendSelectionToProjectNote,
  onOpenInternalReference,
}: TodayQuickNotePanelProps) {
  const contactMentionOptions = useContactMentionOptions();
  const [draft, setDraft] = useState<RichEditorValue>(() => buildTodayQuickNoteDraft(note));
  const [pendingSelectionAction, setPendingSelectionAction] =
    useState<PendingSelectionAction | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<number | null>(null);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    setDraft(buildTodayQuickNoteDraft(note));
  }, [note?.contentHtml, note?.contentMarkdown, note?.id]);

  const handleSave = useCallback(async (value: RichEditorValue = draft) => {
    if (saving) {
      return undefined;
    }

    const normalizedDraft = normalizeRichEditorValue(value);
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

  const selectionActions = useMemo<RichEditorSelectionAction[]>(() => {
    const hasProjects = projects.length > 0;
    const actions: RichEditorSelectionAction[] = [];

    if (onAppendSelectionToProjectNote) {
      actions.push({
        key: "today-selection-append-project-note",
        label: "追加到项目默认笔记",
        icon: StickyNote,
        disabled: !hasProjects,
        onSelect: (selection) => {
          setTargetProjectId(projects[0]?.id ?? null);
          setPendingSelectionAction({ kind: "append", selection });
        },
      });
    }

    return actions;
  }, [onAppendSelectionToProjectNote, projects]);

  const closeSelectionDialog = useCallback(() => {
    if (selectionSaving) {
      return;
    }

    setPendingSelectionAction(null);
  }, [selectionSaving]);

  const handleConfirmSelectionAction = useCallback(async () => {
    if (!pendingSelectionAction || targetProjectId === null) {
      return;
    }

    setSelectionSaving(true);
    try {
      await onAppendSelectionToProjectNote?.({
        projectId: targetProjectId,
        selection: pendingSelectionAction.selection,
      });
      setPendingSelectionAction(null);
    } finally {
      setSelectionSaving(false);
    }
  }, [
    onAppendSelectionToProjectNote,
    pendingSelectionAction,
    targetProjectId,
  ]);

  return (
    <>
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
          variant="bare"
          enableTables={false}
          autosave={{
            delay: 120000,
            onBlur: false,
            onWindowBlur: true,
            onVisibilityChange: true,
          }}
          placeholder="记下今天最需要先抓住的背景、判断、临时结论或提醒。"
          selectionActions={selectionActions}
          internalReferences={{
            context: { scope: "workspace" },
            onOpenReference: onOpenInternalReference,
          }}
          contactMentions={contactMentionOptions}
          onChange={setDraft}
          onSave={handleSave}
        />
      </section>

      <Dialog
        open={Boolean(pendingSelectionAction)}
        title="追加到项目默认笔记"
        description="从总览笔记选中的内容会保留为富文本，并写入目标项目。"
        onClose={closeSelectionDialog}
        footer={
          <>
            <Button type="button" variant="ghost" disabled={selectionSaving} onClick={closeSelectionDialog}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={selectionSaving || targetProjectId === null}
              onClick={() => {
                void handleConfirmSelectionAction();
              }}
            >
              {selectionSaving ? "处理中..." : "确认"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-ui font-medium text-text">目标项目</span>
            <select
              className="h-9 rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,box-shadow] focus:border-border-strong focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
              value={targetProjectId ?? ""}
              onChange={(event) => setTargetProjectId(Number(event.target.value))}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded-[var(--radius-8)] border border-border bg-bg-subtle p-3">
            <p className="mb-2 text-caption font-medium uppercase tracking-[0.14em] text-text-soft">
              选区预览
            </p>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-body leading-6 text-text-muted">
              {pendingSelectionAction?.selection.text}
            </p>
          </div>
        </div>
      </Dialog>
    </>
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
