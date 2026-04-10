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

import {
  isAiJobActive,
  aiNoteSuggestionsJobTargetKey,
  useAiJobTarget,
} from "../../lib/aiJobs";
import { normalizeRichEditorValue, RichEditor } from "../rich-editor";
import type { RichEditorPersistState, RichEditorValue } from "../rich-editor";
import { fileTagColorValue } from "../../lib/constants";
import { fileHref, formatDateTime } from "../../lib/formatters";
import {
  resolveSuggestedTodoPriority,
  todoPriorityOptionLabel,
} from "../../lib/todo-priority";
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
  AiAcceptSuggestionInput,
  AiSuggestionRecord,
  AiSuggestionFeatureType,
  DocumentRecord,
  NoteRecord,
  NoteTemplateKey,
  NoteUpsertInput,
  RecordTypeSettingsSnapshot,
  TodoPriority,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  PopoverPanel,
  ProjectStarButton,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";
import { TodoPriorityDropdown } from "../todo/TodoPriorityDropdown";

interface ActivityNotesPanelProps {
  projectId: number;
  activityId: number;
  notes: NoteRecord[];
  recordTypeSettings?: RecordTypeSettingsSnapshot | null;
  saving: boolean;
  onUpsertNote: (input: NoteUpsertInput) => Promise<NoteRecord>;
  onImportDocument: (sourcePath: string) => Promise<DocumentRecord>;
  showAiRefine?: boolean;
  aiReady?: boolean;
  enabledSuggestionTypes?: AiSuggestionFeatureType[];
  onGenerateAiSuggestions?: (noteId: number) => Promise<AiSuggestionRecord[]>;
  onAcceptAiSuggestion?: (input: AiAcceptSuggestionInput) => Promise<AcceptedSuggestionResult>;
  onManageRecordTypes?: () => void;
}

interface DraftNoteState {
  localId: string;
  noteType: NoteTemplateKey;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

type EditorItem = { kind: "closed" } | { kind: "draft" } | { kind: "saved"; noteId: number };

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
  noteId?: number;
  noteType: NoteTemplateKey;
  summary: string;
  previewHtml: string;
  updatedAt: string | null;
  isDraft: boolean;
}

interface AiRefinePreview {
  noteTitle: string;
  conclusions: AiConclusionDraft[];
  todos: AiTodoDraft[];
}

interface AiConclusionDraft {
  suggestionId: number;
  checked: boolean;
  content: string;
  promotedToProject: boolean;
}

interface AiTodoDraft {
  suggestionId: number;
  checked: boolean;
  content: string;
  priority: TodoPriority;
  autoPriority: TodoPriority;
}

