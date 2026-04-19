import {
  ArrowLeft,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import {
  isAiCapabilityConfigured,
  visibleAiSuggestionTypes,
} from "../../lib/ai";
import { aiNoteSuggestionsJobTargetKey, isAiJobActive, useAiJobTarget } from "../../lib/aiJobs";
import {
  activityDraftNotePath,
  activityNotePath,
  activityPath,
  parseRouteId,
} from "../../lib/formatters";
import {
  fileTagColorValue,
} from "../../lib/constants";
import {
  noteTemplateColorKey,
  noteTemplateLabel,
  noteTemplatePlaceholder,
  resolveNoteDisplayTitle,
} from "../../lib/note-templates";
import { todoPriorityOptionLabel } from "../../lib/todo-priority";
import type {
  AcceptedSuggestionResult,
  AiAcceptSuggestionInput,
  AiSuggestionFeatureType,
  AiSuggestionRecord,
  DocumentRecord,
  FileTagColorKey,
  NoteRecord,
  RecordTypeSettingsSnapshot,
  TodoPriority,
} from "../../lib/types";
import { useActivityMutations } from "../../hooks/useActivityMutations";
import { useAiMutations } from "../../hooks/useAiMutations";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  Dialog,
  EmptyState,
  IconButton,
  ProjectStarButton,
  StatusBadge,
  SurfaceCard,
  TextField,
} from "../../ui/components";
import {
  RichEditor,
  RICH_EDITOR_FOCUS_REQUEST_EVENT,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import { TodoPriorityDropdown } from "../todo/TodoPriorityDropdown";
import {
  buildActivityNoteSessionFromNote,
  buildComposerFromDraft,
  buildComposerFromNote,
  buildConclusionSuggestionDraft,
  buildTodoSuggestionDraft,
  clearActivityNoteSession,
  createActivityNoteSessionSnapshot,
  createClosedActivityNoteSession,
  getActivityNoteSession,
  isInactiveActivityNoteSession,
  persistComposerNote,
  readSuggestedNoteTitle,
  resolveSuggestedTitleForComposer,
  sessionMatchesNoteFocusTarget,
  setActivityNoteSession,
  type AiConclusionDraft,
  type AiRefinePreview,
  type AiTodoDraft,
  type ComposerState,
  type DraftNoteState,
  type EditorItem,
  type NoteFocusTarget,
} from "./note-session";

export function ActivityNoteFocusPage() {
  const navigate = useNavigate();
  const params = useParams();
  const projectId = parseRouteId(params.projectId);
  const activityId = parseRouteId(params.activityId);
  const noteId = parseRouteId(params.noteId);
  const draftLocalId = params.draftLocalId?.trim() || null;
  const focusTarget = useMemo<NoteFocusTarget | null>(() => {
    if (noteId !== null) {
      return { kind: "saved", noteId };
    }

    if (draftLocalId) {
      return { kind: "draft", localId: draftLocalId };
    }

    return null;
  }, [draftLocalId, noteId]);
  const { pushToast } = useFeedbackStore();
  const openInternalReference = useInternalReferenceNavigation();
  const { noteMutation } = useActivityMutations();
  const { aiGenerateMutation, aiAcceptMutation } = useAiMutations();

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: projectId !== null,
  });
  const activitiesQuery = useQuery({
    queryKey: ["activities", projectId],
    queryFn: () => projectMindApi.activityList({ projectId: projectId as number }),
    enabled: projectId !== null && activityId !== null,
  });
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
  });
  const recordTypeSettingsQuery = useQuery({
    queryKey: ["record-type-settings"],
    queryFn: projectMindApi.recordTypeSettingsGet,
  });

  const project =
    projectId === null
      ? null
      : (projectsQuery.data ?? []).find((item) => item.id === projectId) ?? null;
  const activity =
    activityId === null
      ? null
      : (activitiesQuery.data ?? []).find((item) => item.id === activityId) ?? null;
  const recordTypeSettings = recordTypeSettingsQuery.data ?? null;
  const storedSession = activityId === null ? null : getActivityNoteSession(activityId);
  const routeSession = useMemo(() => {
    if (!focusTarget) {
      return null;
    }

    if (sessionMatchesNoteFocusTarget(storedSession, focusTarget)) {
      return storedSession;
    }

    if (focusTarget.kind === "saved" && activity) {
      const targetNote = activity.notes.find((item) => item.id === focusTarget.noteId);
      return targetNote
        ? buildActivityNoteSessionFromNote(targetNote, recordTypeSettings)
        : null;
    }

    return null;
  }, [activity, focusTarget, recordTypeSettings, storedSession]);

  const [draftNote, setDraftNote] = useState<DraftNoteState | null>(
    routeSession?.draftNote ?? null,
  );
  const [editorItem, setEditorItem] = useState<EditorItem>(
    routeSession?.editorItem ?? { kind: "closed" },
  );
  const [composer, setComposer] = useState<ComposerState | null>(
    routeSession?.composer ?? null,
  );
  const [titleDirty, setTitleDirty] = useState(routeSession?.titleDirty ?? false);
  const [editorPersistState, setEditorPersistState] =
    useState<RichEditorPersistState>(routeSession?.editorPersistState ?? "idle");
  const [aiPreview, setAiPreview] = useState<AiRefinePreview | null>(
    routeSession?.aiPreview ?? null,
  );
  const [aiPersisting, setAiPersisting] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiJobNoteId, setAiJobNoteId] = useState<number | null>(
    routeSession?.aiJobNoteId ?? null,
  );
  const hydratedRouteKeyRef = useRef<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  const sortedNotes = useMemo(
    () =>
      [...(activity?.notes ?? [])].sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
    [activity?.notes],
  );
  const activeNote =
    editorItem.kind === "saved"
      ? (sortedNotes.find((item) => item.id === editorItem.noteId) ?? null)
      : null;
  const aiJob = useAiJobTarget(
    aiJobNoteId !== null ? aiNoteSuggestionsJobTargetKey(aiJobNoteId) : "__idle__",
  );
  const aiJobActive = isAiJobActive(aiJob);

  const enabledSuggestionTypes = visibleAiSuggestionTypes(aiSettingsQuery.data);
  const aiReady = isAiCapabilityConfigured(
    aiSettingsQuery.data,
    "suggestion_generation",
  );
  const showAiRefine = enabledSuggestionTypes.length > 0;
  const suggestionTypeSet = useMemo(
    () => new Set<AiSuggestionFeatureType>(enabledSuggestionTypes),
    [enabledSuggestionTypes],
  );
  const showConclusionSuggestions = suggestionTypeSet.has("conclusion");
  const showTodoSuggestions = suggestionTypeSet.has("todo");

  useEffect(() => {
    const nextRouteKey =
      focusTarget?.kind === "saved"
        ? `saved:${focusTarget.noteId}`
        : focusTarget?.kind === "draft"
          ? `draft:${focusTarget.localId}`
          : null;

    if (!nextRouteKey || !routeSession || hydratedRouteKeyRef.current === nextRouteKey) {
      return;
    }

    hydratedRouteKeyRef.current = nextRouteKey;
    setDraftNote(routeSession.draftNote);
    setEditorItem(routeSession.editorItem);
    setComposer(routeSession.composer);
    setTitleDirty(routeSession.titleDirty);
    setEditorPersistState(routeSession.editorPersistState);
    setAiPreview(routeSession.aiPreview);
    setAiJobNoteId(routeSession.aiJobNoteId);
    setAiPersisting(false);
    setAiApplying(false);
  }, [focusTarget, routeSession]);

  useEffect(() => {
    if (!activityId) {
      return;
    }

    const snapshot = createActivityNoteSessionSnapshot({
      draftNote,
      editorItem,
      composer,
      titleDirty,
      editorPersistState,
      aiPreview,
      aiJobNoteId,
      expandedRecordValue:
        editorItem.kind === "draft"
          ? (draftNote ? `draft:${draftNote.localId}` : null)
          : editorItem.kind === "saved"
            ? `note:${editorItem.noteId}`
            : null,
      topRecordValue: null,
    });

    if (isInactiveActivityNoteSession(snapshot)) {
      clearActivityNoteSession(activityId);
      return;
    }

    setActivityNoteSession(activityId, snapshot);
  }, [
    activityId,
    aiJobNoteId,
    aiPreview,
    composer,
    draftNote,
    editorItem,
    editorPersistState,
    titleDirty,
  ]);

  useEffect(() => {
    if (!showAiRefine || enabledSuggestionTypes.length === 0) {
      setAiPreview(null);
      setAiJobNoteId(null);
    }
  }, [enabledSuggestionTypes.length, showAiRefine]);

  useEffect(() => {
    if (editorItem.kind === "saved") {
      if (!activeNote) {
        return;
      }

      if (composer === null || composer.noteId !== activeNote.id) {
        setComposer(buildComposerFromNote(activeNote, recordTypeSettings));
      }
      return;
    }

    if (editorItem.kind === "draft") {
      if (!draftNote) {
        return;
      }

      if (
        composer === null ||
        composer.noteId !== undefined ||
        composer.noteType !== draftNote.noteType
      ) {
        setComposer(buildComposerFromDraft(draftNote, recordTypeSettings));
      }
    }
  }, [activeNote, composer, draftNote, editorItem.kind, recordTypeSettings]);

  const handleEditorChange = useCallback((value: RichEditorValue) => {
    setComposer((current) =>
      current
        ? {
            ...current,
            contentMarkdown: value.markdown,
            contentHtml: value.html,
          }
        : current,
    );

    setDraftNote((current) =>
      current
        ? {
            ...current,
            contentMarkdown: value.markdown,
            contentHtml: value.html,
          }
        : current,
    );
  }, []);

  const handleTitleChange = useCallback((value: string) => {
    setTitleDirty(true);
    setComposer((current) =>
      current
        ? {
            ...current,
            title: value,
          }
        : current,
    );

    setDraftNote((current) =>
      current
        ? {
            ...current,
            title: value,
          }
        : current,
    );
  }, []);

  const importDocumentForEditor = useCallback(
    async (sourcePath: string) => {
      if (!activity) {
        throw new Error("当前活动尚未加载完成");
      }

      try {
        return await projectMindApi.documentImport({
          projectId: activity.projectId,
          activityId: activity.id,
          sourcePath,
          isStarred: true,
        });
      } catch (error) {
        pushToast({
          tone: "error",
          title: "导入文件失败",
          detail: String(error),
        });
        throw error;
      }
    },
    [activity, pushToast],
  );

  const importNoteImageForEditor = useCallback(
    async (sourcePath: string) => {
      if (!activity) {
        throw new Error("当前活动尚未加载完成");
      }

      try {
        return await projectMindApi.documentImportNoteImage({
          projectId: activity.projectId,
          activityId: activity.id,
          sourcePath,
        });
      } catch (error) {
        pushToast({
          tone: "error",
          title: "导入图片失败",
          detail: String(error),
        });
        throw error;
      }
    },
    [activity, pushToast],
  );

  const importClipboardImageForEditor = useCallback(
    async (file: File) => {
      if (!activity) {
        throw new Error("当前活动尚未加载完成");
      }

      try {
        return await projectMindApi.documentImportClipboardNoteImage({
          projectId: activity.projectId,
          activityId: activity.id,
          fileName: buildClipboardImageFileName(file),
          mimeType: file.type || "image/png",
          dataBase64: await fileToBase64(file),
        });
      } catch (error) {
        pushToast({
          tone: "error",
          title: "导入粘贴图片失败",
          detail: String(error),
        });
        throw error;
      }
    },
    [activity, pushToast],
  );

  const saveComposerNote = useCallback(
    async ({ value }: { value: RichEditorValue }) => {
      if (!composer || !activity || !projectId || !activityId) {
        return undefined;
      }

      const normalizedValue = {
        ...value,
        markdown: value.markdown || composer.contentMarkdown,
        html: value.html || composer.contentHtml,
        text: value.text || composer.contentMarkdown,
      };
      const resolvedTitle = resolveSuggestedTitleForComposer({
        composer: {
          ...composer,
          contentMarkdown: normalizedValue.markdown,
          contentHtml: normalizedValue.html,
        },
        recordTypeSettings,
      });
      let savedNote = await persistComposerNote({
        editorItem,
        activeNote,
        activityId,
        composer,
        draftNote,
        noteTemplateSettings: recordTypeSettings,
        onUpsertNote: (input) => noteMutation.mutateAsync(input),
        projectId,
        resolvedTitle,
        setEditorItem: (value) => setEditorItem(value),
        setComposer: (value) => setComposer(value),
        setDraftNote: (value) => setDraftNote(value),
        value: normalizedValue,
      });

      if (!savedNote) {
        return undefined;
      }

      if (
        !composer.title.trim() &&
        aiReady &&
        normalizedValue.markdown.trim().length > 0
      ) {
        try {
          const suggestions = await aiGenerateMutation.mutateAsync({
            projectId: activity.projectId,
            activityId: activity.id,
            noteId: savedNote.id,
          });
          const suggestedTitle = readSuggestedNoteTitle(suggestions, savedNote.id);

          if (suggestedTitle && suggestedTitle !== savedNote.title?.trim()) {
            savedNote = await noteMutation.mutateAsync({
              projectId: activity.projectId,
              activityId: activity.id,
              noteId: savedNote.id,
              noteType: savedNote.noteType,
              title: suggestedTitle,
              markdown: normalizedValue.markdown,
              html: normalizedValue.html,
            });
            setComposer(buildComposerFromNote(savedNote, recordTypeSettings));
          }
        } catch {
          // Ignore title suggestion failures.
        }
      }

      if (focusTarget?.kind === "draft" || editorItem.kind === "draft") {
        navigate(activityNotePath(activity.projectId, activity.id, savedNote.id), {
          replace: true,
        });
      }

      setTitleDirty(false);
      return savedNote;
    },
    [
      activeNote,
      activity,
      activityId,
      aiGenerateMutation,
      aiReady,
      composer,
      draftNote,
      editorItem,
      focusTarget?.kind,
      navigate,
      noteMutation,
      projectId,
      recordTypeSettings,
    ],
  );

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      return saveComposerNote({ value });
    },
    [saveComposerNote],
  );

  const focusComposerBody = useCallback(() => {
    const proseMirrorTarget =
      editorContainerRef.current?.querySelector<HTMLElement>(".ProseMirror") ??
      null;

    if (proseMirrorTarget) {
      proseMirrorTarget.dispatchEvent(
        new Event(RICH_EDITOR_FOCUS_REQUEST_EVENT),
      );
      proseMirrorTarget.focus();
      return;
    }

    const mockEditorTarget =
      editorContainerRef.current?.querySelector<HTMLElement>(
        "[aria-label='记录编辑器']",
      ) ?? null;

    mockEditorTarget?.focus();
  }, []);

  const handleAiRefine = useCallback(async () => {
    if (
      !activity ||
      !composer ||
      editorItem.kind === "closed" ||
      !showAiRefine ||
      !aiReady ||
      aiPersisting ||
      aiJobActive ||
      aiApplying ||
      !composer.contentMarkdown.trim().length
    ) {
      return;
    }

    setAiPersisting(true);

    try {
      const savedNote = await saveComposerNote({
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
      const suggestions = await aiGenerateMutation.mutateAsync({
        projectId: activity.projectId,
        activityId: activity.id,
        noteId: savedNote.id,
      });
      const currentNoteSuggestions = suggestions.filter(
        (suggestion) =>
          suggestion.status === "pending" && suggestion.noteId === savedNote.id,
      );

      setAiPreview({
        noteTitle: resolveNoteDisplayTitle(
          savedNote,
          savedNote.noteType,
          recordTypeSettings,
        ),
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
    activity,
    aiApplying,
    aiGenerateMutation,
    aiJobActive,
    aiPersisting,
    aiReady,
    composer,
    editorItem.kind,
    recordTypeSettings,
    saveComposerNote,
    showAiRefine,
    showConclusionSuggestions,
    showTodoSuggestions,
  ]);

  const handleConfirmAiRefine = useCallback(async () => {
    if (!aiPreview || aiApplying) {
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
        await aiAcceptMutation.mutateAsync({
          suggestionId: suggestion.suggestionId,
          payloadOverride: {
            content: suggestion.content.trim(),
            promotedToProject: suggestion.promotedToProject,
          },
        } satisfies AiAcceptSuggestionInput);
      }

      for (const suggestion of selectedTodos) {
        await aiAcceptMutation.mutateAsync({
          suggestionId: suggestion.suggestionId,
          payloadOverride: {
            content: suggestion.content.trim(),
            priority: suggestion.priority,
          },
        } satisfies AiAcceptSuggestionInput);
      }

      setAiPreview(null);
    } finally {
      setAiApplying(false);
    }
  }, [aiAcceptMutation, aiApplying, aiPreview]);

  const handleBackToActivity = useCallback(async () => {
    if (!activity || !project) {
      return;
    }

    if (
      composer &&
      (titleDirty || editorPersistState === "dirty" || editorPersistState === "saving")
    ) {
      try {
        await handleSave({
          html: composer.contentHtml,
          text: composer.contentMarkdown,
          markdown: composer.contentMarkdown,
        });
      } catch {
        return;
      }
    }

    navigate(activityPath(project.id, activity.id));
  }, [
    activity,
    composer,
    editorPersistState,
    handleSave,
    navigate,
    project,
    titleDirty,
  ]);

  const pageStatusLabel = useMemo(() => {
    if (noteMutation.isPending || editorPersistState === "saving") {
      return "保存中...";
    }
    if (editorPersistState === "error") {
      return "保存失败";
    }
    if (titleDirty || editorPersistState === "dirty") {
      return "未保存更改";
    }
    return "已保存";
  }, [editorPersistState, noteMutation.isPending, titleDirty]);

  const aiActionDisabled =
    editorItem.kind === "closed" ||
    !showAiRefine ||
    !aiReady ||
    enabledSuggestionTypes.length === 0 ||
    !composer?.contentMarkdown.trim().length ||
    noteMutation.isPending ||
    aiPersisting ||
    aiJobActive ||
    aiApplying;
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
    const selectedCount = [...conclusions, ...todos].filter((item) => item.checked)
      .length;
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
    (updater: (current: AiRefinePreview) => AiRefinePreview) => {
      setAiPreview((current) => (current ? updater(current) : current));
    },
    [],
  );

  const noteLabel =
    composer
      ? noteTemplateLabel(composer.noteType, recordTypeSettings)
      : activeNote
        ? noteTemplateLabel(activeNote.noteType, recordTypeSettings)
        : "记录";
  const noteColorKey =
    composer
      ? noteTemplateColorKey(composer.noteType, recordTypeSettings)
      : activeNote
        ? noteTemplateColorKey(activeNote.noteType, recordTypeSettings)
        : "slate";

  if (projectId === null || activityId === null || !focusTarget) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-body text-text-soft">
        无效的记录专注页地址。
      </div>
    );
  }

  if (projectsQuery.isLoading || activitiesQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在打开记录专注页...
      </div>
    );
  }

  if (!project || !activity || !composer) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-center px-6 py-10">
        <SurfaceCard className="grid w-full max-w-xl gap-4 p-6">
          <EmptyState
            title="没有找到这个记录"
            text="如果这是一个草稿，请从 Activity 页面重新进入专注编辑。"
          />
          <div className="flex justify-center">
            <Button type="button" variant="secondary" onClick={() => navigate(activityPath(projectId, activityId))}>
              返回 Activity
            </Button>
          </div>
        </SurfaceCard>
      </div>
    );
  }

  const breadcrumbNoteTitle = resolveNoteDisplayTitle(
    {
      title: composer.title,
      contentHtml: composer.contentHtml,
      contentMarkdown: composer.contentMarkdown,
    },
    composer.noteType,
    recordTypeSettings,
  );

  return (
    <>
      <div
        className="activity-note-focus"
        data-testid="activity-note-focus-page"
      >
        <header
          className="activity-note-focus__chrome"
          data-testid="activity-note-focus-chrome"
        >
          <div className="activity-note-focus__chrome-inner">
            <div className="activity-note-focus__meta">
              <div
                className="activity-note-focus__breadcrumbs"
                data-testid="activity-note-focus-breadcrumbs"
              >
                <span>{project.name}</span>
                <span>/</span>
                <span>{activity.title}</span>
                <span>/</span>
                <span>{breadcrumbNoteTitle}</span>
              </div>
            </div>
            <div className="activity-note-focus__header-actions">
              <RecordTypeBadge label={noteLabel} colorKey={noteColorKey} />
              <span
                className="activity-note-focus__status"
                data-testid="activity-note-focus-status"
              >
                {pageStatusLabel}
              </span>
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                aria-label="返回 Activity"
                title="返回 Activity"
                onClick={() => {
                  void handleBackToActivity();
                }}
              >
                <ArrowLeft size={14} />
              </IconButton>
              {showAiRefine ? (
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
                  onClick={() => {
                    void handleAiRefine();
                  }}
                >
                  {aiActionLabel}
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <div
          className="activity-note-focus__scroll"
          data-testid="activity-note-focus-scroll"
        >
          <section
            className="activity-note-focus__page"
            data-testid="activity-note-focus-page-body"
          >
            <input
              className="activity-note-focus__title"
              aria-label="记录标题"
              data-testid="activity-note-focus-title"
              value={composer.title}
              placeholder="输入记录标题"
              onChange={(event) => handleTitleChange(event.target.value)}
              onKeyDown={(event) => {
                const isPlainJumpKey =
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey &&
                  (event.key === "Enter" || event.key === "Tab");

                if (isPlainJumpKey) {
                  event.preventDefault();
                  focusComposerBody();
                  return;
                }

                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSave({
                    html: composer.contentHtml,
                    text: composer.contentMarkdown,
                    markdown: composer.contentMarkdown,
                  });
                }
              }}
            />

            <div className="activity-note-focus__editor" ref={editorContainerRef}>
              <RichEditor
                html={composer.contentHtml}
                variant="page"
                autoFocus
                autosave={{
                  onChange: false,
                  onBlur: true,
                  onWindowBlur: true,
                  onVisibilityChange: true,
                }}
                placeholder={noteTemplatePlaceholder(
                  composer.noteType,
                  recordTypeSettings,
                )}
                internalReferences={{
                  context: { scope: "project", projectId: projectId as number },
                  onOpenReference: openInternalReference,
                }}
                onChange={handleEditorChange}
                onPersistStateChange={setEditorPersistState}
                onModEnter={() =>
                  handleSave({
                    html: composer.contentHtml,
                    text: composer.contentMarkdown,
                    markdown: composer.contentMarkdown,
                  })
                }
                onSave={handleSave}
                assetHandlers={{
                  insertImage: async (sourcePath) => {
                    const doc = await importNoteImageForEditor(sourcePath);
                    return {
                      kind: "image" as const,
                      title: doc.name,
                      path: doc.managedPath,
                      mimeType: doc.mimeType,
                      documentId: doc.id,
                    };
                  },
                  insertPastedImage: async (file) => {
                    const doc = await importClipboardImageForEditor(file);
                    return {
                      kind: "image" as const,
                      title: doc.name,
                      path: doc.managedPath,
                      mimeType: doc.mimeType,
                      documentId: doc.id,
                    };
                  },
                  insertFile: async (sourcePath) => {
                    const doc = await importDocumentForEditor(sourcePath);
                    return {
                      kind: "file" as const,
                      title: doc.name,
                      path: doc.managedPath,
                      href: `file://${doc.managedPath}`,
                      mimeType: doc.mimeType,
                      documentId: doc.id,
                      meta: doc.mimeType,
                    };
                  },
                }}
                onOpenAsset={(asset) =>
                  asset.path ? desktopApi.revealPath(asset.path) : undefined
                }
              />
            </div>
          </section>
        </div>
      </div>

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
              onClick={() => {
                void handleConfirmAiRefine();
              }}
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
                已选择{" "}
                <span className="font-medium text-text">
                  {aiSelectionSummary.selectedCount}
                </span>{" "}
                / {aiSelectionSummary.totalCount} 项
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
                showConclusionSuggestions && showTodoSuggestions
                  ? "md:grid-cols-2"
                  : "",
              ].join(" ")}
            >
              {showConclusionSuggestions ? (
                <SurfaceCard subtle className="grid gap-3 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                      会议结论
                    </p>
                    <StatusBadge tone="neutral">
                      {aiSelectionSummary.selectedConclusions}/
                      {aiPreview.conclusions.length} 已选
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
                              onChange={() =>
                                updateAiPreview((current) => ({
                                  ...current,
                                  conclusions: current.conclusions.map((item) =>
                                    item.suggestionId === suggestion.suggestionId
                                      ? { ...item, checked: !item.checked }
                                      : item,
                                  ),
                                }))
                              }
                            />
                            <div className="min-w-0 flex-1 grid gap-2">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-body font-medium text-text">
                                  结论 {index + 1}
                                </p>
                                <span className="text-caption text-text-soft">
                                  {suggestion.checked ? "已勾选" : "未勾选"}
                                </span>
                              </div>
                              <AiSuggestionInlineEditor
                                ariaLabel={`结论内容 ${index + 1}`}
                                value={suggestion.content}
                                disabled={aiApplying}
                                onChange={(nextValue) =>
                                  updateAiPreview((current) => ({
                                    ...current,
                                    conclusions: current.conclusions.map((item) =>
                                      item.suggestionId === suggestion.suggestionId
                                        ? { ...item, content: nextValue }
                                        : item,
                                    ),
                                  }))
                                }
                              />
                              <div className="flex justify-end">
                                <ProjectStarButton
                                  active={suggestion.promotedToProject}
                                  disabled={aiApplying}
                                  onClick={() =>
                                    updateAiPreview((current) => ({
                                      ...current,
                                      conclusions: current.conclusions.map((item) =>
                                        item.suggestionId === suggestion.suggestionId
                                          ? {
                                              ...item,
                                              promotedToProject: !item.promotedToProject,
                                            }
                                          : item,
                                      ),
                                    }))
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
                      {aiSelectionSummary.selectedTodos}/
                      {aiPreview.todos.length} 已选
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
                              onChange={() =>
                                updateAiPreview((current) => ({
                                  ...current,
                                  todos: current.todos.map((item) =>
                                    item.suggestionId === suggestion.suggestionId
                                      ? { ...item, checked: !item.checked }
                                      : item,
                                  ),
                                }))
                              }
                            />
                            <div className="min-w-0 flex-1 grid gap-2">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-body font-medium text-text">
                                  待办 {index + 1}
                                </p>
                                <span className="text-caption text-text-soft">
                                  {suggestion.checked ? "已勾选" : "未勾选"}
                                </span>
                              </div>
                              <AiSuggestionInlineEditor
                                ariaLabel={`待办内容 ${index + 1}`}
                                value={suggestion.content}
                                disabled={aiApplying}
                                onChange={(nextValue) =>
                                  updateAiPreview((current) => ({
                                    ...current,
                                    todos: current.todos.map((item) =>
                                      item.suggestionId === suggestion.suggestionId
                                        ? { ...item, content: nextValue }
                                        : item,
                                    ),
                                  }))
                                }
                              />
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-ui text-text-soft">优先级</span>
                                <TodoPriorityDropdown
                                  priority={suggestion.priority}
                                  onSelect={(nextPriority) =>
                                    updateAiPreview((current) => ({
                                      ...current,
                                      todos: current.todos.map((item) =>
                                        item.suggestionId === suggestion.suggestionId
                                          ? { ...item, priority: nextPriority }
                                          : item,
                                      ),
                                    }))
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
  colorKey: FileTagColorKey;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-4)] px-2 py-1 text-caption font-medium tracking-[0.08em] text-text"
      style={{
        backgroundColor: `color-mix(in srgb, ${fileTagColorValue(colorKey)} 14%, var(--color-bg))`,
        color: fileTagColorValue(colorKey),
      }}
    >
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

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [editing, value]);

  if (editing) {
    return (
      <TextField
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraft(nextValue);
          onChange(nextValue);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(initialValueRef.current);
            onChange(initialValueRef.current);
            setEditing(false);
            event.currentTarget.blur();
          }

          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
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
      className="w-full rounded-[var(--radius-6)] bg-transparent px-0 py-0 text-left text-body leading-6 text-text transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)] whitespace-pre-wrap break-words hover:bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--color-text)_92%,var(--color-accent))]"
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

async function fileToBase64(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function buildClipboardImageFileName(file: File) {
  const extension = resolveFileExtension(file);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

  return `clipboard-image-${timestamp}.${extension}`;
}

function resolveFileExtension(file: File) {
  const fileName = file.name?.trim();

  if (fileName && fileName.includes(".")) {
    const explicitExtension = fileName.split(".").pop()?.trim().toLowerCase();

    if (explicitExtension) {
      return explicitExtension;
    }
  }

  const mimeType = file.type?.trim().toLowerCase();

  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/svg+xml":
      return "svg";
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}
