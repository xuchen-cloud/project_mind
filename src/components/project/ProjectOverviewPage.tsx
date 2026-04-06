import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, MoreHorizontal, Plus, Share2 } from "lucide-react";

import type {
  ActivityAttributeOption,
  ActivityCreateInput,
  ActivityDigest,
  ConclusionGroup,
  ConclusionRecord,
} from "../../lib/types";
import { activityAttributeLabel } from "../../lib/constants";
import {
  formatOverviewDate,
  parseRouteId,
  activityPath,
  roundToHalfHourLocal,
} from "../../lib/formatters";
import { useActivityMutations } from "../../hooks/useActivityMutations";
import { useProjectMutations } from "../../hooks/useProjectMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { useFocusTarget } from "../../hooks/useUtilityHooks";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import {
  Button,
  EmptyState,
  IconButton,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
  TextField,
} from "../../ui/components";
import {
  getRenderableRichTextHtml,
  RichEditor,
  type RichEditorValue,
} from "../rich-editor";
import { ProjectSidebar, type ProjectSidebarActivityItem } from "../layout/ProjectSidebar";
import { TodoRail } from "../todo";
import { ManagedDocumentSection } from "../document/ManagedDocumentSection";

export function ProjectOverviewPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const projectId = parseRouteId(params.projectId);
  const focusId = searchParams.get("focus");

  const {
    createActivityOpen,
    setCreateActivityOpen,
    openSettings,
  } = useUiStore();
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
  const activitySettingsQuery = useQuery({
    queryKey: ["activity-settings"],
    queryFn: projectMindApi.activitySettingsGet,
  });

  const { summaryMutation, archiveMutation } = useProjectMutations(visibleProjects, (path) =>
    navigate(path),
  );
  const { createActivityMutation, conclusionUpdateMutation } = useActivityMutations();
  const { todoMutation, todoContentMutation, todoStatusMutation, todoProgressMutation } =
    useTodoMutations([
      ...(overviewQuery.data?.unfinishedTodos ?? []),
      ...(overviewQuery.data?.finishedTodos ?? []),
    ]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");

  useEffect(() => {
    if (activeProject) {
      setSummaryDraft(activeProject.summary);
      setSummaryEditing(false);
    }
  }, [activeProject?.id, activeProject?.summary]);

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
  const sidebarActivities = useMemo<ProjectSidebarActivityItem[]>(
    () =>
      overview?.activityFeed.map((activity) => ({
        id: activity.id,
        title: activity.title,
        activityTime: activity.activityTime,
        attributeLabel: activity.attributeLabel,
        documentCount: activity.documentCount,
        completedTodoCount: activity.completedTodoCount,
        totalTodoCount: activity.totalTodoCount,
        statusLabel: activity.statusLabel,
        statusNeedsAttention: activity.statusNeedsAttention,
      })) ?? [],
    [overview?.activityFeed],
  );

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
      <ProjectSidebar
        project={{
          name: activeProject.name,
          rootPath: activeProject.rootPath,
          isArchived: activeProject.isArchived,
        }}
        activities={sidebarActivities}
        onOpenProject={() => navigate(`/projects/${activeProject.id}`)}
        onOpenActivity={(activityId) => navigate(activityPath(activeProject.id, activityId))}
      />

      <section className="min-h-0 flex-1 overflow-y-auto bg-bg">
        <div className="border-b border-border px-8 py-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-display font-medium tracking-tight text-text">
                  {activeProject.name}
                </h1>
                {activeProject.isArchived ? (
                  <StatusBadge tone="neutral">archived</StatusBadge>
                ) : null}
              </div>
              <div className="mt-2 flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-soft">
                <span className="truncate" title={activeProject.rootPath}>
                  项目目录：{activeProject.rootPath}
                </span>
                <button
                  type="button"
                  className="shrink-0 bg-transparent text-ui text-text-soft transition-colors hover:text-text"
                  onClick={() => {
                    void desktopApi.openFolder(activeProject.rootPath).catch((error) => {
                      pushToast({
                        tone: "error",
                        title: "打开项目目录失败",
                        detail: String(error),
                      });
                    });
                  }}
                >
                  在资源管理器中打开项目目录
                </button>
              </div>

              {summaryEditing ? (
                <div className="mt-4 max-w-3xl">
                  <textarea
                    value={summaryDraft}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                    rows={4}
                    className="w-full rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 text-body leading-6 text-text outline-none transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        summaryMutation.mutate({
                          projectId: activeProject.id,
                          summary: summaryDraft,
                          status: activeProject.status,
                        });
                        setSummaryEditing(false);
                      }}
                    >
                      保存
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSummaryDraft(activeProject.summary);
                        setSummaryEditing(false);
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-3 max-w-3xl rounded-[var(--radius-8)] bg-transparent p-0 text-left text-body leading-6 text-text-muted transition-colors hover:text-text"
                  onClick={() => setSummaryEditing(true)}
                >
                  {activeProject.summary || "点击添加项目简介，说明当前阶段、目标和关键约束。"}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                leadingIcon={<Plus size={14} />}
                onClick={() => setCreateActivityOpen(!createActivityOpen)}
              >
                新增 Activity
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
        </div>

        <div className="grid gap-8 px-8 py-6">
          {createActivityOpen ? (
            <CreateActivityPanel
              projectId={activeProject.id}
              attributeOptions={activitySettingsQuery.data?.activityAttributeOptions ?? []}
              onOpenSettings={() => openSettings("activity")}
              onSubmit={(input) => createActivityMutation.mutate(input)}
            />
          ) : null}

          <section className="grid gap-3">
            <ManagedDocumentSection
              projectId={activeProject.id}
              projectRootPath={activeProject.rootPath}
              documents={overview.projectDocuments}
              layout="grid"
              importButtonLabel="导入文件"
              emptyText="还没有文件。"
            />
          </section>

          <section className="grid gap-4">
            <SectionHeader eyebrow="Conclusions" title="结论时间线" />

            {overview.conclusionGroups.length > 0 ? (
              <div className="grid gap-3">
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
        onUpdateContent={(todoId, content) =>
          todoContentMutation.mutateAsync({ todoId, content })
        }
        onAddProgress={(todoId, payload) =>
          todoProgressMutation.mutateAsync({ todoId, ...payload })
        }
        onError={(message) =>
          pushToast({ tone: "error", title: "进展保存失败", detail: message })
        }
      />
    </div>
  );
}

