import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import {
  findInternalReferenceElement,
  readInternalReferenceElement,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import {
  EMPTY_RICH_TEXT_HTML,
  getEditableRichTextHtml,
  getRenderableRichTextHtml,
  richTextHtmlToPlainText,
} from "../../lib/richTextContent";
import type { AiSettingsSnapshot, WorkspaceNoteRecord } from "../../lib/types";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  DeleteContextMenu,
  EmptyState,
  SectionHeader,
  TextField,
} from "../../ui/components";
import {
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";

interface WorkspaceNotesPanelProps {
  notes: WorkspaceNoteRecord[];
  saving?: boolean;
  deletingNote?: boolean;
  aiSettings?: AiSettingsSnapshot;
  onUpsertNote: (input: {
    noteId?: number;
    title?: string;
    markdown: string;
    html: string;
  }) => Promise<WorkspaceNoteRecord>;
  onDeleteNote?: (noteId: number) => Promise<unknown> | unknown;
  onOpenAiSettings?: () => void;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}

interface DraftWorkspaceNoteState {
  localId: string;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

type EditorItem =
  | { kind: "closed" }
  | { kind: "draft" }
  | { kind: "saved"; noteId: number };

interface ComposerState {
  key: string;
  noteId?: number;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

interface RecordResultItem {
  value: string;
  noteId?: number;
  title: string;
  previewHtml: string;
}

export function WorkspaceNotesPanel({
  notes,
  saving = false,
  deletingNote = false,
  aiSettings,
  onUpsertNote,
  onDeleteNote,
  onOpenAiSettings,
  onOpenInternalReference,
}: WorkspaceNotesPanelProps) {
  const { pushToast } = useFeedbackStore();
  const contactMentionOptions = useContactMentionOptions();
  const [optimisticNotes, setOptimisticNotes] = useState<Record<number, WorkspaceNoteRecord>>({});
  const mergedNotes = useMemo(() => {
    const noteMap = new Map<number, WorkspaceNoteRecord>();

    for (const note of notes) {
      noteMap.set(note.id, note);
    }

    for (const note of Object.values(optimisticNotes)) {
      noteMap.set(note.id, note);
    }

    return Array.from(noteMap.values());
  }, [notes, optimisticNotes]);
  const sortedNotes = useMemo(
    () =>
      [...mergedNotes].sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
    [mergedNotes],
  );
  const [draftNote, setDraftNote] = useState<DraftWorkspaceNoteState | null>(null);
  const [editorItem, setEditorItem] = useState<EditorItem>({ kind: "closed" });
  const [editorPersistState, setEditorPersistState] =
    useState<RichEditorPersistState>("idle");
  const [titleDirty, setTitleDirty] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [expandedRecordValue, setExpandedRecordValue] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    noteId: number;
    value: string;
    x: number;
    y: number;
  } | null>(null);
  const editingRecordRef = useRef<HTMLDivElement | null>(null);
  const editorExitInFlightRef = useRef(false);

  const activeNote =
    editorItem.kind === "saved"
      ? (sortedNotes.find((note) => note.id === editorItem.noteId) ?? null)
      : null;
  const editorValue =
    editorItem.kind === "draft"
      ? draftNote
        ? `draft:${draftNote.localId}`
        : null
      : editorItem.kind === "saved"
        ? `note:${editorItem.noteId}`
        : null;
  const showDraftInResults =
    draftNote !== null && (editorItem.kind === "draft" || !isDraftPristine(draftNote));
  const editorOpen = composer !== null;
  const editorHasPendingChanges =
    titleDirty ||
    editorPersistState === "dirty" ||
    editorPersistState === "saving";
  const recordResultItems = useMemo(
    () =>
      buildRecordResultItems({
        draftNote,
        notes: sortedNotes,
        showDraft: showDraftInResults,
      }),
    [draftNote, showDraftInResults, sortedNotes],
  );
  const contextMenuNote = useMemo(
    () =>
      contextMenu
        ? (sortedNotes.find((note) => note.id === contextMenu.noteId) ?? null)
        : null,
    [contextMenu, sortedNotes],
  );

  useEffect(() => {
    if (editorItem.kind === "saved") {
      if (!activeNote) {
        setEditorItem({ kind: "closed" });
        setComposer(null);
        return;
      }

      setComposer((current) =>
        current?.noteId === activeNote.id ? current : buildComposerFromNote(activeNote),
      );
      return;
    }

    if (editorItem.kind === "draft") {
      if (!draftNote) {
        setEditorItem({ kind: "closed" });
        setComposer(null);
        return;
      }

      setComposer((current) =>
        current?.noteId === undefined ? current : buildComposerFromDraft(draftNote),
      );
      return;
    }

    setComposer(null);
  }, [activeNote, draftNote, editorItem.kind]);

  useEffect(() => {
    setExpandedRecordValue((current) => {
      if (recordResultItems.length === 0) {
        return null;
      }

      if (current && recordResultItems.some((item) => item.value === current)) {
        return current;
      }

      return recordResultItems[0]?.value ?? null;
    });
  }, [recordResultItems]);

  function closeEditor() {
    if (draftNote && isDraftPristine(draftNote)) {
      setDraftNote(null);
    }

    setEditorItem({ kind: "closed" });
    setComposer(null);
    setTitleDirty(false);
  }

  const preventEditorTransition = useCallback(() => {
    if (editorExitInFlightRef.current) {
      return true;
    }

    if (!editorOpen || !editorHasPendingChanges) {
      return false;
    }

    pushToast({
      tone: "info",
      title: "请先保存当前工作区记录",
      detail: "保存后再切换或收起记录，能避免这次修改丢失。",
    });
    return true;
  }, [editorHasPendingChanges, editorOpen, pushToast]);

  const handleCreateNote = useCallback(() => {
    if (preventEditorTransition()) {
      return;
    }

    if (draftNote && !isDraftPristine(draftNote)) {
      pushToast({
        tone: "info",
        title: "请先保存当前草稿",
        detail: "当前已有未保存内容。保存后再新建，能避免草稿被覆盖。",
      });
      return;
    }

    const nextDraft = createDraftWorkspaceNote();
    setDraftNote(nextDraft);
    setEditorItem({ kind: "draft" });
    setComposer(buildComposerFromDraft(nextDraft));
    setExpandedRecordValue(`draft:${nextDraft.localId}`);
  }, [draftNote, preventEditorTransition, pushToast]);

  const handleEditRecord = useCallback(
    (value: string) => {
      if (editorValue === value) {
        return;
      }

      if (preventEditorTransition()) {
        return;
      }

      setContextMenu(null);

      if (value.startsWith("draft:")) {
        if (!draftNote) {
          return;
        }

        setEditorItem({ kind: "draft" });
        setComposer(buildComposerFromDraft(draftNote));
        setExpandedRecordValue(value);
        return;
      }

      const noteId = Number(value.replace("note:", ""));
      const nextNote = sortedNotes.find((item) => item.id === noteId);

      if (!nextNote) {
        return;
      }

      setEditorItem({ kind: "saved", noteId });
      setComposer(buildComposerFromNote(nextNote));
      setExpandedRecordValue(value);
    },
    [draftNote, editorValue, preventEditorTransition, sortedNotes],
  );

  const handleEditorChange = useCallback(
    (value: RichEditorValue) => {
      setComposer((current) =>
        current
          ? {
              ...current,
              contentMarkdown: value.markdown,
              contentHtml: value.html,
            }
          : current,
      );

      if (editorItem.kind === "draft") {
        setDraftNote((current) =>
          current
            ? {
                ...current,
                contentMarkdown: value.markdown,
                contentHtml: value.html,
              }
            : current,
        );
      }
    },
    [editorItem.kind],
  );

  const handleTitleChange = useCallback(
    (nextTitle: string) => {
      setTitleDirty(true);
      setComposer((current) => (current ? { ...current, title: nextTitle } : current));

      if (editorItem.kind === "draft") {
        setDraftNote((current) => (current ? { ...current, title: nextTitle } : current));
      }
    },
    [editorItem.kind],
  );

  const persistComposerNote = useCallback(
    async (value: RichEditorValue) => {
      if (!composer || editorItem.kind === "closed") {
        return undefined;
      }

      const normalizedValue = normalizeRichEditorValue(value);
      const explicitTitle = normalizeWorkspaceNoteTitleInput(composer.title);

      if (editorItem.kind === "draft") {
        const currentDraft = draftNote ?? createDraftWorkspaceNote();
        const nextDraft = {
          ...currentDraft,
          title: explicitTitle,
          contentMarkdown: normalizedValue.markdown,
          contentHtml: normalizedValue.html,
        };

        setDraftNote(nextDraft);

        if (isDraftPristine(nextDraft)) {
          return undefined;
        }

        const createdNote = await onUpsertNote({
          title: explicitTitle || undefined,
          markdown: normalizedValue.markdown,
          html: normalizedValue.html,
        });
        setOptimisticNotes((current) => ({
          ...current,
          [createdNote.id]: createdNote,
        }));
        setDraftNote(null);
        setEditorItem({ kind: "saved", noteId: createdNote.id });
        setComposer(buildComposerFromNote(createdNote));
        setTitleDirty(false);
        return createdNote;
      }

      if (!activeNote) {
        return undefined;
      }

      const updatedNote = await onUpsertNote({
        noteId: activeNote.id,
        title: explicitTitle || undefined,
        markdown: normalizedValue.markdown,
        html: normalizedValue.html,
      });
      setOptimisticNotes((current) => ({
        ...current,
        [updatedNote.id]: updatedNote,
      }));
      setComposer(buildComposerFromNote(updatedNote));
      setTitleDirty(false);
      return updatedNote;
    },
    [activeNote, composer, draftNote, editorItem.kind, onUpsertNote],
  );

  const handleSave = useCallback(
    async (value: RichEditorValue) => persistComposerNote(value),
    [persistComposerNote],
  );

  const finishEditingSession = useCallback(
    (savedNote?: unknown) => {
      const nextExpandedValue = isSavedWorkspaceNoteRecord(savedNote)
        ? `note:${savedNote.id}`
        : editorItem.kind === "saved"
          ? `note:${editorItem.noteId}`
          : editorValue;

      closeEditor();

      if (nextExpandedValue) {
        setExpandedRecordValue(nextExpandedValue);
      }
    },
    [editorItem, editorValue],
  );

  const handleSaveAndClose = useCallback(
    async (savedNote?: unknown) => {
      if (editorExitInFlightRef.current) {
        return;
      }

      editorExitInFlightRef.current = true;

      try {
        const nextSavedNote =
          isSavedWorkspaceNoteRecord(savedNote) || !composer
            ? savedNote
            : await handleSave({
                html: composer.contentHtml,
                text: composer.contentMarkdown,
                markdown: composer.contentMarkdown,
              });

        finishEditingSession(nextSavedNote);
      } catch {
        // The mutation hook owns the error feedback.
      } finally {
        editorExitInFlightRef.current = false;
      }
    },
    [composer, finishEditingSession, handleSave],
  );

  const toggleRecordResult = useCallback(
    (value: string) => {
      if (editorValue === value) {
        if (preventEditorTransition()) {
          return;
        }

        closeEditor();
        setExpandedRecordValue(value);
        return;
      }

      if (editorValue && editorValue !== value) {
        if (preventEditorTransition()) {
          return;
        }

        closeEditor();
      }

      setExpandedRecordValue((current) => (current === value ? null : value));
    },
    [editorValue, preventEditorTransition],
  );

  const handleDeleteRecord = useCallback(
    async (noteId: number, value: string) => {
      if (!onDeleteNote) {
        return;
      }

      await onDeleteNote(noteId);
      setOptimisticNotes((current) => {
        if (!(noteId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[noteId];
        return next;
      });
      setExpandedRecordValue((current) => (current === value ? null : current));

      if (editorValue === value) {
        closeEditor();
      }
    },
    [editorValue, onDeleteNote],
  );

  return (
    <>
      <section className="activity-notes min-w-0">
        <SectionHeader
          eyebrow="Workspace Notes"
          title="工作区记录"
          description="在工作区范围内记录当天线索、判断和暂存笔记，不绑定具体项目。"
          className="activity-notes__header"
          actions={
            <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={handleCreateNote}>
              新建
            </Button>
          }
        />

        <div className="activity-notes__rail">
          {recordResultItems.length > 0 ? (
            <div className="activity-notes__results">
              {recordResultItems.map((item) => {
                const isEditing = editorValue === item.value;
                const isExpanded = expandedRecordValue === item.value || isEditing;

                return (
                  <article
                    key={item.value}
                    id={item.noteId ? `workspace-note-${item.noteId}` : undefined}
                    ref={isEditing ? editingRecordRef : undefined}
                    className={[
                      "activity-notes__result-item",
                      isExpanded ? "activity-notes__result-item--active" : "",
                    ].join(" ")}
                    onMouseDownCapture={(event) => {
                      if (
                        isEditing ||
                        !item.noteId ||
                        !onDeleteNote ||
                        event.button !== 2 ||
                        shouldIgnoreWorkspaceRecordContextMenuTarget(event.target)
                      ) {
                        return;
                      }

                      event.preventDefault();
                    }}
                    onContextMenu={(event) => {
                      if (
                        isEditing ||
                        !item.noteId ||
                        !onDeleteNote ||
                        shouldIgnoreWorkspaceRecordContextMenuTarget(event.target)
                      ) {
                        return;
                      }

                      event.preventDefault();
                      setContextMenu({
                        noteId: item.noteId,
                        value: item.value,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    {isEditing && composer ? (
                      <div className="activity-notes__result-editor">
                        <div className="activity-notes__editor-header">
                          <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                            Workspace Note
                          </p>
                          <TextField
                            className="activity-notes__editor-title"
                            aria-label="工作区记录标题"
                            value={composer.title}
                            placeholder="输入标题"
                            onChange={(event) => handleTitleChange(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                void handleSaveAndClose();
                              }
                            }}
                          />
                          <div className="activity-notes__editor-actions">
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              disabled={saving || editorPersistState === "saving"}
                              onClick={() => void handleSaveAndClose()}
                            >
                              {editorPersistState === "saving" ? "保存中..." : "保存"}
                            </Button>
                          </div>
                        </div>

                        <RichEditor
                          key={composer.key}
                          html={composer.contentHtml}
                          variant="bare"
                          autoFocus
                          autosave={{
                            onChange: false,
                            onBlur: true,
                            onWindowBlur: true,
                            onVisibilityChange: true,
                          }}
                          shouldPersistOnBlur={(relatedTarget) =>
                            !(
                              relatedTarget instanceof Node &&
                              editingRecordRef.current?.contains(relatedTarget)
                            )
                          }
                          placeholder="记录今天需要随手沉淀的背景、判断和临时结论。"
                          internalReferences={{
                            context: { scope: "workspace" },
                            onOpenReference: onOpenInternalReference,
                          }}
                          contactMentions={contactMentionOptions}
                          aiSettings={aiSettings}
                          aiRewriteContext={{
                            scope: "workspace_note",
                            workspaceNoteId: composer.noteId ?? null,
                            sourceLabel: composer.title || null,
                          }}
                          onOpenAiSettings={onOpenAiSettings}
                          onChange={handleEditorChange}
                          onPersistStateChange={setEditorPersistState}
                          onBlurPersisted={(savedNote) => {
                            window.requestAnimationFrame(() => {
                              if (editingRecordRef.current?.contains(document.activeElement)) {
                                return;
                              }

                              void handleSaveAndClose(savedNote);
                            });
                          }}
                          onModEnter={() => handleSaveAndClose()}
                          onSave={handleSave}
                        />
                      </div>
                    ) : isExpanded ? (
                      <div className="activity-notes__result-browse">
                        <div className="activity-notes__result-row activity-notes__result-row--expanded">
                          <button
                            type="button"
                            className="activity-notes__result-toggle activity-notes__result-toggle--expanded"
                            aria-expanded={isExpanded}
                            onClick={() => toggleRecordResult(item.value)}
                          >
                            <p className="activity-notes__result-title text-body font-medium text-text">
                              {item.title}
                            </p>
                          </button>
                        </div>

                        <div className="activity-notes__result-preview">
                          <div
                            className="activity-notes__result-preview-panel"
                            aria-label={`编辑工作区记录：${item.title}`}
                            tabIndex={0}
                            onMouseDown={(event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey ||
                                isPreviewInteractiveTarget(event.target)
                              ) {
                                return;
                              }

                              event.preventDefault();
                              handleEditRecord(item.value);
                            }}
                            onKeyDown={(event) => {
                              if (isPreviewInteractiveTarget(event.target)) {
                                return;
                              }

                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleEditRecord(item.value);
                              }
                            }}
                            onClick={(event) => {
                              const internalReferenceElement = findInternalReferenceElement(
                                event.target,
                              );
                              const reference = readInternalReferenceElement(
                                internalReferenceElement,
                              );

                              if (!reference || !onOpenInternalReference) {
                                return;
                              }

                              event.preventDefault();
                              event.stopPropagation();
                              void onOpenInternalReference(reference);
                            }}
                          >
                            <div
                              className="rich-editor__surface activity-notes__result-preview-body"
                              dangerouslySetInnerHTML={{ __html: item.previewHtml }}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="activity-notes__result-row">
                        <button
                          type="button"
                          className="activity-notes__result-toggle"
                          aria-expanded={false}
                          onClick={() => toggleRecordResult(item.value)}
                        >
                          <p className="activity-notes__result-title text-body font-medium text-text">
                            {item.title}
                          </p>
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState text="还没有工作区记录。" compact />
          )}
        </div>
      </section>

      {contextMenu && contextMenuNote ? (
        <DeleteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="工作区记录操作"
          disabled={deletingNote}
          onClose={() => setContextMenu(null)}
          onDelete={() => void handleDeleteRecord(contextMenuNote.id, contextMenu.value)}
        />
      ) : null}
    </>
  );
}

function createDraftWorkspaceNote(): DraftWorkspaceNoteState {
  return {
    localId: `workspace-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "",
    contentMarkdown: "",
    contentHtml: EMPTY_RICH_TEXT_HTML,
  };
}

function buildComposerFromDraft(draft: DraftWorkspaceNoteState): ComposerState {
  return {
    key: `draft:${draft.localId}`,
    title: normalizeWorkspaceNoteTitleInput(draft.title),
    contentMarkdown: draft.contentMarkdown,
    contentHtml: draft.contentHtml || EMPTY_RICH_TEXT_HTML,
  };
}

function buildComposerFromNote(note: WorkspaceNoteRecord): ComposerState {
  return {
    key: `note:${note.id}:${note.updatedAt}`,
    noteId: note.id,
    title: normalizeWorkspaceNoteTitleInput(note.title),
    contentMarkdown: note.contentMarkdown,
    contentHtml: getEditableRichTextHtml({
      html: note.contentHtml,
      markdown: note.contentMarkdown,
    }),
  };
}

function buildRecordResultItems({
  draftNote,
  notes,
  showDraft,
}: {
  draftNote: DraftWorkspaceNoteState | null;
  notes: WorkspaceNoteRecord[];
  showDraft: boolean;
}): RecordResultItem[] {
  const items: RecordResultItem[] = [];

  if (draftNote && showDraft) {
    items.push({
      value: `draft:${draftNote.localId}`,
      title: resolveWorkspaceNoteDisplayTitle(draftNote),
      previewHtml: getRenderableRichTextHtml({
        html: draftNote.contentHtml,
        markdown: draftNote.contentMarkdown,
      }),
    });
  }

  for (const note of notes) {
    items.push({
      value: `note:${note.id}`,
      noteId: note.id,
      title: resolveWorkspaceNoteDisplayTitle(note),
      previewHtml: getRenderableRichTextHtml({
        html: note.contentHtml,
        markdown: note.contentMarkdown,
      }),
    });
  }

  return items;
}

function isSavedWorkspaceNoteRecord(value: unknown): value is WorkspaceNoteRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "contentMarkdown" in value &&
    "contentHtml" in value
  );
}

function isPreviewInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(
        target.closest("a, button, input, select, textarea, summary, [role='button']"),
      )
    : false;
}

function shouldIgnoreWorkspaceRecordContextMenuTarget(target: EventTarget | null) {
  return shouldIgnoreContextMenuTarget(target) || isPreviewInteractiveTarget(target);
}

function normalizeWorkspaceNoteTitleInput(title: string | null | undefined) {
  return title?.trim() ?? "";
}

function deriveWorkspaceNoteTitleFromContent(note: {
  contentHtml?: string | null;
  contentMarkdown?: string | null;
}) {
  const plainText = richTextHtmlToPlainText(
    getRenderableRichTextHtml({
      html: note.contentHtml,
      markdown: note.contentMarkdown,
    }),
  );

  if (!plainText) {
    return "工作区记录";
  }

  return plainText.slice(0, 48);
}

function resolveWorkspaceNoteDisplayTitle(note: {
  title?: string | null;
  contentHtml?: string | null;
  contentMarkdown?: string | null;
}) {
  return normalizeWorkspaceNoteTitleInput(note.title) || deriveWorkspaceNoteTitleFromContent(note);
}

function isDraftPristine(
  draft: Pick<DraftWorkspaceNoteState, "title" | "contentHtml" | "contentMarkdown">,
) {
  const normalizedHtml = draft.contentHtml.trim() || EMPTY_RICH_TEXT_HTML;

  return (
    normalizeWorkspaceNoteTitleInput(draft.title).length === 0 &&
    normalizedHtml === EMPTY_RICH_TEXT_HTML &&
    draft.contentMarkdown.trim().length === 0
  );
}
