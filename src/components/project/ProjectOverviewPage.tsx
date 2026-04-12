import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Share2,
  Star,
  Trash2,
} from "lucide-react";

import type {
  ActivityDigest,
  ConclusionGroup,
  ConclusionRecord,
  DocumentRecord,
  ProjectOverviewData,
} from "../../lib/types";
import { shouldIgnoreContextMenuTarget } from "../../lib/context-menu";
import {
  formatOverviewDate,
  parseRouteId,
  activityPath,
} from "../../lib/formatters";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { isAiFeatureReady, isAiFeatureVisible } from "../../lib/ai";
import { useActivityMutations } from "../../hooks/useActivityMutations";
import { useDocumentImportFlow } from "../../hooks/useDocumentImportFlow";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { useDismissOnOutside } from "../../hooks/useDismissOnOutside";
import { useExclusiveActivation } from "../../hooks/useExclusiveActivation";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  ActionContextMenu,
  Button,
  EmptyState,
  IconButton,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
  TextField,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorValue,
} from "../rich-editor";
import { TodoRail } from "../todo";
import { DocumentImportTagDialog } from "../document/DocumentImportTagDialog";
import { ManagedDocumentSection } from "../document/ManagedDocumentSection";
import { ActivityAttributeTag } from "../activity/ActivityAttributeTag";
import { AiArtifactCard } from "../ai/AiArtifactCard";