function CreateActivityPanel({
  projectId,
  attributeOptions,
  onOpenSettings,
  onSubmit,
}: {
  projectId: number;
  attributeOptions: ActivityAttributeOption[];
  onOpenSettings: () => void;
  onSubmit: (input: ActivityCreateInput) => void;
}) {
  const [attributeOptionId, setAttributeOptionId] = useState("");
  const [title, setTitle] = useState("");
  const [activityTime, setActivityTime] = useState(roundToHalfHourLocal());

  return (
    <SurfaceCard subtle className="grid gap-3 p-3">
      <label className="grid gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui font-medium text-text-muted">活动属性</span>
          <button
            type="button"
            className="bg-transparent text-ui text-text-soft transition-colors hover:text-text"
            onClick={onOpenSettings}
          >
            管理属性
          </button>
        </div>
        <select
          value={attributeOptionId}
          onChange={(event) => setAttributeOptionId(event.target.value)}
          className="h-8 rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
        >
          <option value="">不设置属性</option>
          {attributeOptions.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-ui font-medium text-text-muted">标题</span>
        <TextField
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：法务确认 / 方案评审"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-ui font-medium text-text-muted">时间</span>
        <TextField
          type="datetime-local"
          value={activityTime}
          onChange={(event) => setActivityTime(event.target.value)}
        />
      </label>
      <Button
        type="button"
        variant="primary"
        block
        leadingIcon={<Plus size={14} />}
        onClick={() =>
          onSubmit({
            projectId,
            attributeOptionId: attributeOptionId ? Number(attributeOptionId) : undefined,
            title,
            activityTime: new Date(activityTime).toISOString(),
          })
        }
      >
        创建并进入记录
      </Button>
    </SurfaceCard>
  );
}

function ConclusionGroupSection({
  group,
  activity,
  index,
  onSave,
}: {
  group: ConclusionGroup;
  activity: ActivityDigest | null;
  index: number;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => void;
}) {
  const tone =
    activity?.statusNeedsAttention
      ? "warning"
      : index % 2 === 0
        ? "accent"
        : "success";

  return (
    <SurfaceCard as="article" className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={tone}>
              {activity ? activityAttributeLabel(activity.attributeLabel) : "project"}
            </StatusBadge>
            <span className="text-caption text-text-soft">{group.conclusions.length} 条结论</span>
          </div>
          <h3 className="mt-1 line-clamp-1 text-body font-medium leading-5 text-text">
            {group.activityTitle}
          </h3>
        </div>
        <span className="text-caption leading-5 text-text-soft">
          {activity ? formatOverviewDate(activity.activityTime) : ""}
        </span>
      </div>
      <div className="grid gap-0">
        {group.conclusions.map((conclusion) => (
          <div
            key={conclusion.id}
            className="border-t border-border py-2 first:border-t-0 first:pt-0 last:pb-0"
          >
            <InlineConclusionEditor conclusion={conclusion} onSave={onSave} />
          </div>
        ))}
      </div>
    </SurfaceCard>
  );
}

function InlineConclusionEditor({
  conclusion,
  onSave,
}: {
  conclusion: ConclusionRecord;
  onSave: (
    conclusionId: number,
    markdown: string,
    html: string,
    promotedToProject: boolean,
  ) => void;
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
    <div id={`conclusion-${conclusion.id}`} className="grid gap-2">
      {editing ? (
        <div className="grid gap-2">
          <div className="rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 transition-[border-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus-within:border-accent">
            <RichEditor
              html={draft.html}
              variant="bare"
              placeholder="记录已确认的判断、共识或决定。"
              onChange={setDraft}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
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
              onClick={() => {
                onSave(
                  conclusion.id,
                  draft.markdown,
                  draft.html,
                  conclusion.promotedToProject,
                );
                setEditing(false);
              }}
            >
              保存修改
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
          <div className="min-w-0">
            <RichEditor html={renderableHtml} variant="bare" readOnly />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="justify-self-start px-2 text-caption sm:justify-self-end"
            onClick={() => setEditing(true)}
          >
            编辑
          </Button>
        </div>
      )}
    </div>
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
