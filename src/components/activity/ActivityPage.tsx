import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import type { ActivityCardData, ConclusionRecord, DocumentRecord } from "../../lib/types";
import { isAiCapabilityConfigured } from "../../lib/ai";
import { activityAttributeLabel } from "../../lib/constants";
import { activityPath, formatDateTime, parseRouteId, projectPath } from "../../lib/formatters";
import { useActivityMutations } from "../../hooks/useActivityMutations";
import { useAiMutations } from "../../hooks/useAiMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import {
  EMPTY_RICH_EDITOR_HTML,
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorValue,
} from "../rich-editor";
import { ManagedDocumentSection } from "../document/ManagedDocumentSection";
import { ProjectSidebar, type ProjectSidebarActivityItem } from "../layout/ProjectSidebar";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import {
  Button,
  EmptyState,
  SectionHeader,
  SurfaceCard,
} from "../../ui/components";
import { TodoRail } from "../todo";
import { ActivityTagDropdown } from "./ActivityTagDropdown";
import { ActivityNotesPanel } from "./ActivityNotesPanel";

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
    () => (projectsQuery.data ?? []).find((project) => project.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );

  const activitiesQuery = useQuery({
    queryKey: ["activities", projectId],
    queryFn: () => projectMindApi.activityList({ projectId: projectId as number }),
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
    const found = (activitiesQuery.data ?? []).find((item) => item.id === activityId);
    return found ? { ...found, isExpanded: true } : null;
  }, [activitiesQuery.data, activityId]);
  const sidebarActivities = useMemo<ProjectSidebarActivityItem[]>(
    () =>
      (activitiesQuery.data ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        activityTime: item.activityTime,
        attributeLabel: item.attributeLabel,
        attributeColorKey: item.attributeColorKey,
        documentCount: item.digest.documentCount,
        completedTodoCount: item.digest.completedTodoCount,
        totalTodoCount: item.digest.totalTodoCount,
        statusLabel: item.digest.statusLabel,
        statusColorKey: item.digest.statusColorKey,
      })),
    [activitiesQuery.data],
  );

  const { activityMetaMutation, noteMutation, conclusionMutation, conclusionUpdateMutation } =
    useActivityMutations();
  const {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoProgressMutation,
  } = useTodoMutations(activity?.todos);
  const { aiGenerateMutation, aiAcceptMutation } = useAiMutations();
  const { openSettings } = useUiStore();
  const { pushToast } = useFeedbackStore();

  useFocusTarget(focusId, [activity]);

  const [conclusionDraft, setConclusionDraft] = useState<RichEditorValue>(emptyRichEditorValue());
  const [promoteConclusion, setPromoteConclusion] = useState(true);
  const [conclusionComposerOpen, setConclusionComposerOpen] = useState(false);
  const [pageDragActive, setPageDragActive] = useState(false);

  const busyAi = aiGenerateMutation.isPending || aiAcceptMutation.isPending;
  const suggestionGenerationReady = isAiCapabilityConfigured(
    aiSettingsQuery.data,
    "suggestion_generation",
  );
  const activityNameById = useMemo(
    () => (activity ? new Map([[activity.id, activity.title]]) : new Map<number, string>()),
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
        void queryClient.invalidateQueries({ queryKey: ["overview", document.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["dashboard", document.projectId] });

        return document;
      } catch (error) {
        pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
        throw error;
      }
    },
    [activity, pushToast, queryClient],
  );

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
    async (suggestionId: number) => aiAcceptMutation.mutateAsync({ suggestionId }),
    [aiAcceptMutation],
  );

  const importDocumentToCurrentActivity = useCallback(
    (sourcePath: string) =>
      projectMindApi.documentImport({
        projectId: activity?.projectId as number,
        activityId: activity?.id as number,
        sourcePath,
        isStarred: false,
      }),
    [activity?.id, activity?.projectId],
  );

  const resetConclusionComposer = useCallback(() => {
    setConclusionDraft(emptyRichEditorValue());
    setPromoteConclusion(true);
    setConclusionComposerOpen(false);
  }, []);

  const handleCreateConclusion = useCallback(async () => {
    if (!activity) {
      return;
    }

    const normalizedDraft = normalizeRichEditorValue(conclusionDraft);
    if (!normalizedDraft.markdown) {
      return;
    }

    try {
      await conclusionMutation.mutateAsync({
        projectId: activity.projectId,
        activityId: activity.id,
        markdown: normalizedDraft.markdown,
        html: normalizedDraft.html,
        promotedToProject: promoteConclusion,
      });

      resetConclusionComposer();
    } catch {
      return;
    }
  }, [
    activity,
    conclusionDraft,
    conclusionMutation,
    promoteConclusion,
    resetConclusionComposer,
  ]);

  const handlePageDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setPageDragActive(false);

      if (!activity) {
        return;
      }

      const droppedFiles = Array.from(event.dataTransfer.files) as Array<File & { path?: string }>;
      const droppedPaths = droppedFiles
        .map((file) => file.path?.trim())
        .filter((path): path is string => Boolean(path));

      if (droppedPaths.length === 0) {
        pushToast({
          tone: "error",
          title: "无法读取拖拽文件",
          detail: "当前拖拽源没有暴露本地路径，请改用“选择文件”导入。",
        });
        return;
      }

      try {
        const importedDocuments = await Promise.all(
          droppedPaths.map((sourcePath) => importDocumentToCurrentActivity(sourcePath)),
        );

        importedDocuments.forEach((document) => appendDocumentToActivityCache(queryClient, document));
        void queryClient.invalidateQueries({ queryKey: ["overview", activity.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["dashboard", activity.projectId] });
      } catch (error) {
        pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
      }
    },
    [activity, importDocumentToCurrentActivity, pushToast, queryClient],
  );

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
        <ProjectSidebar
          project={{
            name: activeProject.name,
            rootPath: activeProject.rootPath,
            isArchived: activeProject.isArchived,
          }}
          activities={sidebarActivities}
          activeActivityId={activityId}
          onOpenProject={() => navigate(projectPath(activeProject.id))}
          onOpenActivity={(nextActivityId) =>
            navigate(activityPath(activeProject.id, nextActivityId))
          }
        />
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
          onOpenTodoSource={() => undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-bg">
      <ProjectSidebar
        project={{
          name: activeProject.name,
          rootPath: activeProject.rootPath,
          isArchived: activeProject.isArchived,
        }}
        activities={sidebarActivities}
        activeActivityId={activity?.id ?? activityId}
        onOpenProject={() => navigate(projectPath(activeProject.id))}
        onOpenActivity={(nextActivityId) =>
          navigate(activityPath(activeProject.id, nextActivityId))
        }
      />

      <section
        data-testid="activity-page-dropzone"
        className={[
          "min-h-0 flex-1 overflow-y-auto bg-bg transition-[background-color] duration-[160ms] ease-[var(--ease-soft)]",
          pageDragActive ? "bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg))]" : "",
        ].join(" ")}
        onDragOver={(event) => {
          event.preventDefault();
          if (activity) {
            setPageDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setPageDragActive(false);
        }}
        onDrop={handlePageDrop}
      >
        {!activity ? (
          <div className="mx-auto flex h-full w-full max-w-6xl items-center justify-center px-6 py-8">
            <EmptyState text="没有找到这个 activity。" className="w-full max-w-xl" />
          </div>
        ) : (
          <div className="activity-page__content-shell mx-auto flex w-full max-w-6xl flex-col px-6 py-6">
            <div className="mb-6 border-b border-border pb-5">
              <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                {activeProject.name}
              </p>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                <div className="min-w-0">
                  <h1 className="text-headline font-medium tracking-tight text-text">
                    {activity.title || "Untitled Activity"}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2">
                    <ActivityTagDropdown
                      label={activityAttributeLabel(activity.attributeLabel)}
                      colorKey={activity.attributeColorKey ?? null}
                      busy={activityMetaMutation.isPending}
                      selectedOptionId={activity.attributeOptionId ?? null}
                      options={
                        activitySettingsQuery.data?.activityAttributeOptions.map((option) => ({
                          id: option.id,
                          label: option.label,
                          colorKey: option.colorKey,
                        })) ?? []
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
                    <ActivityTagDropdown
                      label={activity.statusLabel}
                      colorKey={activity.statusColorKey}
                      busy={activityMetaMutation.isPending}
                      selectedOptionId={activity.statusOptionId}
                      options={
                        activitySettingsQuery.data?.activityStatusOptions.map((option) => ({
                          id: option.id,
                          label: option.label,
                          colorKey: option.colorKey,
                        })) ?? []
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
                      {formatDateTime(activity.activityTime)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="activity-page__layout">
              <section className="activity-page__notes-column grid min-w-0 gap-5">
                <ActivityNotesPanel
                  projectId={activity.projectId}
                  activityId={activity.id}
                  notes={activity.notes}
                  recordTypeSettings={recordTypeSettingsQuery.data}
                  saving={noteMutation.isPending}
                  aiEnabled={suggestionGenerationReady}
                  aiBusy={busyAi}
                  onUpsertNote={(input) => noteMutation.mutateAsync(input)}
                  onImportDocument={importDocumentForEditor}
                  onGenerateAiSuggestions={generateAiSuggestionsForNote}
                  onAcceptAiSuggestion={acceptAiSuggestion}
                  onManageRecordTypes={() => openSettings("record-types")}
                />
              </section>

              <section className="activity-page__details-column grid min-w-0 gap-5">
                <section className="grid gap-4">
                  <SectionHeader
                    eyebrow="Documents"
                    title="文件材料"
                    description="导入与当前活动相关的文件和附件。"
                  />
                  <ManagedDocumentSection
                    projectId={activity.projectId}
                    projectRootPath={activeProject.rootPath}
                    activityId={activity.id}
                    documents={activity.documents}
                    layout="grid"
                    importButtonLabel="导入文件"
                    emptyText="还没有关联文件。"
                    compactHeader
                    pageDropActive={pageDragActive}
                    pageDropMessage="整个 activity 页面都支持拖入，文件会直接归入当前 activity"
                  />
                </section>

                <section className="grid gap-4">
                  <SectionHeader
                    eyebrow="Conclusions"
                    title="结论"
                    actions={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setConclusionComposerOpen(true)}
                      >
                        新增结论
                      </Button>
                    }
                  />

                  <SurfaceCard subtle className="grid gap-4 p-4">
                    {conclusionComposerOpen ? (
                      <div className="grid gap-3">
                        <p className="text-body font-medium text-text">新增结论</p>
                        <div
                          className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus-within:border-accent"
                          onKeyDownCapture={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              resetConclusionComposer();
                            }
                          }}
                        >
                          <RichEditor
                            html={conclusionDraft.html}
                            variant="bare"
                            placeholder="记录已确认的判断、共识或决定。"
                            onChange={setConclusionDraft}
                          />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <label className="flex items-center gap-2 text-ui text-text-muted">
                            <input
                              type="checkbox"
                              checked={promoteConclusion}
                              onChange={(event) => setPromoteConclusion(event.target.checked)}
                            />
                            提升到项目首页
                          </label>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={conclusionMutation.isPending}
                              onClick={resetConclusionComposer}
                            >
                              取消
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              disabled={conclusionMutation.isPending}
                              onClick={() => void handleCreateConclusion()}
                            >
                              {conclusionMutation.isPending ? "保存中..." : "保存结论"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="grid gap-3 border-t border-border pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                          当前结论
                        </p>
                        <span className="text-caption text-text-soft">
                          {activity.conclusions.length} 条
                        </span>
                      </div>

                      {activity.conclusions.length > 0 ? (
                        <div className="grid gap-3">
                          {activity.conclusions.map((item) => (
                            <InlineActivityConclusionEditor
                              key={item.id}
                              conclusion={item}
                              busy={conclusionUpdateMutation.isPending}
                              onSave={async (conclusionId, markdown, html, promotedToProject) => {
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
                      ) : (
                        <EmptyState
                          text={conclusionComposerOpen ? "还没有结论。" : "还没有结论，点“新增结论”开始记录。"}
                          compact
                        />
                      )}
                    </div>
                  </SurfaceCard>
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
          onToggleStatus={(todoId, status) => todoStatusMutation.mutateAsync({ todoId, status })}
          onUpdatePriority={(todoId, priority) =>
            todoPriorityMutation.mutateAsync({ todoId, priority })
          }
          onUpdateContent={(todoId, content) =>
            todoContentMutation.mutateAsync({ todoId, content })
          }
          onAddProgress={(todoId, payload) =>
            todoProgressMutation.mutateAsync({ todoId, ...payload })
          }
          onOpenTodoSource={(todo) => {
            if (!todo.activityId) return;
            navigate(activityPath(activity.projectId, todo.activityId, `todo-${todo.id}`));
          }}
          onError={(message) =>
            pushToast({ tone: "error", title: "进展保存失败", detail: message })
          }
        />
      ) : null}
    </div>
  );
}

function emptyRichEditorValue(): RichEditorValue {
  return {
    html: EMPTY_RICH_EDITOR_HTML,
    text: "",
    markdown: "",
  };
}

function InlineActivityConclusionEditor({
  conclusion,
  busy,
  onSave,
}: {
  conclusion: ConclusionRecord;
  busy: boolean;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RichEditorValue>(() => buildConclusionDraft(conclusion));
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
    setEditing(false);
  }, [conclusion.contentHtml, conclusion.contentMarkdown, conclusion.id]);

  return (
    <article
      id={`conclusion-${conclusion.id}`}
      className="grid gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0"
    >
      {editing ? (
        <div className="grid gap-2">
          <div
            className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus-within:border-accent"
            onKeyDownCapture={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(buildConclusionDraft(conclusion));
                setEditing(false);
              }
            }}
          >
            <RichEditor
              html={draft.html}
              variant="bare"
              placeholder="记录已确认的判断、共识或决定。"
              onChange={setDraft}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui text-text-soft">
              {conclusion.promotedToProject ? "项目级可见" : "活动内结论"} ·{" "}
              {formatDateTime(conclusion.updatedAt)}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(buildConclusionDraft(conclusion));
                  setEditing(false);
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const normalizedDraft = normalizeRichEditorValue(draft);
                    if (!normalizedDraft.markdown) {
                      return;
                    }

                    try {
                      await onSave(
                        conclusion.id,
                        normalizedDraft.markdown,
                        normalizedDraft.html,
                        conclusion.promotedToProject,
                      );
                      setEditing(false);
                    } catch {
                      return;
                    }
                  })();
                }}
              >
                {busy ? "保存中..." : "保存修改"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0">
            <RichEditor html={renderableHtml} variant="bare" readOnly />
            <p className="mt-2 text-ui text-text-soft">
              {conclusion.promotedToProject ? "项目级可见" : "活动内结论"} ·{" "}
              {formatDateTime(conclusion.updatedAt)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="justify-self-start px-2 text-caption sm:justify-self-end"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            编辑
          </Button>
        </div>
      )}
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

        const alreadyExists = activity.documents.some((item) => item.id === document.id);

        return {
          ...activity,
          documents: alreadyExists ? activity.documents : [document, ...activity.documents],
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
