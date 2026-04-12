import {
  type FocusEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  FileText,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Star,
  Trash2,
} from "lucide-react";

import type {
  ActivityCardData,
  ConclusionRecord,
  DocumentRecord,
} from "../../lib/types";
import {
  isAiCapabilityConfigured,
  isAiFeatureReady,
  isAiFeatureVisible,
  visibleAiSuggestionTypes,
} from "../../lib/ai";
import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import { activityAttributeLabel } from "../../lib/constants";
import {
  activityPath,
  formatDateTime,
  parseRouteId,
  projectPath,
} from "../../lib/formatters";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { useActivityMutations } from "../../hooks/useActivityMutations";
import { useAiMutations } from "../../hooks/useAiMutations";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useExclusiveActivation } from "../../hooks/useExclusiveActivation";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import {
  EMPTY_RICH_EDITOR_HTML,
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorValue,
} from "../rich-editor";
import { ManagedDocumentSection } from "../document/ManagedDocumentSection";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import {
  ActionContextMenu,
  Button,
  EmptyState,
  SectionHeader,
  TextField,
} from "../../ui/components";
import { TodoRail } from "../todo";
import { ActivityTagDropdown } from "./ActivityTagDropdown";
import { ActivityNotesPanel } from "./ActivityNotesPanel";
import { AiArtifactCard } from "../ai/AiArtifactCard";