export function ProjectOverviewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const projectId = parseRouteId(params.projectId);
  const focusId = searchParams.get("focus");

  const { pushToast } = useFeedbackStore();

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((p) => !p.isArchived),
    [projectsQuery.data],
  );

  const activeProject = useMemo(
    () => (projectsQuery.data ?? []).find((p) => p.id === projectId) ?? null,
    [projectId, projectsQuery.data],
  );

  const overviewQuery = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => projectMindApi.projectGetOverview({ projectId: projectId as number }),
    enabled: projectId !== null,
  });
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
  });
  const { summaryMutation, archiveMutation } = useProjectMutations(visibleProjects, (path) =>
    navigate(path),
  );
  const { createActivityMutation, conclusionUpdateMutation, conclusionDeleteMutation } =
    useActivityMutations({
      onCreateActivitySuccess: (activity) => {
        navigate(activityPath(activity.projectId, activity.id, "activity-title"));
      },
    });
  const {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoDeleteMutation,
  } = useTodoMutations([
    ...(overviewQuery.data?.unfinishedTodos ?? []),
    ...(overviewQuery.data?.finishedTodos ?? []),
  ]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [pendingConclusionFocusPoint, setPendingConclusionFocusPoint] = useState<{
    id: number;
    point: { x: number; y: number };
  } | null>(null);
  const [pageDragActive, setPageDragActive] = useState(false);
  const [projectBriefExpanded, setProjectBriefExpanded] = useState(false);
  const nameSkipBlurRef = useRef(false);
  const summarySkipBlurRef = useRef(false);
  const summaryTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    activeKey: activeConclusionId,
    clearActive: clearActiveConclusion,
    register: registerConclusionActivation,
    requestActivation: requestConclusionActivation,
  } = useExclusiveActivation<number>();
  const projectBriefCardRef = useDismissOnOutside<HTMLDivElement>({
    enabled: projectBriefExpanded,
    onDismiss: () => setProjectBriefExpanded(false),
  });

  useEffect(() => {
    if (activeProject) {
      setNameDraft(activeProject.name);
      setNameEditing(false);
      setSummaryDraft(activeProject.summary);
      setSummaryEditing(false);
    }
  }, [activeProject?.id, activeProject?.name, activeProject?.summary]);

  useEffect(() => {
    if (!summaryEditing || !summaryTextareaRef.current) {
      return;
    }
    const textarea = summaryTextareaRef.current;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 120)}px`;
  }, [summaryDraft, summaryEditing]);

  useEffect(() => {
    setProjectBriefExpanded(false);
  }, [activeProject?.id]);

  useEffect(() => {
    clearActiveConclusion();
    setPendingConclusionFocusPoint(null);
  }, [activeProject?.id, clearActiveConclusion]);

  const overview = overviewQuery.data;
  useFocusTarget(focusId, [overview]);

  const activityMetaById = useMemo(
    () => new Map(overview?.activityFeed.map((activity) => [activity.id, activity]) ?? []),
    [overview?.activityFeed],
  );
  const activityNameById = useMemo(
    () => new Map(overview?.activityFeed.map((activity) => [activity.id, activity.title]) ?? []),
    [overview?.activityFeed],
  );
  const allConclusionIds = useMemo(
    () =>
      overview?.conclusionGroups.flatMap((group) => group.conclusions.map((conclusion) => conclusion.id)) ?? [],
    [overview?.conclusionGroups],
  );
  const showProjectBrief = isAiFeatureVisible(aiSettingsQuery.data, "summary.project_brief");
  const summaryReady = isAiFeatureReady(aiSettingsQuery.data, "summary.project_brief");
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
    projectId: activeProject?.id ?? null,
    onDocumentsImported: (documents) => {
      documents.forEach((document) => appendDocumentToProjectOverviewCache(queryClient, document));
    },
  });
  const handlePageDrop = useCallback(
    async (paths: string[]) => {
      await requestImportPaths(paths);
    },
    [requestImportPaths],
  );
  const { nativeWindowFileDrop } = useWindowFileDrop({
    enabled: Boolean(activeProject),
    onDrop: handlePageDrop,
    onHoverChange: setPageDragActive,
  });

  useEffect(() => {
    if (activeConclusionId !== null && !allConclusionIds.includes(activeConclusionId)) {
      clearActiveConclusion(activeConclusionId);
    }
  }, [activeConclusionId, allConclusionIds, clearActiveConclusion]);

  useEffect(() => {
    if (activeConclusionId === null) {
      setPendingConclusionFocusPoint(null);
    }
  }, [activeConclusionId]);

  function handleOpenProjectFolder(rootPath: string) {
    void desktopApi.openFolder(rootPath).catch((error) => {
      pushToast({
        tone: "error",
        title: "打开项目目录失败",
        detail: String(error),
      });
    });
  }

  function handleSaveProjectName() {
    if (!activeProject) {
      return;
    }
    const nextName = nameDraft.trim();
    if (!nextName) {
      pushToast({
        tone: "error",
        title: "项目名称不能为空",
      });
      setNameDraft(activeProject.name);
      setNameEditing(false);
      return;
    }
    if (nextName === activeProject.name.trim()) {
      setNameDraft(activeProject.name);
      setNameEditing(false);
      return;
    }
    summaryMutation.mutate({
      projectId: activeProject.id,
      name: nextName,
      summary: activeProject.summary,
      status: activeProject.status,
    });
    setNameDraft(nextName);
    setNameEditing(false);
  }

  function handleSaveProjectSummary() {
    if (!activeProject) {
      return;
    }
    const nextSummary = summaryDraft.trim();
    if (nextSummary === activeProject.summary.trim()) {
      setSummaryDraft(activeProject.summary);
      setSummaryEditing(false);
      return;
    }
    summaryMutation.mutate({
      projectId: activeProject.id,
      summary: nextSummary,
      status: activeProject.status,
    });
    setSummaryDraft(nextSummary);
    setSummaryEditing(false);
  }

  function handleCreateActivity() {
    if (!activeProject || createActivityMutation.isPending) {
      return;
    }

    createActivityMutation.mutate({
      projectId: activeProject.id,
      title: "",
      activityTime: new Date().toISOString(),
    });
  }

  if (!activeProject || !overview) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载项目...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <section
        data-testid="project-page-dropzone"
        className={[
          "min-h-0 flex-1 overflow-y-auto bg-bg transition-[background-color] duration-[160ms] ease-[var(--ease-soft)]",
          pageDragActive ? "bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg))]" : "",
        ].join(" ")}
        onDragOver={(event) => {
          if (nativeWindowFileDrop) {
            return;
          }
          event.preventDefault();
          setPageDragActive(true);
        }}
        onDragLeave={(event) => {
          if (nativeWindowFileDrop) {
            return;
          }
          event.preventDefault();
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setPageDragActive(false);
        }}
        onDrop={
          nativeWindowFileDrop
            ? undefined
            : (event) => {
                event.preventDefault();
                setPageDragActive(false);
                void handlePageDrop(extractDroppedFilePaths(event.dataTransfer));
              }
        }
      >
        <div ref={projectBriefCardRef} className="px-8 py-6">
          <SurfaceCard subtle className="grid gap-5 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  Project
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {nameEditing ? (
                    <TextField
                      aria-label="项目名称"
                      value={nameDraft}
                      autoFocus
                      className="h-11 min-w-[16rem] max-w-[28rem] rounded-[var(--radius-8)] border-border-strong bg-bg px-3 text-display font-medium tracking-tight"
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setNameDraft(event.target.value)}
                      onBlur={() => {
                        if (nameSkipBlurRef.current) {
                          nameSkipBlurRef.current = false;
                          return;
                        }
                        handleSaveProjectName();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          nameSkipBlurRef.current = true;
                          setNameDraft(activeProject.name);
                          setNameEditing(false);
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="rounded-[var(--radius-8)] bg-transparent px-2 py-1 text-left text-display font-medium tracking-tight text-text transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:bg-bg-hover"
                      onClick={() => setNameEditing(true)}
                    >
                      {activeProject.name}
                    </button>
                  )}
                  {activeProject.isArchived ? (
                    <StatusBadge tone="neutral">archived</StatusBadge>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="mt-2 inline-flex max-w-4xl items-center rounded-[var(--radius-6)] bg-transparent px-2 py-1 text-left text-ui text-text-soft transition-[background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:bg-bg-hover hover:text-text"
                  title={activeProject.rootPath}
                  onClick={() => handleOpenProjectFolder(activeProject.rootPath)}
                >
                  <span className="truncate">项目目录：{activeProject.rootPath}</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {showProjectBrief ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={projectBriefExpanded ? "subtle" : "secondary"}
                    aria-expanded={projectBriefExpanded}
                    onClick={() => setProjectBriefExpanded((expanded) => !expanded)}
                    trailingIcon={
                      <ChevronDown
                        size={14}
                        className={cn(
                          "transition-transform duration-[160ms] ease-[var(--ease-soft)]",
                          projectBriefExpanded && "rotate-180",
                        )}
                      />
                    }
                  >
                    AI 概览
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  leadingIcon={<Plus size={14} />}
                  disabled={createActivityMutation.isPending}
                  onClick={handleCreateActivity}
                >
                  {createActivityMutation.isPending ? "创建中..." : "新增 Activity"}
                </Button>
                <IconButton type="button" size="md">
                  <Share2 size={14} />
                </IconButton>
                <div className="relative">
                  <IconButton
                    type="button"
                    size="md"
                    onClick={() => setProjectMenuOpen((open) => !open)}
                  >
                    <MoreHorizontal size={14} />
                  </IconButton>
                  {projectMenuOpen ? (
                    <SurfaceCard className="absolute right-0 top-[calc(100%+6px)] min-w-[10rem] p-1 shadow-[var(--shadow-md)]">
                      <button
                        type="button"
                        className="w-full rounded-[var(--radius-6)] bg-transparent px-2 py-2 text-left text-ui text-text transition-colors hover:bg-bg-hover"
                        onClick={() => {
                          archiveMutation.mutate({
                            projectId: activeProject.id,
                            isArchived: !activeProject.isArchived,
                          });
                          setProjectMenuOpen(false);
                        }}
                      >
                        {activeProject.isArchived ? "恢复项目" : "归档项目"}
                      </button>
                    </SurfaceCard>
                  ) : null}
                </div>
              </div>
            </div>

            {summaryEditing ? (
              <textarea
                ref={summaryTextareaRef}
                aria-label="项目简介"
                value={summaryDraft}
                rows={4}
                autoFocus
                placeholder="填写项目当前阶段、目标和关键约束。"
                className="min-h-[7.5rem] w-full max-w-3xl resize-none overflow-hidden rounded-[var(--radius-8)] border border-border-strong bg-bg px-4 py-3 text-body leading-6 text-text outline-none transition-[border-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
                onChange={(event) => setSummaryDraft(event.target.value)}
                onBlur={() => {
                  if (summarySkipBlurRef.current) {
                    summarySkipBlurRef.current = false;
                    return;
                  }
                  handleSaveProjectSummary();
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    summarySkipBlurRef.current = true;
                    setSummaryDraft(activeProject.summary);
                    setSummaryEditing(false);
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="w-full max-w-3xl rounded-[var(--radius-8)] border border-transparent bg-bg px-4 py-3 text-left transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] hover:border-border hover:bg-[color-mix(in_srgb,var(--color-bg)_72%,var(--color-bg-subtle))] hover:shadow-[var(--shadow-sm)]"
                onClick={() => setSummaryEditing(true)}
              >
                <span
                  className={cn(
                    "block whitespace-pre-wrap text-body leading-6",
                    activeProject.summary ? "text-text-muted" : "text-text-soft",
                  )}
                >
                  {activeProject.summary || "点击添加项目简介，说明当前阶段、目标和关键约束。"}
                </span>
              </button>
            )}

            {showProjectBrief && projectBriefExpanded ? (
              <div className="border-t border-border pt-5">
                <AiArtifactCard
                  eyebrow="AI Brief"
                  title="AI 项目概览"
                  description="汇总当前项目状态、最近变化、关键决策、阻塞和建议下一步。"
                  input={{ kind: "project_brief", projectId: activeProject.id }}
                  aiEnabled={summaryReady}
                  display="embedded"
                />
              </div>
            ) : null}
          </SurfaceCard>
        </div>

        <div className="grid gap-8 px-8 py-6">
          <section className="grid gap-3">
            <ManagedDocumentSection
              projectId={activeProject.id}
              projectRootPath={activeProject.rootPath}
              documents={overview.projectDocuments}
              layout="grid"
              importButtonLabel="导入文件"
              emptyText="还没有文件。"
              pageDropActive={pageDragActive}
              pageDropMessage="整个 project 页面都支持拖入，文件会直接归入项目根目录"
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

          <section className="grid gap-4">
            <SectionHeader eyebrow="Conclusions" title="结论时间线" />

            {overview.conclusionGroups.length > 0 ? (
              <div className="grid gap-2.5">
                {overview.conclusionGroups.map((group, index) => {
                  const activity = group.activityId
                    ? activityMetaById.get(group.activityId) ?? null
                    : null;
                  return (
                    <ConclusionGroupSection
                      key={group.activityId ?? -1}
                      group={group}
                      activity={activity}
                      index={index}
                      onSave={(conclusionId, markdown, html, promotedToProject) =>
                        conclusionUpdateMutation.mutate({
                          conclusionId,
                          markdown,
                          html,
                          promotedToProject,
                        })
                      }
                      onDelete={(conclusionId) =>
                        conclusionDeleteMutation.mutateAsync({ conclusionId })
                      }
                      activeConclusionId={activeConclusionId}
                      pendingFocusPoint={pendingConclusionFocusPoint}
                      busy={
                        conclusionUpdateMutation.isPending ||
                        conclusionDeleteMutation.isPending
                      }
                      registerActivation={registerConclusionActivation}
                      onDeactivate={clearActiveConclusion}
                      onRequestActivate={(conclusionId, focusPoint) => {
                        setPendingConclusionFocusPoint(
                          focusPoint ? { id: conclusionId, point: focusPoint } : null,
                        );
                        return requestConclusionActivation(conclusionId);
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <EmptyState text="还没有结论。" compact />
            )}
          </section>
        </div>
      </section>

      <TodoRail
        title="项目待办"
        scopeLabel={activeProject.name}
        unfinishedTodos={overview.unfinishedTodos}
        finishedTodos={overview.finishedTodos}
        activityNameById={activityNameById}
        createPlaceholder="写下一条需要推进的 Todo"
        onCreateTodo={(payload) => todoMutation.mutate({ projectId: activeProject.id, ...payload })}
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
        onDeleteTodo={(todoId) => todoDeleteMutation.mutateAsync({ todoId })}
        onOpenTodoSource={(todo) => {
          if (!todo.activityId) return;
          navigate(activityPath(activeProject.id, todo.activityId, `todo-${todo.id}`));
        }}
        onError={(message) =>
          pushToast({ tone: "error", title: "进展保存失败", detail: message })
        }
      />
    </div>
  );
}

function ConclusionGroupSection({
  group,
  activity,
  index,
  onSave,
  onDelete,
  activeConclusionId,
  pendingFocusPoint,
  busy,
  registerActivation,
  onDeactivate,
  onRequestActivate,
}: {
  group: ConclusionGroup;
  activity: ActivityDigest | null;
  index: number;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => Promise<unknown> | unknown;
  onDelete: (conclusionId: number) => Promise<unknown> | void;
  activeConclusionId: number | null;
  pendingFocusPoint: { id: number; point: { x: number; y: number } } | null;
  busy: boolean;
  registerActivation: (
    key: number,
    handler: () => Promise<boolean> | boolean,
  ) => () => void;
  onDeactivate: (key?: number) => void;
  onRequestActivate: (key: number, focusPoint?: { x: number; y: number }) => Promise<boolean>;
}) {
  const [contextMenu, setContextMenu] = useState<{
    conclusionId: number;
    x: number;
    y: number;
  } | null>(null);
  const tone = index % 2 === 0 ? "accent" : "success";
  const contextMenuConclusion = useMemo(
    () =>
      contextMenu
        ? group.conclusions.find((conclusion) => conclusion.id === contextMenu.conclusionId) ?? null
        : null,
    [contextMenu, group.conclusions],
  );

  useEffect(() => {
    if (contextMenu && !contextMenuConclusion) {
      setContextMenu(null);
    }
  }, [contextMenu, contextMenuConclusion]);

  return (
    <SurfaceCard as="article" className="grid gap-1 px-4 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0 flex flex-wrap items-center gap-2">
          {activity ? (
            activity.attributeLabel ? (
              <ActivityAttributeTag
                label={activity.attributeLabel}
                colorKey={activity.attributeColorKey ?? null}
              />
            ) : null
          ) : (
            <StatusBadge tone={tone}>project</StatusBadge>
          )}
          <h3 className="text-body font-medium leading-5 text-text">
            {group.activityTitle}
          </h3>
          <span className="text-caption text-text-soft">{group.conclusions.length} 条结论</span>
        </div>
        <span className="text-caption leading-5 text-text-soft">
          {activity ? formatOverviewDate(activity.activityTime) : ""}
        </span>
      </div>
      <div className="grid gap-0">
        {group.conclusions.map((conclusion) => (
          <InlineConclusionEditor
            key={conclusion.id}
            conclusion={conclusion}
            autoFocusTarget={
              pendingFocusPoint?.id === conclusion.id ? pendingFocusPoint.point : true
            }
            busy={busy}
            isActive={activeConclusionId === conclusion.id}
            registerActivation={registerActivation}
            onDeactivate={() => onDeactivate(conclusion.id)}
            onRequestActivate={(focusPoint) => onRequestActivate(conclusion.id, focusPoint)}
            onSave={onSave}
            onOpenContextMenu={(conclusionId, x, y) =>
              setContextMenu({ conclusionId, x, y })
            }
          />
        ))}
      </div>
      {contextMenu && contextMenuConclusion ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="结论操作"
          onClose={() => setContextMenu(null)}
          actions={[
            {
              icon: Star,
              label: contextMenuConclusion.promotedToProject
                ? "取消项目级标星"
                : "设为项目级标星",
              disabled: busy,
              onSelect: () => {
                void Promise.resolve(
                  onSave(
                    contextMenuConclusion.id,
                    contextMenuConclusion.contentMarkdown,
                    contextMenuConclusion.contentHtml,
                    !contextMenuConclusion.promotedToProject,
                  ),
                );
              },
            },
            {
              icon: Trash2,
              label: "删除",
              tone: "danger",
              disabled: busy,
              onSelect: () => {
                void Promise.resolve(onDelete(contextMenuConclusion.id));
              },
            },
          ]}
        />
      ) : null}
    </SurfaceCard>
  );
}

function InlineConclusionEditor({
  conclusion,
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
  autoFocusTarget: boolean | { x: number; y: number };
  busy: boolean;
  isActive: boolean;
  registerActivation: (
    key: number,
    handler: () => Promise<boolean> | boolean,
  ) => () => void;
  onDeactivate: () => void;
  onRequestActivate: (focusPoint?: { x: number; y: number }) => Promise<boolean>;
  onOpenContextMenu: (conclusionId: number, x: number, y: number) => void;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => Promise<unknown> | unknown;
}) {
  const [draft, setDraft] = useState<RichEditorValue>(() => buildConclusionDraft(conclusion));
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
    const initialDraft = normalizeRichEditorValue(buildConclusionDraft(conclusion));

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

    return registerActivation(conclusion.id, commitOrClose);
  }, [commitOrClose, conclusion.id, isActive, registerActivation]);

  return (
    <article
      id={`conclusion-${conclusion.id}`}
      className="border-t border-[color-mix(in_srgb,var(--color-border)_88%,transparent)] py-1.5 first:border-t-0 first:pt-0 last:pb-0"
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
          <div className={inlineObjectGuideClass(conclusion.promotedToProject)} />
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

function inlineObjectGuideClass(accented: boolean) {
  return accented ? "inline-object-guide inline-object-guide--accent" : "inline-object-guide";
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

function appendDocumentToProjectOverviewCache(
  queryClient: ReturnType<typeof useQueryClient>,
  document: DocumentRecord,
) {
  queryClient.setQueryData<ProjectOverviewData | undefined>(
    ["overview", document.projectId],
    (currentOverview) => {
      if (!currentOverview || document.activityId) {
        return currentOverview;
      }

      const alreadyExists = currentOverview.projectDocuments.some((item) => item.id === document.id);

      return {
        ...currentOverview,
        projectDocuments: alreadyExists
          ? currentOverview.projectDocuments
          : [document, ...currentOverview.projectDocuments],
      };
    },
  );
}