export function ActivityNotesPanel({
  projectId,
  activityId,
  notes,
  recordTypeSettings = null,
  saving,
  onUpsertNote,
  onImportDocument,
  showAiRefine = false,
  aiReady = false,
  enabledSuggestionTypes = [],
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
  const [draftNote, setDraftNote] = useState<DraftNoteState | null>(null);
  const [editorItem, setEditorItem] = useState<EditorItem>({ kind: "closed" });
  const [editorPersistState, setEditorPersistState] = useState<RichEditorPersistState>("idle");
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [aiPreview, setAiPreview] = useState<AiRefinePreview | null>(null);
  const [aiPersisting, setAiPersisting] = useState(false);
  const [aiJobNoteId, setAiJobNoteId] = useState<number | null>(null);
  const [aiApplying, setAiApplying] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [expandedRecordValue, setExpandedRecordValue] = useState<string | null>(null);
  const suggestionTypeSet = useMemo(
    () => new Set<AiSuggestionFeatureType>(enabledSuggestionTypes),
    [enabledSuggestionTypes],
  );
  const showConclusionSuggestions = suggestionTypeSet.has("conclusion");
  const showTodoSuggestions = suggestionTypeSet.has("todo");

  const previousActivityIdRef = useRef(activityId);
  const aiJob = useAiJobTarget(
    aiJobNoteId !== null ? aiNoteSuggestionsJobTargetKey(aiJobNoteId) : "__idle__",
  );
  const aiJobActive = isAiJobActive(aiJob);

  const activeNote =
    editorItem.kind === "saved"
      ? sortedNotes.find((note) => note.id === editorItem.noteId) ?? null
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
    draftNote !== null &&
    (editorItem.kind === "draft" ||
      !isDraftPristine(draftNote, draftNote.noteType, recordTypeSettings));
  const editorOpen = composer !== null;

  const closeEditor = useCallback(() => {
    if (draftNote && isDraftPristine(draftNote, draftNote.noteType, recordTypeSettings)) {
      setDraftNote(null);
    }

    setAiPreview(null);
    setAiJobNoteId(null);
    setEditorItem({ kind: "closed" });
    setComposer(null);
  }, [draftNote, recordTypeSettings]);

  useEffect(() => {
    if (previousActivityIdRef.current === activityId) {
      return;
    }

    previousActivityIdRef.current = activityId;
    setAiPreview(null);
    setAiJobNoteId(null);
    setDraftNote(null);
    setCreateMenuOpen(false);
    setExpandedRecordValue(null);
    setEditorItem({ kind: "closed" });
    setComposer(null);
  }, [activityId]);

  useEffect(() => {
    if (!showAiRefine || enabledSuggestionTypes.length === 0) {
      setAiPreview(null);
      setAiJobNoteId(null);
    }
  }, [enabledSuggestionTypes.length, showAiRefine]);

  useEffect(() => {
    if (editorItem.kind === "saved") {
      if (!activeNote) {
        if (composer === null || composer.noteId !== editorItem.noteId) {
          setAiPreview(null);
          setAiJobNoteId(null);
          setEditorItem({ kind: "closed" });
          setComposer(null);
        }
        return;
      }

      if (composer === null || composer.noteId !== activeNote.id) {
        setComposer(buildComposerFromNote(activeNote, recordTypeSettings));
      }
      return;
    }

    if (editorItem.kind === "draft") {
      if (!draftNote) {
        setAiPreview(null);
        setAiJobNoteId(null);
        setEditorItem({ kind: "closed" });
        setComposer(null);
        return;
      }

      if (
        composer === null ||
        composer.noteId !== undefined ||
        composer.noteType !== draftNote.noteType
      ) {
        setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
      }
      return;
    }

    if (composer !== null) {
      setComposer(null);
    }
  }, [activeNote, composer, draftNote, editorItem.kind, recordTypeSettings]);

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
      setAiPreview(null);
      setAiJobNoteId(null);
      setEditorItem({ kind: "draft" });
      setComposer(buildComposerFromDraft(nextDraft, recordTypeSettings));
      setExpandedRecordValue(`draft:${nextDraft.localId}`);
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

        setAiPreview(null);
        setAiJobNoteId(null);
        setEditorItem({ kind: "draft" });
        setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
        setExpandedRecordValue(value);
        return;
      }

      const noteId = Number(value.replace("note:", ""));
      const nextNote = sortedNotes.find((item) => item.id === noteId);

      if (!nextNote) {
        return;
      }

      setAiPreview(null);
      setAiJobNoteId(null);
      setEditorItem({ kind: "saved", noteId });
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

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!composer || editorItem.kind === "closed") {
        return undefined;
      }

      return persistComposerNote({
        editorItem,
        activeNote,
        activityId,
        composer,
        draftNote,
        noteTemplateSettings: recordTypeSettings,
        onUpsertNote,
        projectId,
        setEditorItem,
        setComposer,
        setDraftNote,
        value,
      });
    },
    [editorItem, activeNote, activityId, composer, draftNote, onUpsertNote, projectId, recordTypeSettings],
  );

  const handleAiRefine = useCallback(async () => {
    if (
      !composer ||
      editorItem.kind === "closed" ||
      !showAiRefine ||
      !aiReady ||
      aiPersisting ||
      aiJobActive ||
      aiApplying ||
      !onGenerateAiSuggestions ||
      !composer.contentMarkdown.trim().length
    ) {
      return;
    }

    setAiPersisting(true);

    try {
      const savedNote = await persistComposerNote({
        editorItem,
        activeNote,
        activityId,
        composer,
        draftNote,
        noteTemplateSettings: recordTypeSettings,
        onUpsertNote,
        projectId,
        setEditorItem,
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

      setAiJobNoteId(savedNote.id);
      const suggestions = await onGenerateAiSuggestions(savedNote.id);
      const currentNoteSuggestions = suggestions.filter(
        (suggestion) => suggestion.status === "pending" && suggestion.noteId === savedNote.id,
      );

      setAiPreview({
        noteTitle:
          savedNote.title?.trim() ||
          noteTemplateDefaultTitle(savedNote.noteType, recordTypeSettings),
        conclusions: showConclusionSuggestions
          ? currentNoteSuggestions
              .filter((suggestion) => suggestion.suggestionType === "conclusion")
              .map(buildConclusionSuggestionDraft)
          : [],
        todos: showTodoSuggestions
          ? currentNoteSuggestions
              .filter((suggestion) => suggestion.suggestionType === "todo")
              .map(buildTodoSuggestionDraft)
          : [],
      });
    } finally {
      setAiPersisting(false);
    }
  }, [
    editorItem,
    activeNote,
    activityId,
    aiApplying,
    aiJobActive,
    aiPersisting,
    aiReady,
    composer,
    draftNote,
    onGenerateAiSuggestions,
    onUpsertNote,
    projectId,
    recordTypeSettings,
    showAiRefine,
    showConclusionSuggestions,
    showTodoSuggestions,
  ]);

  const handleConfirmAiRefine = useCallback(async () => {
    if (!aiPreview || !onAcceptAiSuggestion || aiApplying) {
      return;
    }

    const selectedConclusions = aiPreview.conclusions.filter(
      (suggestion) => suggestion.checked && suggestion.content.trim().length > 0,
    );
    const selectedTodos = aiPreview.todos.filter(
      (suggestion) => suggestion.checked && suggestion.content.trim().length > 0,
    );
    const suggestionsToApply = [...selectedConclusions, ...selectedTodos];

    if (suggestionsToApply.length === 0) {
      setAiPreview(null);
      return;
    }

    setAiApplying(true);

    try {
      for (const suggestion of selectedConclusions) {
        await onAcceptAiSuggestion({
          suggestionId: suggestion.suggestionId,
          payloadOverride: {
            content: suggestion.content.trim(),
            promotedToProject: suggestion.promotedToProject,
          },
        });
      }

      for (const suggestion of selectedTodos) {
        await onAcceptAiSuggestion({
          suggestionId: suggestion.suggestionId,
          payloadOverride: {
            content: suggestion.content.trim(),
            priority: suggestion.priority,
          },
        });
      }

      setAiPreview(null);
    } finally {
      setAiApplying(false);
    }
  }, [aiApplying, aiPreview, onAcceptAiSuggestion]);

  const editorKey =
    editorItem.kind === "draft"
      ? `draft:${draftNote?.localId ?? "new"}:${composer?.noteType ?? defaultRecordType}`
      : editorItem.kind === "saved"
        ? `note:${composer?.noteId ?? "unknown"}:${composer?.noteType ?? defaultRecordType}`
        : "record-empty";
  const recordResultItems = useMemo<RecordResultItem[]>(
    () => buildRecordResultItems({ draftNote, notes: sortedNotes, showDraft: showDraftInResults }),
    [draftNote, showDraftInResults, sortedNotes],
  );
  const noteHasContent = composer?.contentMarkdown.trim().length ? true : false;
  const recordMetaCopy =
    activeNote ? `更新于 ${formatDateTime(activeNote.updatedAt)}` : editorItem.kind === "draft" ? "新记录" : "尚未创建";
  const persistStateCopy =
    editorItem.kind === "closed"
      ? "未进入编辑"
      : editorPersistState === "saving"
        ? editorItem.kind === "draft"
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
    editorItem.kind === "closed" ||
    !showAiRefine ||
    !aiReady ||
    enabledSuggestionTypes.length === 0 ||
    !noteHasContent ||
    saving ||
    aiPersisting ||
    aiJobActive ||
    aiApplying ||
    !onGenerateAiSuggestions ||
    !onAcceptAiSuggestion;
  const aiActionLabel = aiPersisting
    ? "准备中..."
    : aiJob?.status === "queued"
      ? "排队中..."
      : aiJob?.status === "running"
        ? "提炼中..."
        : aiApplying
          ? "写入中..."
          : "AI 提炼";
  const aiSelectionSummary = useMemo(() => {
    const conclusions = aiPreview?.conclusions ?? [];
    const todos = aiPreview?.todos ?? [];
    const totalCount = conclusions.length + todos.length;
    const selectedCount = [...conclusions, ...todos].filter((item) => item.checked).length;
    const hasInvalidSelection = [...conclusions, ...todos].some(
      (item) => item.checked && item.content.trim().length === 0,
    );

    return {
      totalCount,
      selectedCount,
      hasInvalidSelection,
      selectedConclusions: conclusions.filter((item) => item.checked).length,
      selectedTodos: todos.filter((item) => item.checked).length,
    };
  }, [aiPreview]);
  const updateAiPreview = useCallback(
    (
      updater: (current: AiRefinePreview) => AiRefinePreview,
    ) => {
      setAiPreview((current) => (current ? updater(current) : current));
    },
    [],
  );
  const toggleAiConclusion = useCallback(
    (suggestionId: number) => {
      updateAiPreview((current) => ({
        ...current,
        conclusions: current.conclusions.map((item) =>
          item.suggestionId === suggestionId ? { ...item, checked: !item.checked } : item,
        ),
      }));
    },
    [updateAiPreview],
  );
  const toggleAiTodo = useCallback(
    (suggestionId: number) => {
      updateAiPreview((current) => ({
        ...current,
        todos: current.todos.map((item) =>
          item.suggestionId === suggestionId ? { ...item, checked: !item.checked } : item,
        ),
      }));
    },
    [updateAiPreview],
  );
  const updateAiConclusionField = useCallback(
    (
      suggestionId: number,
      field: "content" | "promotedToProject",
      value: string | boolean,
    ) => {
      updateAiPreview((current) => ({
        ...current,
        conclusions: current.conclusions.map((item) =>
          item.suggestionId === suggestionId ? { ...item, [field]: value } : item,
        ),
      }));
    },
    [updateAiPreview],
  );
  const updateAiTodoField = useCallback(
    (
      suggestionId: number,
      field: "content" | "priority",
      value: string | TodoPriority,
    ) => {
      updateAiPreview((current) => ({
        ...current,
        todos: current.todos.map((item) =>
          item.suggestionId === suggestionId ? { ...item, [field]: value } : item,
        ),
      }));
    },
    [updateAiPreview],
  );
  const toggleRecordResult = useCallback((value: string) => {
    if (editorValue && editorValue !== value) {
      closeEditor();
    }
    setExpandedRecordValue((current) => (current === value ? null : value));
  }, [closeEditor, editorValue]);

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
            editorOpen && showAiRefine ? (
              <div className="activity-notes__header-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  leadingIcon={
                    aiPersisting || aiJobActive || aiApplying ? (
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
            ) : undefined
          }
        />

        <div
          className={[
            "activity-notes__workspace",
            editorOpen ? "activity-notes__workspace--with-editor" : "",
          ].join(" ")}
        >
          {composer ? (
            <div className="activity-notes__editor-column">
              <div
                id={activeNote ? `note-${activeNote.id}` : undefined}
                className="activity-notes__editor-card"
              >
                <div className="activity-notes__editor-topbar">
                  <div className="activity-notes__editor-topbar-meta">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <RecordTypeBadge
                        label={noteTemplateLabel(composer.noteType, recordTypeSettings)}
                        colorKey={noteTemplateColorKey(composer.noteType, recordTypeSettings)}
                      />
                      {editorItem.kind === "draft" ? <StatusBadge tone="warning">未保存草稿</StatusBadge> : null}
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
              </div>
            </div>
          ) : null}

          <aside className="activity-notes__rail">
            <div className="activity-notes__rail-header">
              <div>
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  记录
                </p>
                <p className="text-ui text-text-soft">新建、浏览或继续编辑当前 activity 的记录。</p>
              </div>
              <div className="activity-notes__rail-actions">
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
                      className="absolute right-0 top-[calc(100%+8px)] z-10 grid min-w-48 gap-1 p-1"
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
                <span className="text-caption text-text-soft">{recordResultItems.length} 条</span>
              </div>
            </div>

            {recordResultItems.length > 0 ? (
              <div className="activity-notes__results">
                {recordResultItems.map((item) => {
                  const isExpanded = expandedRecordValue === item.value;
                  const isEditing = editorValue === item.value;
                  const statusText = item.isDraft
                    ? isEditing
                      ? "草稿编辑中"
                      : "未保存草稿"
                    : isEditing
                      ? "正在编辑"
                    : item.updatedAt
                      ? `更新于 ${formatDateTime(item.updatedAt)}`
                      : "已保存";

                  return (
                    <article
                      key={item.value}
                      id={item.noteId ? `note-${item.noteId}` : undefined}
                      className={[
                        "activity-notes__result-item",
                        isExpanded || isEditing ? "activity-notes__result-item--active" : "",
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
              <EmptyState text="当前还没有记录，点“新建”开始记录。" compact />
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
            ? `AI 已从“${aiPreview.noteTitle}”里提炼出候选结果。你可以先勾选、修改，再确认写入当前 activity。`
            : undefined
        }
        widthClassName="max-w-3xl"
        bodyClassName="grid gap-4"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setAiPreview(null)} disabled={aiApplying}>
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={
                aiApplying ||
                aiSelectionSummary.selectedCount === 0 ||
                aiSelectionSummary.hasInvalidSelection
              }
              onClick={() => void handleConfirmAiRefine()}
            >
              {aiApplying
                ? "写入中..."
                : `确认并写入${
                    aiSelectionSummary.selectedCount > 0
                      ? `（${aiSelectionSummary.selectedCount}项）`
                      : ""
                  }`}
            </Button>
          </>
        }
      >
        {aiPreview ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-8)] border border-border bg-bg-subtle px-3 py-2">
              <p className="text-ui text-text-soft">
                已选择 <span className="font-medium text-text">{aiSelectionSummary.selectedCount}</span> /{" "}
                {aiSelectionSummary.totalCount} 项
              </p>
              {aiSelectionSummary.hasInvalidSelection ? (
                <p className="text-ui text-danger">选中的候选内容不能为空。</p>
              ) : (
                <p className="text-ui text-text-soft">未勾选的候选不会写入。</p>
              )}
            </div>

            <div
              className={[
                "grid gap-4",
                showConclusionSuggestions && showTodoSuggestions ? "md:grid-cols-2" : "",
              ].join(" ")}
            >
            {showConclusionSuggestions ? (
              <SurfaceCard subtle className="grid gap-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                    会议结论
                  </p>
                  <StatusBadge tone="neutral">
                    {aiSelectionSummary.selectedConclusions}/{aiPreview.conclusions.length} 已选
                  </StatusBadge>
                </div>
                {aiPreview.conclusions.length > 0 ? (
                  <ol className="grid gap-3">
                    {aiPreview.conclusions.map((suggestion, index) => (
                      <li
                        key={suggestion.suggestionId}
                        className="grid gap-3 rounded-[var(--radius-8)] border border-border bg-bg p-3"
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            aria-label={`选择结论 ${index + 1}`}
                            checked={suggestion.checked}
                            disabled={aiApplying}
                            onChange={() => toggleAiConclusion(suggestion.suggestionId)}
                          />
                          <div className="min-w-0 flex-1 grid gap-2">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-body font-medium text-text">结论 {index + 1}</p>
                              <span className="text-caption text-text-soft">
                                {suggestion.checked ? "已勾选" : "未勾选"}
                              </span>
                            </div>
                            <AiSuggestionInlineEditor
                              ariaLabel={`结论内容 ${index + 1}`}
                              value={suggestion.content}
                              disabled={aiApplying}
                              onChange={(nextValue) =>
                                updateAiConclusionField(
                                  suggestion.suggestionId,
                                  "content",
                                  nextValue,
                                )
                              }
                            />
                            <div className="flex justify-end">
                              <ProjectStarButton
                                active={suggestion.promotedToProject}
                                disabled={aiApplying}
                                onClick={() =>
                                  updateAiConclusionField(
                                    suggestion.suggestionId,
                                    "promotedToProject",
                                    !suggestion.promotedToProject,
                                  )
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState text="这次没有提炼出明确结论。" compact />
                )}
              </SurfaceCard>
            ) : null}

            {showTodoSuggestions ? (
              <SurfaceCard subtle className="grid gap-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                    待办事项
                  </p>
                  <StatusBadge tone="neutral">
                    {aiSelectionSummary.selectedTodos}/{aiPreview.todos.length} 已选
                  </StatusBadge>
                </div>
                {aiPreview.todos.length > 0 ? (
                  <ol className="grid gap-3">
                    {aiPreview.todos.map((suggestion, index) => (
                      <li
                        key={suggestion.suggestionId}
                        className="grid gap-3 rounded-[var(--radius-8)] border border-border bg-bg p-3"
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            aria-label={`选择待办 ${index + 1}`}
                            checked={suggestion.checked}
                            disabled={aiApplying}
                            onChange={() => toggleAiTodo(suggestion.suggestionId)}
                          />
                          <div className="min-w-0 flex-1 grid gap-2">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-body font-medium text-text">待办 {index + 1}</p>
                              <span className="text-caption text-text-soft">
                                {suggestion.checked ? "已勾选" : "未勾选"}
                              </span>
                            </div>
                            <AiSuggestionInlineEditor
                              ariaLabel={`待办内容 ${index + 1}`}
                              value={suggestion.content}
                              disabled={aiApplying}
                              onChange={(nextValue) =>
                                updateAiTodoField(
                                  suggestion.suggestionId,
                                  "content",
                                  nextValue,
                                )
                              }
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-ui text-text-soft">优先级</span>
                              <TodoPriorityDropdown
                                priority={suggestion.priority}
                                onSelect={(nextPriority) =>
                                  updateAiTodoField(
                                    suggestion.suggestionId,
                                    "priority",
                                    nextPriority,
                                  )
                                }
                              />
                              <span className="text-caption text-text-soft">
                                {suggestion.priority === suggestion.autoPriority
                                  ? "系统推荐"
                                  : `原推荐为 ${todoPriorityOptionLabel(suggestion.autoPriority)}`}
                              </span>
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState text="这次没有提炼出待办事项。" compact />
                )}
              </SurfaceCard>
            ) : null}
            </div>
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

function AiSuggestionInlineEditor({
  value,
  ariaLabel,
  disabled,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const initialValueRef = useRef(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [editing, value]);

  useEffect(() => {
    if (!editing || !textareaRef.current) {
      return;
    }

    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 96)}px`;
  }, [draft, editing]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={3}
        className="min-h-24 w-full resize-none overflow-hidden rounded-[var(--radius-6)] border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 text-body leading-6 text-text outline-none transition-[border-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)]"
        value={draft}
        autoFocus
        disabled={disabled}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraft(nextValue);
          onChange(nextValue);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(initialValueRef.current);
            onChange(initialValueRef.current);
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
      className="w-full rounded-[var(--radius-6)] bg-transparent px-0 py-0 text-left text-body leading-6 text-text transition-[background-color,color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] whitespace-pre-wrap break-words hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--color-text)_92%,var(--color-accent))] disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text"
      disabled={disabled}
      onClick={() => {
        initialValueRef.current = value;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value.trim() || "点击补充内容"}
    </button>
  );
}

function buildConclusionSuggestionDraft(suggestion: AiSuggestionRecord): AiConclusionDraft {
  return {
    suggestionId: suggestion.id,
    checked: true,
    content: readSuggestionPayloadString(suggestion.payload, "content") ?? suggestion.preview,
    promotedToProject: readSuggestionPayloadBoolean(suggestion.payload, "promotedToProject") ?? true,
  };
}

function buildTodoSuggestionDraft(suggestion: AiSuggestionRecord): AiTodoDraft {
  const content = readSuggestionPayloadString(suggestion.payload, "content") ?? suggestion.preview;
  const autoPriority = resolveSuggestedTodoPriority(
    content,
    readSuggestionPayloadString(suggestion.payload, "priority"),
  );

  return {
    suggestionId: suggestion.id,
    checked: true,
    content,
    priority: autoPriority,
    autoPriority,
  };
}

function readSuggestionPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSuggestionPayloadBoolean(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
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
  draftNote,
  notes,
  showDraft,
}: {
  draftNote: DraftNoteState | null;
  notes: NoteRecord[];
  showDraft: boolean;
}): RecordResultItem[] {
  const items: RecordResultItem[] = [];

  if (draftNote && showDraft) {
    items.push({
      value: `draft:${draftNote.localId}`,
      noteId: undefined,
      noteType: draftNote.noteType,
      summary: summarizeNoteContent({
        contentMarkdown: draftNote.contentMarkdown,
        contentHtml: draftNote.contentHtml,
      }),
      previewHtml: getRenderableNoteHtml({
        contentHtml: draftNote.contentHtml,
        contentMarkdown: draftNote.contentMarkdown,
      }),
      updatedAt: null,
      isDraft: true,
    });
  }

  for (const note of notes) {
    items.push({
      value: `note:${note.id}`,
      noteId: note.id,
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
  editorItem,
  activeNote,
  activityId,
  composer,
  draftNote,
  noteTemplateSettings,
  onUpsertNote,
  projectId,
  setEditorItem,
  setComposer,
  setDraftNote,
  value,
}: {
  editorItem: EditorItem;
  activeNote: NoteRecord | null;
  activityId: number;
  composer: ComposerState;
  draftNote: DraftNoteState | null;
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null;
  onUpsertNote: (input: NoteUpsertInput) => Promise<NoteRecord>;
  projectId: number;
  setEditorItem: Dispatch<SetStateAction<EditorItem>>;
  setComposer: Dispatch<SetStateAction<ComposerState | null>>;
  setDraftNote: Dispatch<SetStateAction<DraftNoteState | null>>;
  value: RichEditorValue;
}) {
  const normalizedValue = normalizeRichEditorValue(value);

  if (editorItem.kind === "draft") {
    const currentDraft = draftNote ?? createDraftNote(composer.noteType, noteTemplateSettings);
    const nextDraft = {
      ...currentDraft,
      noteType: composer.noteType,
      title: composer.title,
      contentMarkdown: normalizedValue.markdown,
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
      markdown: normalizedValue.markdown,
      html: normalizedValue.html,
    }).then((createdNote) => {
      setDraftNote(null);
      setEditorItem({ kind: "saved", noteId: createdNote.id });
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
    markdown: normalizedValue.markdown,
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