export function ActivityPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const projectId = parseRouteId(params.projectId);
  const activityId = parseRouteId(params.activityId);
  const focusId = searchParams.get("focus");

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });

  const activeProject = useMemo(
    () =>
      (projectsQuery.data ?? []).find((project) => project.id === projectId) ??
      null,
    [projectId, projectsQuery.data],
  );

  const activitiesQuery = useQuery({
    queryKey: ["activities", projectId],
    queryFn: () =>
      projectMindApi.activityList({ projectId: projectId as number }),
    enabled: projectId !== null && activityId !== null,
  });
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
  });
  const activitySettingsQuery = useQuery({
    queryKey: ["activity-settings"],
    queryFn: projectMindApi.activitySettingsGet,
  });
  const recordTypeSettingsQuery = useQuery({
    queryKey: ["record-type-settings"],
    queryFn: projectMindApi.recordTypeSettingsGet,
  });

  const activity = useMemo(() => {
    if (!activityId) return null;
    const found = (activitiesQuery.data ?? []).find(
      (item) => item.id === activityId,
    );
    return found ? { ...found, isExpanded: true } : null;
  }, [activitiesQuery.data, activityId]);
  const {
    activityMetaMutation,
    noteMutation,
    noteDeleteMutation,
    conclusionMutation,
    conclusionUpdateMutation,
    conclusionDeleteMutation,
  } = useActivityMutations();
  const {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoDeleteMutation,
  } = useTodoMutations(activity?.todos);
  const { aiGenerateMutation, aiAcceptMutation } = useAiMutations();
  const { openSettings } = useUiStore();
  const { pushToast } = useFeedbackStore();

  useFocusTarget(focusId, [activity]);

  const [conclusionDraft, setConclusionDraft] = useState<RichEditorValue>(
    emptyRichEditorValue(),
  );
  const [pendingConclusionFocusPoint, setPendingConclusionFocusPoint] =
    useState<{
      key: string;
      point: { x: number; y: number };
    } | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [conclusionContextMenu, setConclusionContextMenu] = useState<{
    conclusionId: number;
    x: number;
    y: number;
  } | null>(null);
  const [pageDragActive, setPageDragActive] = useState(false);
  const [activitySummaryExpanded, setActivitySummaryExpanded] = useState(false);
  const titleSkipBlurRef = useRef(false);
  const autoEditTitleActivityIdRef = useRef<number | null>(null);
  const {
    activeKey: activeConclusionKey,
    clearActive: clearActiveConclusion,
    register: registerConclusionActivation,
    requestActivation: requestConclusionActivation,
  } = useExclusiveActivation<string>();
  const activitySummarySectionRef = useDismissOnOutside<HTMLElement>({
    enabled: activitySummaryExpanded,
    onDismiss: () => setActivitySummaryExpanded(false),
  });
  const {
    fileTags,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag,
    closeImportTagDialog,
    confirmImportTagDialog,
    manageImportTags,
  } = useDocumentImportFlow({
    projectId: activity?.projectId ?? null,
    activityId: activity?.id ?? null,
    onDocumentsImported: (documents) => {
      documents.forEach((document) =>
        appendDocumentToActivityCache(queryClient, document),
      );
    },
  });
  const handleWindowDrop = useCallback(
    async (paths: string[]) => {
      if (!activity) {
        return;
      }

      await requestImportPaths(paths);
    },
    [activity, requestImportPaths],
  );
  const { nativeWindowFileDrop } = useWindowFileDrop({
    enabled: Boolean(activity),
    onDrop: handleWindowDrop,
    onHoverChange: setPageDragActive,
  });

  const visibleSuggestionTypes = visibleAiSuggestionTypes(aiSettingsQuery.data);
  const suggestionGenerationReady = isAiCapabilityConfigured(
    aiSettingsQuery.data,
    "suggestion_generation",
  );
  const showAiRefine = visibleSuggestionTypes.length > 0;
  const showActivitySummary = isAiFeatureVisible(
    aiSettingsQuery.data,
    "summary.activity_summary",
  );
  const summaryReady = isAiFeatureReady(
    aiSettingsQuery.data,
    "summary.activity_summary",
  );
  const isConclusionComposerActive =
    activeConclusionKey === CONCLUSION_COMPOSER_KEY;
  const activityNameById = useMemo(
    () =>
      activity
        ? new Map([[activity.id, activity.title]])
        : new Map<number, string>(),
    [activity],
  );
  const activityUnfinishedTodos = useMemo(
    () => activity?.todos.filter((todo) => todo.status !== "finished") ?? [],
    [activity?.todos],
  );
  const activityFinishedTodos = useMemo(
    () => activity?.todos.filter((todo) => todo.status === "finished") ?? [],
    [activity?.todos],
  );
  const contextMenuConclusion = useMemo(
    () =>
      conclusionContextMenu && activity
        ? (activity.conclusions.find(
            (item) => item.id === conclusionContextMenu.conclusionId,
          ) ?? null)
        : null,
    [activity, conclusionContextMenu],
  );

  useEffect(() => {
    if (conclusionContextMenu && !contextMenuConclusion) {
      setConclusionContextMenu(null);
    }
  }, [conclusionContextMenu, contextMenuConclusion]);

  useEffect(() => {
    if (activeConclusionKey === null) {
      setPendingConclusionFocusPoint(null);
    }
  }, [activeConclusionKey]);

  useEffect(() => {
    setConclusionDraft(emptyRichEditorValue());
    setPendingConclusionFocusPoint(null);
    clearActiveConclusion();
  }, [activity?.id, clearActiveConclusion]);

  useEffect(() => {
    setActivitySummaryExpanded(false);
  }, [activity?.id]);

  useEffect(() => {
    if (!activity) {
      setTitleDraft("");
      setTitleEditing(false);
      return;
    }

    setTitleDraft(activity.title);

    if (
      focusId === "activity-title" &&
      autoEditTitleActivityIdRef.current !== activity.id
    ) {
      autoEditTitleActivityIdRef.current = activity.id;
      setTitleEditing(true);
      return;
    }

    setTitleEditing(false);
  }, [activity?.id, activity?.title, focusId]);

  const importDocumentForEditor = useCallback(
    async (sourcePath: string) => {
      if (!activity) {
        throw new Error("当前活动尚未加载完成");
      }

      try {
        const document = await projectMindApi.documentImport({
          projectId: activity.projectId,
          activityId: activity.id,
          sourcePath,
          isStarred: false,
        });

        appendDocumentToActivityCache(queryClient, document);
        void queryClient.invalidateQueries({
          queryKey: ["overview", document.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["dashboard", document.projectId],
        });
        void queryClient.invalidateQueries({ queryKey: ["ai-artifact"] });

        return document;
      } catch (error) {
        pushToast({
          tone: "error",
          title: "导入文件失败",
          detail: String(error),
        });
        throw error;
      }
    },
    [activity, pushToast, queryClient],
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

  const handleOpenActivityDocumentPicker = useCallback(async () => {
    if (!activeProject || !activity) {
      return;
    }

    const sourcePaths = await desktopApi.pickFiles({
      title: `选择文件 · ${activeProject.rootPath}`,
    });
    if (sourcePaths.length === 0) {
      return;
    }

    await requestImportPaths(sourcePaths);
  }, [activeProject, activity, requestImportPaths]);

  const generateAiSuggestionsForNote = useCallback(
    async (noteId: number) => {
      if (!activity) {
        throw new Error("当前活动尚未加载完成");
      }

      return aiGenerateMutation.mutateAsync({
        projectId: activity.projectId,
        activityId: activity.id,
        noteId,
      });
    },
    [activity, aiGenerateMutation],
  );

  const acceptAiSuggestion = useCallback(
    async (input: Parameters<typeof aiAcceptMutation.mutateAsync>[0]) =>
      aiAcceptMutation.mutateAsync(input),
    [aiAcceptMutation],
  );

  const resetConclusionComposerDraft = useCallback(() => {
    setConclusionDraft(emptyRichEditorValue());
  }, []);

  const closeConclusionComposer = useCallback(() => {
    resetConclusionComposerDraft();
    setPendingConclusionFocusPoint(null);
    clearActiveConclusion(CONCLUSION_COMPOSER_KEY);
  }, [clearActiveConclusion, resetConclusionComposerDraft]);

  const commitOrCloseConclusionComposer = useCallback(async () => {
    if (!activity || conclusionMutation.isPending) {
      return false;
    }

    const normalizedDraft = normalizeRichEditorValue(conclusionDraft);
    if (!normalizedDraft.markdown) {
      closeConclusionComposer();
      return true;
    }

    try {
      await conclusionMutation.mutateAsync({
        projectId: activity.projectId,
        activityId: activity.id,
        markdown: normalizedDraft.markdown,
        html: normalizedDraft.html,
        promotedToProject: false,
      });

      closeConclusionComposer();
      return true;
    } catch {
      return false;
    }
  }, [activity, closeConclusionComposer, conclusionDraft, conclusionMutation]);

  useEffect(() => {
    if (!isConclusionComposerActive) {
      return;
    }

    return registerConclusionActivation(
      CONCLUSION_COMPOSER_KEY,
      commitOrCloseConclusionComposer,
    );
  }, [
    commitOrCloseConclusionComposer,
    isConclusionComposerActive,
    registerConclusionActivation,
  ]);

  const handlePageDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setPageDragActive(false);

      if (!activity) {
        return;
      }

      await requestImportPaths(extractDroppedFilePaths(event.dataTransfer));
    },
    [activity, requestImportPaths],
  );

  const handleSaveActivityTitle = useCallback(() => {
    if (!activity) {
      return;
    }

    const nextTitle = titleDraft.trim();
    const currentTitle = activity.title.trim();
    if (nextTitle === currentTitle) {
      setTitleDraft(activity.title);
      setTitleEditing(false);
      return;
    }

    activityMetaMutation.mutate({
      activityId: activity.id,
      title: nextTitle,
    });
    setTitleDraft(nextTitle);
    setTitleEditing(false);
  }, [activity, activityMetaMutation, titleDraft]);

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
      </div>
    );
  }

  if (activitiesQuery.isLoading) {
    return (
      <div className="flex h-full min-h-0 overflow-hidden bg-bg">
        <section className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-bg">
          <div className="flex items-center gap-2 text-body text-text-soft">
            <LoaderCircle className="spin" size={16} />
            正在加载 activity...
          </div>
        </section>
        <TodoRail
          title="Activity 待办"
          scopeLabel={activeProject.name}
          unfinishedTodos={[]}
          finishedTodos={[]}
          activityNameById={new Map<number, string>()}
          createPlaceholder="写下一条来自当前 activity 的 Todo"
          onCreateTodo={() => undefined}
          onToggleStatus={() => undefined}
          onUpdatePriority={() => undefined}
          onUpdateContent={() => undefined}
          onAddProgress={() => undefined}
          onDeleteTodo={() => undefined}
          onOpenTodoSource={() => undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-bg">
      <section
        data-testid="activity-page-dropzone"
        className={[
          "min-h-0 flex-1 overflow-y-auto bg-bg transition-[background-color] duration-[160ms] ease-[var(--ease-soft)]",
          pageDragActive
            ? "bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg))]"
            : "",
        ].join(" ")}
        onDragOver={(event) => {
          if (nativeWindowFileDrop) {
            return;
          }
          event.preventDefault();
          if (activity) {
            setPageDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (nativeWindowFileDrop) {
            return;
          }
          event.preventDefault();
          if (
            event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            return;
          }
          setPageDragActive(false);
        }}
        onDrop={nativeWindowFileDrop ? undefined : handlePageDrop}
      >
        {!activity ? (
          <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-center px-6 py-8">
            <EmptyState
              text="没有找到这个 activity。"
              className="w-full max-w-xl"
            />
          </div>
        ) : (
          <div className="activity-page__content-shell mx-auto flex w-full max-w-6xl flex-col px-6 py-6">
            <div className="activity-page__layout">
              <section className="activity-page__notes-column grid min-w-0 gap-6">
                <section
                  ref={activitySummarySectionRef}
                  className="grid gap-4 border-b border-border pb-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                    <div className="min-w-0">
                      <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                        {activeProject.name}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
                        <ActivityTagDropdown
                          label={activityAttributeLabel(
                            activity.attributeLabel,
                          )}
                          colorKey={activity.attributeColorKey ?? null}
                          busy={activityMetaMutation.isPending}
                          selectedOptionId={activity.attributeOptionId ?? null}
                          options={
                            activitySettingsQuery.data?.activityAttributeOptions.map(
                              (option) => ({
                                id: option.id,
                                label: option.label,
                                colorKey: option.colorKey,
                              }),
                            ) ?? []
                          }
                          clearLabel="不设置属性"
                          emptyText="还没有活动属性"
                          manageLabel="管理活动属性"
                          onSelect={(optionId) =>
                            activityMetaMutation.mutate({
                              activityId: activity.id,
                              attributeOptionId: optionId,
                            })
                          }
                          onClear={() =>
                            activityMetaMutation.mutate({
                              activityId: activity.id,
                              clearAttributeOption: true,
                            })
                          }
                          onManage={() => openSettings("activity")}
                        />
                        <h1 className="text-headline font-medium tracking-tight text-text">
                          {titleEditing ? (
                            <TextField
                              aria-label="Activity 名称"
                              value={titleDraft}
                              autoFocus
                              className="h-11 min-w-[16rem] max-w-[34rem] rounded-[var(--radius-8)] border-border-strong bg-bg px-3 text-headline font-medium tracking-tight"
                              placeholder="填写 Activity 名称"
                              onFocus={(event) => event.currentTarget.select()}
                              onChange={(event) =>
                                setTitleDraft(event.target.value)
                              }
                              onBlur={() => {
                                if (titleSkipBlurRef.current) {
                                  titleSkipBlurRef.current = false;
                                  return;
                                }
                                handleSaveActivityTitle();
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.currentTarget.blur();
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  titleSkipBlurRef.current = true;
                                  setTitleDraft(activity.title);
                                  setTitleEditing(false);
                                  event.currentTarget.blur();
                                }
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="rounded-[var(--radius-8)] bg-transparent px-2 py-1 text-left text-headline font-medium tracking-tight text-text transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:bg-bg-hover"
                              onClick={() => setTitleEditing(true)}
                            >
                              {activity.title || "Untitled Activity"}
                            </button>
                          )}
                        </h1>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
                        <ActivityTagDropdown
                          label={activity.statusLabel}
                          colorKey={activity.statusColorKey}
                          busy={activityMetaMutation.isPending}
                          selectedOptionId={activity.statusOptionId}
                          options={
                            activitySettingsQuery.data?.activityStatusOptions.map(
                              (option) => ({
                                id: option.id,
                                label: option.label,
                                colorKey: option.colorKey,
                              }),
                            ) ?? []
                          }
                          emptyText="还没有活动状态"
                          manageLabel="管理活动状态"
                          onSelect={(optionId) =>
                            activityMetaMutation.mutate({
                              activityId: activity.id,
                              statusOptionId: optionId,
                            })
                          }
                          onManage={() => openSettings("activity")}
                        />
                        <span className="text-ui text-text-soft">
                          <span
                            className="inline-flex items-center gap-1 opacity-75"
                            aria-label={`文件 ${activity.documents.length}`}
                            title={`文件 ${activity.documents.length}`}
                          >
                            <FileText size={13} aria-hidden="true" />
                            <span>{activity.documents.length}</span>
                          </span>
                        </span>
                        <span className="text-ui text-text-soft">
                          <span
                            className="inline-flex items-center gap-1 opacity-75"
                            aria-label={`结论 ${activity.conclusions.length}`}
                            title={`结论 ${activity.conclusions.length}`}
                          >
                            <Lightbulb size={13} aria-hidden="true" />
                            <span>{activity.conclusions.length}</span>
                          </span>
                        </span>
                        <span className="text-ui text-text-soft">
                          <span
                            className="inline-flex items-center gap-1 opacity-75"
                            aria-label={`Todo ${activity.digest.completedTodoCount}/${activity.digest.totalTodoCount}`}
                            title={`Todo ${activity.digest.completedTodoCount}/${activity.digest.totalTodoCount}`}
                          >
                            <ListTodo size={13} aria-hidden="true" />
                            <span>
                              {activity.digest.completedTodoCount}/{activity.digest.totalTodoCount}
                            </span>
                          </span>
                        </span>
                        <span className="text-ui text-text-soft opacity-75">
                          {formatDateTime(activity.activityTime)}
                        </span>
                      </div>
                    </div>

                    {showActivitySummary ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          activitySummaryExpanded ? "subtle" : "secondary"
                        }
                        aria-expanded={activitySummaryExpanded}
                        onClick={() =>
                          setActivitySummaryExpanded((expanded) => !expanded)
                        }
                        trailingIcon={
                          <ChevronDown
                            size={14}
                            className={[
                              "transition-transform duration-[160ms] ease-[var(--ease-soft)]",
                              activitySummaryExpanded ? "rotate-180" : "",
                            ].join(" ")}
                          />
                        }
                      >
                        AI 概览
                      </Button>
                    ) : null}
                  </div>

                  {showActivitySummary && activitySummaryExpanded ? (
                    <div className="border-t border-border pt-5">
                      <AiArtifactCard
                        eyebrow="AI Summary"
                        title="AI 总结"
                        input={{
                          kind: "activity_summary",
                          projectId: activity.projectId,
                          activityId: activity.id,
                        }}
                        aiEnabled={summaryReady}
                        sectionsLayout="single-column"
                        display="embedded"
                      />
                    </div>
                  ) : null}
                </section>

                <ActivityNotesPanel
                  projectId={activity.projectId}
                  activityId={activity.id}
                  notes={activity.notes}
                  recordTypeSettings={recordTypeSettingsQuery.data}
                  saving={noteMutation.isPending}
                  deletingNote={noteDeleteMutation.isPending}
                  showAiRefine={showAiRefine}
                  aiReady={suggestionGenerationReady}
                  enabledSuggestionTypes={visibleSuggestionTypes}
                  onUpsertNote={(input) => noteMutation.mutateAsync(input)}
                  onDeleteNote={(noteId) =>
                    noteDeleteMutation.mutateAsync({ noteId })
                  }
                  onImportImage={importNoteImageForEditor}
                  onImportDocument={importDocumentForEditor}
                  onImportClipboardImage={importClipboardImageForEditor}
                  onGenerateAiSuggestions={generateAiSuggestionsForNote}
                  onAcceptAiSuggestion={acceptAiSuggestion}
                  onManageRecordTypes={() => openSettings("record-types")}
                />
              </section>

              <section className="activity-page__details-column grid min-w-0 gap-6">
                <section className="grid gap-4">
                  <SectionHeader
                    eyebrow="Documents"
                    title="文件材料"
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void handleOpenActivityDocumentPicker();
                        }}
                      >
                        导入文件
                      </Button>
                    }
                  />
                  <ManagedDocumentSection
                    projectId={activity.projectId}
                    projectRootPath={activeProject.rootPath}
                    activityId={activity.id}
                    documents={activity.documents}
                    layout="list"
                    importButtonLabel="导入文件"
                    showImportButton={false}
                    emptyText="还没有关联文件。"
                    compactHeader
                    pageDropActive={pageDragActive}
                    pageDropMessage="整个 activity 页面都支持拖入，文件会直接归入当前 activity"
                    onDropFiles={requestImportPaths}
                  />
                </section>
                {pendingImportPaths ? (
                  <DocumentImportTagDialog
                    paths={pendingImportPaths}
                    tags={fileTags}
                    selectedTagIds={pendingImportTagIds}
                    onToggleTag={togglePendingImportTag}
                    onClose={closeImportTagDialog}
                    onConfirm={() => {
                      void confirmImportTagDialog();
                    }}
                    onManageTags={manageImportTags}
                  />
                ) : null}

                <section className="grid gap-4 border-t border-border pt-6">
                  <SectionHeader
                    eyebrow="Conclusions"
                    title="结论"
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setPendingConclusionFocusPoint(null);
                          void requestConclusionActivation(
                            CONCLUSION_COMPOSER_KEY,
                          );
                        }}
                      >
                        新增结论
                      </Button>
                    }
                  />

                  <div className="grid gap-1.5">
                    {isConclusionComposerActive ? (
                      <article
                        className="border-b border-[color-mix(in_srgb,var(--color-border)_88%,transparent)] py-1.5"
                        onBlurCapture={(event) => {
                          if (isFocusMovingWithinCurrentTarget(event)) {
                            return;
                          }

                          void commitOrCloseConclusionComposer();
                        }}
                      >
                        <div
                          className="inline-object-item"
                          onKeyDownCapture={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              closeConclusionComposer();
                              return;
                            }
                            if (isSubmitShortcut(event)) {
                              event.preventDefault();
                              blurKeyboardTarget(event.target);
                            }
                          }}
                        >
                          <div
                            className="inline-object-rail"
                            aria-hidden="true"
                          >
                            <div className="inline-object-guide" />
                          </div>
                          <div className="inline-object-panel inline-object-panel--active">
                            <RichEditor
                              html={conclusionDraft.html}
                              variant="bare"
                              autoFocus={
                                pendingConclusionFocusPoint?.key ===
                                CONCLUSION_COMPOSER_KEY
                                  ? pendingConclusionFocusPoint.point
                                  : true
                              }
                              enableTables={false}
                              placeholder="记录已确认的判断、共识或决定。"
                              onChange={setConclusionDraft}
                            />
                          </div>
                        </div>
                      </article>
                    ) : null}

                    {activity.conclusions.length > 0 ? (
                      <div className="grid gap-0">
                        {activity.conclusions.map((item) => (
                          <InlineActivityConclusionEditor
                            key={item.id}
                            conclusion={item}
                            activationKey={conclusionActivationKey(item.id)}
                            autoFocusTarget={
                              pendingConclusionFocusPoint?.key ===
                              conclusionActivationKey(item.id)
                                ? pendingConclusionFocusPoint.point
                                : true
                            }
                            busy={
                              conclusionUpdateMutation.isPending ||
                              conclusionDeleteMutation.isPending
                            }
                            isActive={
                              activeConclusionKey ===
                              conclusionActivationKey(item.id)
                            }
                            registerActivation={registerConclusionActivation}
                            onDeactivate={() =>
                              clearActiveConclusion(
                                conclusionActivationKey(item.id),
                              )
                            }
                            onRequestActivate={(focusPoint) => {
                              setPendingConclusionFocusPoint(
                                focusPoint
                                  ? {
                                      key: conclusionActivationKey(item.id),
                                      point: focusPoint,
                                    }
                                  : null,
                              );
                              return requestConclusionActivation(
                                conclusionActivationKey(item.id),
                              );
                            }}
                            onOpenContextMenu={(conclusionId, x, y) =>
                              setConclusionContextMenu({ conclusionId, x, y })
                            }
                            onSave={async (
                              conclusionId,
                              markdown,
                              html,
                              promotedToProject,
                            ) => {
                              await conclusionUpdateMutation.mutateAsync({
                                conclusionId,
                                markdown,
                                html,
                                promotedToProject,
                              });
                            }}
                          />
                        ))}
                      </div>
                    ) : isConclusionComposerActive ? null : (
                      <EmptyState text="还没有结论。" compact />
                    )}

                    {conclusionContextMenu && contextMenuConclusion ? (
                      <ActionContextMenu
                        x={conclusionContextMenu.x}
                        y={conclusionContextMenu.y}
                        ariaLabel="结论操作"
                        onClose={() => setConclusionContextMenu(null)}
                        actions={[
                          {
                            icon: Star,
                            label: contextMenuConclusion.promotedToProject
                              ? "取消项目级标星"
                              : "设为项目级标星",
                            disabled:
                              conclusionUpdateMutation.isPending ||
                              conclusionDeleteMutation.isPending,
                            onSelect: () => {
                              void conclusionUpdateMutation.mutateAsync({
                                conclusionId: contextMenuConclusion.id,
                                markdown: contextMenuConclusion.contentMarkdown,
                                html: contextMenuConclusion.contentHtml,
                                promotedToProject:
                                  !contextMenuConclusion.promotedToProject,
                              });
                            },
                          },
                          {
                            icon: Trash2,
                            label: "删除",
                            tone: "danger",
                            disabled: conclusionDeleteMutation.isPending,
                            onSelect: () => {
                              void conclusionDeleteMutation.mutateAsync({
                                conclusionId: contextMenuConclusion.id,
                              });
                            },
                          },
                        ]}
                      />
                    ) : null}
                  </div>
                </section>
              </section>
            </div>
          </div>
        )}
      </section>

      {activity ? (
        <TodoRail
          title="Activity 待办"
          scopeLabel={activity.title || "Untitled Activity"}
          unfinishedTodos={activityUnfinishedTodos}
          finishedTodos={activityFinishedTodos}
          activityNameById={activityNameById}
          createPlaceholder="写下一条来自当前 activity 的 Todo"
          onCreateTodo={(payload) =>
            todoMutation.mutate({
              projectId: activity.projectId,
              activityId: activity.id,
              ...payload,
            })
          }
          onToggleStatus={(todoId, status) =>
            todoStatusMutation.mutateAsync({ todoId, status })
          }
          onUpdatePriority={(todoId, priority) =>
            todoPriorityMutation.mutateAsync({ todoId, priority })
          }
          onUpdateContent={(todoId, content) =>
            todoContentMutation.mutateAsync({ todoId, content })
          }
          onAddProgress={(todoId, payload) =>
            todoProgressMutation.mutateAsync({ todoId, ...payload })
          }
          onDeleteTodo={(todoId) => todoDeleteMutation.mutateAsync({ todoId })}
          onOpenTodoSource={(todo) => {
            if (!todo.activityId) return;
            navigate(
              activityPath(
                activity.projectId,
                todo.activityId,
                `todo-${todo.id}`,
              ),
            );
          }}
          onError={(message) =>
            pushToast({ tone: "error", title: "进展保存失败", detail: message })
          }
        />
      ) : null}
    </div>
  );
}

