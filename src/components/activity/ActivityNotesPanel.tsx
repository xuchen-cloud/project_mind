import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronDown, LoaderCircle, PencilLine, Plus, Sparkles } from "lucide-react";

import { normalizeRichEditorValue, RichEditor } from "../rich-editor";
import type { RichEditorPersistState, RichEditorValue } from "../rich-editor";
import { fileTagColorValue } from "../../lib/constants";
import { fileHref, formatDateTime } from "../../lib/formatters";
import {
  createDraftNote,
  defaultNoteTemplateKey,
  getRenderableNoteHtml,
  isDefaultNoteTitle,
  noteTemplateColorKey,
  noteTemplateDefaultHtml,
  noteTemplateDefaultTitle,
  noteTemplateLabel,
  noteTemplateOptions,
  noteTemplatePlaceholder,
  summarizeNoteContent,
} from "../../lib/note-templates";
import type {
  AcceptedSuggestionResult,
  AiSuggestionRecord,
  DocumentRecord,
  NoteRecord,
  NoteTemplateKey,
  NoteUpsertInput,
  RecordTypeSettingsSnapshot,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PopoverPanel,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";

interface ActivityNotesPanelProps {
  projectId: number;
  activityId: number;
  notes: NoteRecord[];
  recordTypeSettings?: RecordTypeSettingsSnapshot | null;
  saving: boolean;
  onUpsertNote: (input: NoteUpsertInput) => Promise<NoteRecord>;
  onImportDocument: (sourcePath: string) => Promise<DocumentRecord>;
  aiEnabled?: boolean;
  aiBusy?: boolean;
  onGenerateAiSuggestions?: (noteId: number) => Promise<AiSuggestionRecord[]>;
  onAcceptAiSuggestion?: (suggestionId: number) => Promise<AcceptedSuggestionResult>;
  onManageRecordTypes?: () => void;
}

interface DraftNoteState {
  localId: string;
  noteType: NoteTemplateKey;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

type ActiveItem = { kind: "empty" } | { kind: "draft" } | { kind: "saved"; noteId: number };

interface ComposerState {
  key: string;
  noteId?: number;
  noteType: NoteTemplateKey;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

interface RecordResultItem {
  value: string;
  noteType: NoteTemplateKey;
  summary: string;
  previewHtml: string;
  updatedAt: string | null;
  isDraft: boolean;
}

interface AiRefinePreview {
  noteTitle: string;
  conclusions: AiSuggestionRecord[];
  todos: AiSuggestionRecord[];
}

export function ActivityNotesPanel({
  projectId,
  activityId,
  notes,
  recordTypeSettings = null,
  saving,
  onUpsertNote,
  onImportDocument,
  aiEnabled = false,
  aiBusy = false,
  onGenerateAiSuggestions,
  onAcceptAiSuggestion,
  onManageRecordTypes,
}: ActivityNotesPanelProps) {
  const { pushToast } = useFeedbackStore();
  const sortedNotes = useMemo(
    () =>
      [...notes].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [notes],
  );
  const defaultRecordType = defaultNoteTemplateKey(recordTypeSettings);
  const recordTypeMenuOptions = useMemo(
    () => noteTemplateOptions(recordTypeSettings),
    [recordTypeSettings],
  );
  const initialSelectedNote = sortedNotes[0] ?? null;

  const [draftNote, setDraftNote] = useState<DraftNoteState | null>(null);
  const [activeItem, setActiveItem] = useState<ActiveItem>(() =>
    initialSelectedNote ? { kind: "saved", noteId: initialSelectedNote.id } : { kind: "empty" },
  );
  const [editorPersistState, setEditorPersistState] = useState<RichEditorPersistState>("idle");
  const [composer, setComposer] = useState<ComposerState | null>(() =>
    initialSelectedNote ? buildComposerFromNote(initialSelectedNote, recordTypeSettings) : null,
  );
  const [aiPreview, setAiPreview] = useState<AiRefinePreview | null>(null);
  const [aiPreparing, setAiPreparing] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [expandedRecordValue, setExpandedRecordValue] = useState<string | null>(null);

  const previousActivityIdRef = useRef(activityId);

  const activeNote =
    activeItem.kind === "saved"
      ? sortedNotes.find((note) => note.id === activeItem.noteId) ?? null
      : null;

  useEffect(() => {
    if (previousActivityIdRef.current === activityId) {
      return;
    }

    previousActivityIdRef.current = activityId;
    setAiPreview(null);
    setDraftNote(null);

    if (sortedNotes.length > 0) {
      setActiveItem({ kind: "saved", noteId: sortedNotes[0].id });
      setComposer(buildComposerFromNote(sortedNotes[0], recordTypeSettings));
      return;
    }

    setActiveItem({ kind: "empty" });
    setComposer(null);
  }, [activityId, recordTypeSettings, sortedNotes]);

  useEffect(() => {
    if (activeItem.kind === "saved" && !activeNote) {
      if (sortedNotes.length > 0) {
        setActiveItem({ kind: "saved", noteId: sortedNotes[0].id });
        setComposer(buildComposerFromNote(sortedNotes[0], recordTypeSettings));
        return;
      }

      if (draftNote) {
        setActiveItem({ kind: "draft" });
        setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
        return;
      }

      setActiveItem({ kind: "empty" });
      setComposer(null);
      return;
    }

    if (activeItem.kind === "draft" && draftNote && composer === null) {
      setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
      return;
    }

    if (activeItem.kind === "empty" && sortedNotes.length > 0) {
      setActiveItem({ kind: "saved", noteId: sortedNotes[0].id });
      setComposer(buildComposerFromNote(sortedNotes[0], recordTypeSettings));
    }
  }, [activeItem.kind, activeNote, composer, draftNote, recordTypeSettings, sortedNotes]);

  const handleCreateNote = useCallback(
    (template: NoteTemplateKey) => {
      if (draftNote && !isDraftPristine(draftNote, draftNote.noteType, recordTypeSettings)) {
        pushToast({
          tone: "info",
          title: "请先保存当前草稿",
          detail: "当前已有未保存内容。保存后再新建其他记录类型，能避免草稿被覆盖。",
        });
        setCreateMenuOpen(false);
        return;
      }

      const nextDraft = createDraftNote(template, recordTypeSettings);
      setDraftNote(nextDraft);
      setActiveItem({ kind: "draft" });
      setComposer(buildComposerFromDraft(nextDraft, recordTypeSettings));
      setCreateMenuOpen(false);
    },
    [draftNote, pushToast, recordTypeSettings],
  );

  const handleEditRecord = useCallback(
    (value: string) => {
      if (value.startsWith("draft:")) {
        if (!draftNote) {
          return;
        }

        setActiveItem({ kind: "draft" });
        setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
        setExpandedRecordValue(value);
        return;
      }

      const noteId = Number(value.replace("note:", ""));
      const nextNote = sortedNotes.find((item) => item.id === noteId);

      if (!nextNote) {
        return;
      }

      setActiveItem({ kind: "saved", noteId });
      setComposer(buildComposerFromNote(nextNote, recordTypeSettings));
      setExpandedRecordValue(value);
    },
    [draftNote, recordTypeSettings, sortedNotes],
  );

  const handleEditorChange = useCallback(
    (value: RichEditorValue) => {
      setComposer((current) =>
        current
          ? {
              ...current,
              contentMarkdown: value.text,
              contentHtml: value.html,
            }
          : current,
      );

      if (activeItem.kind === "draft") {
        setDraftNote((current) =>
          current
            ? {
                ...current,
                contentMarkdown: value.text,
                contentHtml: value.html,
              }
            : current,
        );
      }
    },
    [activeItem.kind],
  );

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!composer || activeItem.kind === "empty") {
        return undefined;
      }

      return persistComposerNote({
        activeItem,
        activeNote,
        activityId,
        composer,
        draftNote,
        noteTemplateSettings: recordTypeSettings,
        onUpsertNote,
        projectId,
        setActiveItem,
        setComposer,
        setDraftNote,
        value,
      });
    },
    [activeItem, activeNote, activityId, composer, draftNote, onUpsertNote, projectId, recordTypeSettings],
  );

  const handleAiRefine = useCallback(async () => {
    if (
      !composer ||
      activeItem.kind === "empty" ||
      !aiEnabled ||
      aiBusy ||
      aiPreparing ||
      aiApplying ||
      !onGenerateAiSuggestions ||
      !composer.contentMarkdown.trim().length
    ) {
      return;
    }

    setAiPreparing(true);

    try {
      const savedNote = await persistComposerNote({
        activeItem,
        activeNote,
        activityId,
        composer,
        draftNote,
        noteTemplateSettings: recordTypeSettings,
        onUpsertNote,
        projectId,
        setActiveItem,
        setComposer,
        setDraftNote,
        value: {
          text: composer.contentMarkdown,
          html: composer.contentHtml,
          markdown: composer.contentMarkdown,
        },
      });

      if (!savedNote) {
        return;
      }

      const suggestions = await onGenerateAiSuggestions(savedNote.id);
      const currentNoteSuggestions = suggestions.filter(
        (suggestion) => suggestion.status === "pending" && suggestion.noteId === savedNote.id,
      );

      setAiPreview({
        noteTitle:
          savedNote.title?.trim() ||
          noteTemplateDefaultTitle(savedNote.noteType, recordTypeSettings),
        conclusions: currentNoteSuggestions.filter(
          (suggestion) => suggestion.suggestionType === "conclusion",
        ),
        todos: currentNoteSuggestions.filter((suggestion) => suggestion.suggestionType === "todo"),
      });
    } finally {
      setAiPreparing(false);
    }
  }, [
    activeItem,
    activeNote,
    activityId,
    aiApplying,
    aiBusy,
    aiEnabled,
    aiPreparing,
    composer,
    draftNote,
    onGenerateAiSuggestions,
    onUpsertNote,
    projectId,
    recordTypeSettings,
  ]);

  const handleConfirmAiRefine = useCallback(async () => {
    if (!aiPreview || !onAcceptAiSuggestion || aiApplying) {
      return;
    }

    const suggestionsToApply = [...aiPreview.conclusions, ...aiPreview.todos];

    if (suggestionsToApply.length === 0) {
      setAiPreview(null);
      return;
    }

    setAiApplying(true);

    try {
      for (const suggestion of suggestionsToApply) {
        await onAcceptAiSuggestion(suggestion.id);
      }

      setAiPreview(null);
    } finally {
      setAiApplying(false);
    }
  }, [aiApplying, aiPreview, onAcceptAiSuggestion]);

  const editorKey =
    activeItem.kind === "draft"
      ? `draft:${draftNote?.localId ?? "new"}:${composer?.noteType ?? defaultRecordType}`
      : activeItem.kind === "saved"
        ? `note:${composer?.noteId ?? "unknown"}:${composer?.noteType ?? defaultRecordType}`
        : "record-empty";
  const recordResultItems = useMemo<RecordResultItem[]>(
    () => buildRecordResultItems({ activeItem, draftNote, notes: sortedNotes }),
    [activeItem, draftNote, sortedNotes],
  );
  const noteHasContent = composer?.contentMarkdown.trim().length ? true : false;
  const recordMetaCopy =
    activeNote ? `更新于 ${formatDateTime(activeNote.updatedAt)}` : activeItem.kind === "draft" ? "新记录" : "尚未创建";
  const persistStateCopy =
    activeItem.kind === "empty"
      ? "尚未创建"
      : editorPersistState === "saving"
        ? activeItem.kind === "draft"
          ? "首次保存中"
          : "自动保存中"
        : editorPersistState === "error"
          ? "保存失败"
          : editorPersistState === "dirty"
            ? "等待保存"
            : activeNote
              ? "已保存"
              : noteHasContent
                ? "待保存"
                : "空白草稿";
  const aiActionDisabled =
    activeItem.kind === "empty" ||
    !aiEnabled ||
    !noteHasContent ||
    saving ||
    aiBusy ||
    aiPreparing ||
    aiApplying ||
    !onGenerateAiSuggestions ||
    !onAcceptAiSuggestion;
  const aiActionLabel = aiPreparing ? "提炼中..." : aiApplying ? "写入中..." : "AI 提炼";
  const aiSuggestionCount = (aiPreview?.conclusions.length ?? 0) + (aiPreview?.todos.length ?? 0);
  const toggleRecordResult = useCallback((value: string) => {
    setExpandedRecordValue((current) => (current === value ? null : value));
  }, []);

  useEffect(() => {
    setEditorPersistState("idle");
  }, [editorKey]);

  useEffect(() => {
    setExpandedRecordValue((current) => {
      if (recordResultItems.length === 0) {
        return null;
      }

      if (current && recordResultItems.some((item) => item.value === current)) {
        return current;
      }

      return recordResultItems[0].value;
    });
  }, [recordResultItems]);

  return (
    <>
      <section className="activity-notes min-w-0">
        <SectionHeader
          eyebrow="Activity Notes"
          title="记录"
          className="activity-notes__header"
          actions={
            <div className="activity-notes__header-actions">
              <div className="relative">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={saving}
                  leadingIcon={<Plus size={14} />}
                  trailingIcon={<ChevronDown size={14} />}
                  aria-haspopup="menu"
                  aria-expanded={createMenuOpen}
                  onClick={() => setCreateMenuOpen((current) => !current)}
                >
                  新建
                </Button>
                {createMenuOpen ? (
                  <PopoverPanel
                    className="absolute left-0 top-[calc(100%+8px)] z-10 grid min-w-48 gap-1 p-1"
                    role="menu"
                    aria-label="新建记录菜单"
                  >
                    {recordTypeMenuOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitem"
                        className="flex items-center gap-2 rounded-[var(--radius-6)] px-3 py-2 text-left text-body text-text transition-colors hover:bg-bg-hover"
                        onClick={() => handleCreateNote(option.value)}
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: fileTagColorValue(option.colorKey) }}
                          aria-hidden="true"
                        />
                        <span>{option.label}</span>
                      </button>
                    ))}
                    {onManageRecordTypes ? (
                      <div className="mt-1 border-t border-border pt-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="w-full justify-start px-3"
                          onClick={() => {
                            onManageRecordTypes();
                            setCreateMenuOpen(false);
                          }}
                        >
                          管理记录类型
                        </Button>
                      </div>
                    ) : null}
                  </PopoverPanel>
                ) : null}
              </div>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                leadingIcon={
                  aiPreparing || aiApplying ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Sparkles size={14} />
                  )
                }
                disabled={aiActionDisabled}
                onClick={() => void handleAiRefine()}
              >
                {aiActionLabel}
              </Button>
            </div>
          }
        />

        <div className="activity-notes__workspace">
          <div className="activity-notes__editor-column">
            <div className="activity-notes__editor-card">
              {composer ? (
                <>
                  <div className="activity-notes__editor-topbar">
                    <div className="activity-notes__editor-topbar-meta">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <RecordTypeBadge
                          label={noteTemplateLabel(composer.noteType, recordTypeSettings)}
                          colorKey={noteTemplateColorKey(composer.noteType, recordTypeSettings)}
                        />
                        {activeItem.kind === "draft" ? <StatusBadge tone="warning">未保存草稿</StatusBadge> : null}
                      </div>
                      <span className="text-ui text-text-soft">{recordMetaCopy}</span>
                    </div>
                    <span
                      className={[
                        "activity-notes__persist-state",
                        `activity-notes__persist-state--${editorPersistState}`,
                        editorPersistState === "error" ? "text-danger" : "",
                      ].join(" ")}
                    >
                      {persistStateCopy}
                    </span>
                  </div>

                  <RichEditor
                    key={editorKey}
                    html={composer.contentHtml}
                    variant="toolbar"
                    autosave={{ delay: 800 }}
                    placeholder={noteTemplatePlaceholder(composer.noteType, recordTypeSettings)}
                    onChange={handleEditorChange}
                    onPersistStateChange={setEditorPersistState}
                    onSave={handleSave}
                    assetHandlers={{
                      insertImage: async (sourcePath) => {
                        const doc = await onImportDocument(sourcePath);
                        return {
                          kind: "image" as const,
                          title: doc.name,
                          path: doc.managedPath,
                          src: desktopApi.toFileUrl(doc.managedPath),
                          mimeType: doc.mimeType,
                          documentId: doc.id,
                        };
                      },
                      insertFile: async (sourcePath) => {
                        const doc = await onImportDocument(sourcePath);
                        return {
                          kind: "file" as const,
                          title: doc.name,
                          path: doc.managedPath,
                          href: fileHref(doc.managedPath),
                          mimeType: doc.mimeType,
                          documentId: doc.id,
                          meta: doc.mimeType,
                        };
                      },
                    }}
                    onOpenAsset={(asset) => (asset.path ? desktopApi.revealPath(asset.path) : undefined)}
                  />
                </>
              ) : (
                <div className="p-4">
                  <EmptyState
                    title="还没有记录"
                    text="点“新建”后选择记录类型，再开始记录当前 activity 的内容。"
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </div>

          <aside className="activity-notes__rail">
            <div className="activity-notes__rail-header">
              <div>
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  其他记录
                </p>
                <p className="text-ui text-text-soft">切换查看或编辑已有记录。</p>
              </div>
              <span className="text-caption text-text-soft">{recordResultItems.length} 条</span>
            </div>

            {recordResultItems.length > 0 ? (
              <div className="activity-notes__results">
                {recordResultItems.map((item) => {
                  const isExpanded = expandedRecordValue === item.value;
                  const statusText = item.isDraft
                    ? "未保存草稿"
                    : item.updatedAt
                      ? `更新于 ${formatDateTime(item.updatedAt)}`
                      : "已保存";

                  return (
                    <article
                      key={item.value}
                      className={[
                        "activity-notes__result-item",
                        isExpanded ? "activity-notes__result-item--active" : "",
                      ].join(" ")}
                    >
                      <div className="activity-notes__result-row">
                        <button
                          type="button"
                          className="activity-notes__result-toggle"
                          aria-expanded={isExpanded}
                          onClick={() => toggleRecordResult(item.value)}
                        >
                          <div className="min-w-0 grid gap-1.5 text-left">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <RecordTypeBadge
                                label={noteTemplateLabel(item.noteType, recordTypeSettings)}
                                colorKey={noteTemplateColorKey(item.noteType, recordTypeSettings)}
                              />
                              <span className="text-ui text-text-soft">{statusText}</span>
                            </div>
                            <p className="activity-notes__result-summary text-body font-medium text-text">
                              {item.summary}
                            </p>
                          </div>
                          <ChevronDown
                            size={16}
                            className={[
                              "shrink-0 text-text-soft transition-transform duration-[160ms] ease-[var(--ease-soft)]",
                              isExpanded ? "rotate-180" : "",
                            ].join(" ")}
                          />
                        </button>
                        <IconButton
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="activity-notes__result-edit"
                          aria-label="编辑这条记录"
                          title="编辑这条记录"
                          onClick={() => handleEditRecord(item.value)}
                        >
                          <PencilLine size={14} />
                        </IconButton>
                      </div>

                      {isExpanded ? (
                        <div className="activity-notes__result-preview">
                          <div
                            className="rich-editor__surface activity-notes__result-preview-body"
                            dangerouslySetInnerHTML={{ __html: item.previewHtml }}
                          />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState text="当前没有其他记录。" compact />
            )}
          </aside>
        </div>
      </section>

      <Dialog
        open={aiPreview !== null}
        onClose={() => {
          if (aiApplying) {
            return;
          }
          setAiPreview(null);
        }}
        title="确认 AI 提炼"
        description={
          aiPreview
            ? `AI 已从“${aiPreview.noteTitle}”里提炼出候选结论和待办，确认后会自动写入当前 activity。`
            : undefined
        }
        widthClassName="max-w-3xl"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setAiPreview(null)} disabled={aiApplying}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={aiApplying || aiSuggestionCount === 0}
              onClick={() => void handleConfirmAiRefine()}
            >
              {aiApplying ? "写入中..." : `确认并写入${aiSuggestionCount > 0 ? `（${aiSuggestionCount}项）` : ""}`}
            </Button>
          </>
        }
      >
        {aiPreview ? (
          <div className="grid gap-4 md:grid-cols-2">
            <SurfaceCard subtle className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  会议结论
                </p>
                <StatusBadge tone="neutral">{aiPreview.conclusions.length} 条</StatusBadge>
              </div>
              {aiPreview.conclusions.length > 0 ? (
                <ol className="grid gap-3">
                  {aiPreview.conclusions.map((suggestion, index) => (
                    <li
                      key={suggestion.id}
                      className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
                    >
                      <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-bg text-ui font-medium text-text-soft">
                        {index + 1}
                      </span>
                      <p className="text-body leading-6 text-text">{suggestion.preview}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState text="这次没有提炼出明确结论。" compact />
              )}
            </SurfaceCard>

            <SurfaceCard subtle className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  待办事项
                </p>
                <StatusBadge tone="neutral">{aiPreview.todos.length} 条</StatusBadge>
              </div>
              {aiPreview.todos.length > 0 ? (
                <ol className="grid gap-3">
                  {aiPreview.todos.map((suggestion, index) => (
                    <li
                      key={suggestion.id}
                      className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
                    >
                      <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-bg text-ui font-medium text-text-soft">
                        {index + 1}
                      </span>
                      <p className="text-body leading-6 text-text">{suggestion.preview}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState text="这次没有提炼出待办事项。" compact />
              )}
            </SurfaceCard>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function RecordTypeBadge({
  label,
  colorKey,
}: {
  label: string;
  colorKey: ReturnType<typeof noteTemplateColorKey>;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-4)] px-2 py-1 text-caption font-medium tracking-[0.08em] text-text" style={{ backgroundColor: `color-mix(in srgb, ${fileTagColorValue(colorKey)} 14%, var(--color-bg))`, color: fileTagColorValue(colorKey) }}>
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: fileTagColorValue(colorKey) }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}

function buildComposerFromDraft(
  draft: DraftNoteState,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
): ComposerState {
  return {
    key: `draft:${draft.localId}:${draft.noteType}`,
    noteType: draft.noteType,
    title: draft.title || noteTemplateDefaultTitle(draft.noteType, noteTemplateSettings),
    contentMarkdown: draft.contentMarkdown,
    contentHtml: draft.contentHtml || noteTemplateDefaultHtml(draft.noteType, noteTemplateSettings),
  };
}

function buildRecordResultItems({
  activeItem,
  draftNote,
  notes,
}: {
  activeItem: ActiveItem;
  draftNote: DraftNoteState | null;
  notes: NoteRecord[];
}): RecordResultItem[] {
  const items: RecordResultItem[] = [];

  if (draftNote && activeItem.kind !== "draft") {
    items.push({
      value: `draft:${draftNote.localId}`,
      noteType: draftNote.noteType,
      summary: summarizeNoteContent({ contentMarkdown: draftNote.contentMarkdown }),
      previewHtml: getRenderableNoteHtml({
        contentHtml: draftNote.contentHtml,
        contentMarkdown: draftNote.contentMarkdown,
      }),
      updatedAt: null,
      isDraft: true,
    });
  }

  for (const note of notes) {
    if (activeItem.kind === "saved" && activeItem.noteId === note.id) {
      continue;
    }

    items.push({
      value: `note:${note.id}`,
      noteType: note.noteType,
      summary: summarizeNoteContent(note),
      previewHtml: getRenderableNoteHtml(note),
      updatedAt: note.updatedAt,
      isDraft: false,
    });
  }

  return items;
}

function buildComposerFromNote(
  note: NoteRecord,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
): ComposerState {
  return {
    key: `note:${note.id}:${note.updatedAt}:${note.noteType}`,
    noteId: note.id,
    noteType: note.noteType,
    title: note.title?.trim() || noteTemplateDefaultTitle(note.noteType, noteTemplateSettings),
    contentMarkdown: note.contentMarkdown,
    contentHtml: getRenderableNoteHtml(note),
  };
}

function resolveNoteTitle(
  currentTitle: string | null | undefined,
  currentTemplate: NoteTemplateKey,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  if (isDefaultNoteTitle(currentTitle, currentTemplate, noteTemplateSettings)) {
    return noteTemplateDefaultTitle(currentTemplate, noteTemplateSettings);
  }

  return currentTitle?.trim() || noteTemplateDefaultTitle(currentTemplate, noteTemplateSettings);
}

function persistComposerNote({
  activeItem,
  activeNote,
  activityId,
  composer,
  draftNote,
  noteTemplateSettings,
  onUpsertNote,
  projectId,
  setActiveItem,
  setComposer,
  setDraftNote,
  value,
}: {
  activeItem: ActiveItem;
  activeNote: NoteRecord | null;
  activityId: number;
  composer: ComposerState;
  draftNote: DraftNoteState | null;
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null;
  onUpsertNote: (input: NoteUpsertInput) => Promise<NoteRecord>;
  projectId: number;
  setActiveItem: Dispatch<SetStateAction<ActiveItem>>;
  setComposer: Dispatch<SetStateAction<ComposerState | null>>;
  setDraftNote: Dispatch<SetStateAction<DraftNoteState | null>>;
  value: RichEditorValue;
}) {
  const normalizedValue = normalizeRichEditorValue(value);

  if (activeItem.kind === "draft") {
    const currentDraft = draftNote ?? createDraftNote(composer.noteType, noteTemplateSettings);
    const nextDraft = {
      ...currentDraft,
      noteType: composer.noteType,
      title: composer.title,
      contentMarkdown: normalizedValue.text,
      contentHtml: normalizedValue.html,
    };

    setDraftNote(nextDraft);

    if (isDraftPristine(nextDraft, composer.noteType, noteTemplateSettings)) {
      return Promise.resolve(undefined);
    }

    return onUpsertNote({
      projectId,
      activityId,
      noteType: composer.noteType,
      title: resolveNoteTitle(nextDraft.title, nextDraft.noteType, noteTemplateSettings),
      markdown: normalizedValue.text,
      html: normalizedValue.html,
    }).then((createdNote) => {
      setDraftNote(null);
      setActiveItem({ kind: "saved", noteId: createdNote.id });
      setComposer(buildComposerFromNote(createdNote, noteTemplateSettings));
      return createdNote;
    });
  }

  if (!activeNote) {
    return Promise.resolve(undefined);
  }

  return onUpsertNote({
    projectId,
    activityId,
    noteId: activeNote.id,
    noteType: composer.noteType,
    title: resolveNoteTitle(activeNote.title, activeNote.noteType, noteTemplateSettings),
    markdown: normalizedValue.text,
    html: normalizedValue.html,
  }).then((updatedNote) => {
    setComposer(buildComposerFromNote(updatedNote, noteTemplateSettings));
    return updatedNote;
  });
}

function isDraftPristine(
  draft: Pick<DraftNoteState, "contentHtml" | "contentMarkdown">,
  template: NoteTemplateKey,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  return (
    normalizeEditorHtml(draft.contentHtml, noteTemplateSettings) ===
      normalizeEditorHtml(noteTemplateDefaultHtml(template, noteTemplateSettings), noteTemplateSettings) &&
    draft.contentMarkdown.trim().length === 0
  );
}

function normalizeEditorHtml(
  html: string,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  const normalized = html.trim();
  return normalized.length > 0
    ? normalized
    : noteTemplateDefaultHtml(defaultNoteTemplateKey(noteTemplateSettings), noteTemplateSettings);
}