const CONCLUSION_COMPOSER_KEY = "composer";

function emptyRichEditorValue(): RichEditorValue {
  return {
    html: EMPTY_RICH_EDITOR_HTML,
    text: "",
    markdown: "",
  };
}

function InlineActivityConclusionEditor({
  conclusion,
  activationKey,
  autoFocusTarget,
  busy,
  isActive,
  registerActivation,
  onDeactivate,
  onRequestActivate,
  onOpenContextMenu,
  onSave,
}: {
  conclusion: ConclusionRecord;
  activationKey: string;
  autoFocusTarget: boolean | { x: number; y: number };
  busy: boolean;
  isActive: boolean;
  registerActivation: (
    key: string,
    handler: () => Promise<boolean> | boolean,
  ) => () => void;
  onDeactivate: () => void;
  onRequestActivate: (focusPoint?: {
    x: number;
    y: number;
  }) => Promise<boolean>;
  onOpenContextMenu: (conclusionId: number, x: number, y: number) => void;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<RichEditorValue>(() =>
    buildConclusionDraft(conclusion),
  );
  const saveInFlightRef = useRef(false);
  const renderableHtml = useMemo(
    () =>
      getRenderableRichTextHtml({
        html: conclusion.contentHtml,
        markdown: conclusion.contentMarkdown,
      }),
    [conclusion.contentHtml, conclusion.contentMarkdown],
  );

  useEffect(() => {
    setDraft(buildConclusionDraft(conclusion));
  }, [conclusion.contentHtml, conclusion.contentMarkdown, conclusion.id]);

  const resetEditingState = useCallback(() => {
    setDraft(buildConclusionDraft(conclusion));
  }, [conclusion]);

  const commitOrClose = useCallback(async () => {
    if (busy || saveInFlightRef.current) {
      return false;
    }

    const normalizedDraft = normalizeRichEditorValue(draft);
    const initialDraft = normalizeRichEditorValue(
      buildConclusionDraft(conclusion),
    );

    if (!normalizedDraft.markdown) {
      resetEditingState();
      onDeactivate();
      return true;
    }

    if (
      normalizedDraft.markdown === initialDraft.markdown &&
      normalizedDraft.html === initialDraft.html
    ) {
      onDeactivate();
      return true;
    }

    saveInFlightRef.current = true;

    try {
      await onSave(
        conclusion.id,
        normalizedDraft.markdown,
        normalizedDraft.html,
        conclusion.promotedToProject,
      );
      onDeactivate();
      return true;
    } catch {
      return false;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [busy, conclusion, draft, onDeactivate, onSave, resetEditingState]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    return registerActivation(activationKey, commitOrClose);
  }, [activationKey, commitOrClose, isActive, registerActivation]);

  return (
    <article
      id={`conclusion-${conclusion.id}`}
      className="border-b border-[color-mix(in_srgb,var(--color-border)_88%,transparent)] py-1.5 last:border-b-0"
      onMouseDownCapture={(event) => {
        if (isActive || event.button !== 2 || shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }

        event.preventDefault();
      }}
      onBlurCapture={(event) => {
        if (!isActive || isFocusMovingWithinCurrentTarget(event)) {
          return;
        }

        void commitOrClose();
      }}
      onContextMenu={(event) => {
        if (isActive || shouldIgnoreContextMenuTarget(event.target)) {
          return;
        }
        event.preventDefault();
        onOpenContextMenu(conclusion.id, event.clientX, event.clientY);
      }}
    >
      <div
        className="inline-object-item"
        onKeyDownCapture={(event) => {
          if (!isActive) {
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            resetEditingState();
            onDeactivate();
            return;
          }
          if (isSubmitShortcut(event)) {
            event.preventDefault();
            blurKeyboardTarget(event.target);
          }
        }}
      >
        <div className="inline-object-rail" aria-hidden="true">
          <div
            className={inlineObjectGuideClass(conclusion.promotedToProject)}
          />
        </div>
        <div
          role={isActive ? undefined : "button"}
          tabIndex={isActive || busy ? -1 : 0}
          className={[
            "inline-object-panel",
            isActive
              ? "inline-object-panel--active"
              : "inline-object-panel--interactive",
          ].join(" ")}
          onMouseDown={(event) => {
            if (
              isActive ||
              busy ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              shouldIgnoreContextMenuTarget(event.target)
            ) {
              return;
            }

            event.preventDefault();
            void onRequestActivate(
              relativeFocusPointFromMouseEvent(
                event.currentTarget,
                event.clientX,
                event.clientY,
              ),
            );
          }}
          onKeyDown={(event) => {
            if (isActive || busy) {
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void onRequestActivate();
            }
          }}
        >
          {isActive ? (
            <RichEditor
              html={draft.html}
              variant="bare"
              autoFocus={autoFocusTarget}
              enableTables={false}
              placeholder="记录已确认的判断、共识或决定。"
              onChange={setDraft}
            />
          ) : (
            <RichEditor html={renderableHtml} variant="bare" readOnly />
          )}
        </div>
      </div>
    </article>
  );
}

function buildConclusionDraft(conclusion: ConclusionRecord): RichEditorValue {
  return {
    html: getRenderableRichTextHtml({
      html: conclusion.contentHtml,
      markdown: conclusion.contentMarkdown,
    }),
    text: conclusion.contentMarkdown,
    markdown: conclusion.contentMarkdown,
  };
}

function conclusionActivationKey(conclusionId: number) {
  return `conclusion:${conclusionId}`;
}

function inlineObjectGuideClass(accented: boolean) {
  return accented
    ? "inline-object-guide inline-object-guide--accent"
    : "inline-object-guide";
}

function isFocusMovingWithinCurrentTarget(event: FocusEvent<HTMLElement>) {
  const nextFocusedElement = event.relatedTarget;
  return (
    nextFocusedElement instanceof Node &&
    event.currentTarget.contains(nextFocusedElement)
  );
}

function isSubmitShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}) {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}

function blurKeyboardTarget(target: EventTarget | null) {
  if (target instanceof HTMLElement) {
    target.blur();
  }
}

function relativeFocusPointFromMouseEvent(
  element: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const rect = element.getBoundingClientRect();

  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
    mode: "content-relative" as const,
  };
}

function appendDocumentToActivityCache(
  queryClient: ReturnType<typeof useQueryClient>,
  document: DocumentRecord,
) {
  queryClient.setQueryData<ActivityCardData[] | undefined>(
    ["activities", document.projectId],
    (currentActivities) => {
      if (!currentActivities) {
        return currentActivities;
      }

      return currentActivities.map((activity) => {
        if (activity.id !== document.activityId) {
          return activity;
        }

        const alreadyExists = activity.documents.some(
          (item) => item.id === document.id,
        );

        return {
          ...activity,
          documents: alreadyExists
            ? activity.documents
            : [document, ...activity.documents],
          digest: {
            ...activity.digest,
            documentCount: alreadyExists
              ? activity.digest.documentCount
              : activity.digest.documentCount + 1,
          },
        };
      });
    },
  );
}

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function buildClipboardImageFileName(file: File) {
  const extension = extensionForMimeType(file.type);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);

  return `clipboard-image-${timestamp}.${extension}`;
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}
