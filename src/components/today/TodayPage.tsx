import { useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FolderKanban, LayoutPanelTop, PanelLeftClose, StretchHorizontal } from "lucide-react";

import { projectPath } from "../../lib/formatters";
import { workspaceDayString } from "../../lib/aiArtifacts";
import { isAiFeatureReady, isAiFeatureVisible } from "../../lib/ai";
import { renderMarkdownToHtml, richTextHtmlToPlainText } from "../../lib/richTextContent";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useTodayQuickNoteMutations } from "../../hooks/useTodayQuickNoteMutations";
import { useWorkspaceNoteMutations } from "../../hooks/useWorkspaceNoteMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
import { refreshAll } from "../../hooks/shared";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { EmptyState, SurfaceCard } from "../../ui/components";
import { AiArtifactCard } from "../ai/AiArtifactCard";
import { TodayQuickNotePanel } from "./TodayQuickNotePanel";
import { TodayTodoSection } from "./TodayTodoSection";
import { WorkspaceNotesPanel } from "./WorkspaceNotesPanel";

export function TodayPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = useMemo(() => workspaceDayString(), []);
  const { pushToast } = useFeedbackStore();
  const { openSettings, overviewPageWidth, setOverviewPageWidth } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
  });
  const workspaceTodosQuery = useQuery({
    queryKey: ["workspace-todos"],
    queryFn: projectMindApi.workspaceTodoList,
  });
  const todayQuickNoteQuery = useQuery({
    queryKey: ["today-quick-note"],
    queryFn: projectMindApi.todayQuickNoteGet,
  });
  const workspaceNotesQuery = useQuery({
    queryKey: ["workspace-notes"],
    queryFn: projectMindApi.workspaceNoteList,
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const showTodayBrief = isAiFeatureVisible(aiSettingsQuery.data, "summary.daily_brief");
  const aiEnabled = isAiFeatureReady(aiSettingsQuery.data, "summary.daily_brief");
  const allTodos = workspaceTodosQuery.data ?? [];
  const { todayQuickNoteMutation } = useTodayQuickNoteMutations();
  const { workspaceNoteMutation, workspaceNoteDeleteMutation } = useWorkspaceNoteMutations();
  const appendSelectionToProjectNoteMutation = useMutation({
    mutationFn: async (input: {
      projectId: number;
      selection: { markdown: string };
    }) => {
      const project = visibleProjects.find((item) => item.id === input.projectId);

      if (!project) {
        throw new Error("目标项目不存在");
      }

      const nextMarkdown = appendMarkdownBlock(project.summaryMarkdown || project.summary, input.selection.markdown);
      const nextHtml = renderMarkdownToHtml(nextMarkdown);

      return projectMindApi.projectUpdateSummary({
        projectId: project.id,
        summary: richTextHtmlToPlainText(nextHtml, { preserveStructure: true }),
        summaryMarkdown: nextMarkdown,
        summaryHtml: nextHtml,
        status: project.status,
      });
    },
    onSuccess: async (project) => {
      pushToast({ tone: "success", title: "已追加到项目默认笔记", detail: project.name });
      await refreshAll(queryClient, project.id);
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "追加项目笔记失败", detail: String(error) });
    },
  });
  const {
    todoMutation,
    todoContentMutation,
    todoDeleteMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoStatusMutation,
  } = useTodoMutations(allTodos);
  const overviewWidthClass =
    overviewPageWidth === "full"
      ? "max-w-none"
      : overviewPageWidth === "wide"
        ? "max-w-[88rem]"
        : "max-w-6xl";

  return (
    <section className="h-full overflow-y-auto bg-bg">
      <div className={`mx-auto flex w-full ${overviewWidthClass} min-w-0 gap-6 px-6 py-6`}>
        <aside className="hidden w-72 shrink-0 lg:block">
          <SurfaceCard className="sticky top-6 grid gap-4 p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-8)] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent">
                <FolderKanban size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  Overview
                </p>
                <h1 className="truncate text-title font-medium text-text">总览</h1>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <WidthButton
                active={overviewPageWidth === "auto"}
                icon={<PanelLeftClose size={14} />}
                label="自适应"
                onClick={() => setOverviewPageWidth("auto")}
              />
              <WidthButton
                active={overviewPageWidth === "wide"}
                icon={<LayoutPanelTop size={14} />}
                label="宽"
                onClick={() => setOverviewPageWidth("wide")}
              />
              <WidthButton
                active={overviewPageWidth === "full"}
                icon={<StretchHorizontal size={14} />}
                label="全宽"
                onClick={() => setOverviewPageWidth("full")}
              />
            </div>

            <div className="grid gap-2">
              <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                Projects
              </p>
              {visibleProjects.length > 0 ? (
                visibleProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="rounded-[var(--radius-8)] border border-transparent bg-transparent px-3 py-2 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border hover:bg-bg hover:text-text"
                    onClick={() => navigate(projectPath(project.id))}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-body font-medium text-text">{project.name}</p>
                      <span className="text-ui text-text-soft">{project.openTodoCount}</span>
                    </div>
                    <p className="mt-1 text-ui text-text-soft">
                      {project.openTodoCount} 个待办
                    </p>
                  </button>
                ))
              ) : (
                <EmptyState compact text="还没有项目。" />
              )}
            </div>
          </SurfaceCard>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="grid gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
                  Overview
                </p>
                <h1 className="text-display font-medium tracking-tight text-text">总览</h1>
              </div>
            </div>

            {showTodayBrief ? (
              !projectsQuery.isLoading && visibleProjects.length === 0 ? (
                <SurfaceCard className="w-full p-4">
                  <EmptyState
                    compact
                    title="还没有可聚合的项目"
                    text="先创建项目并开始记录后，总览中的 AI 今日概览才会汇总最近变化和建议跟进。"
                  />
                </SurfaceCard>
              ) : (
                <AiArtifactCard
                  eyebrow="Overview"
                  title="今日概览"
                  description="汇总整个工作区当前最值得优先处理的事项、最近活动变化和建议跟进行动。"
                  input={{ kind: "daily_brief", artifactDate: today }}
                  aiEnabled={aiEnabled}
                />
              )
            ) : null}

            <TodayQuickNotePanel
              note={todayQuickNoteQuery.data ?? null}
              saving={todayQuickNoteMutation.isPending}
              projects={visibleProjects}
              onUpsertNote={(input) => todayQuickNoteMutation.mutateAsync(input)}
              onAppendSelectionToProjectNote={(input) =>
                appendSelectionToProjectNoteMutation.mutateAsync(input)
              }
              onOpenInternalReference={openInternalReference}
            />

            <TodayTodoSection
              projects={visibleProjects}
              todos={allTodos}
              onOpenProject={(projectId) => {
                navigate(projectPath(projectId));
              }}
              onCreateTodo={(payload) => todoMutation.mutate(payload)}
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
              onUpdateProgress={(progressId, payload) =>
                todoProgressUpdateMutation.mutateAsync({ progressId, ...payload })
              }
              onDeleteProgress={(progressId) =>
                todoProgressDeleteMutation.mutateAsync({ progressId })
              }
              onDeleteTodo={(todoId) => todoDeleteMutation.mutateAsync({ todoId })}
              onOpenTodoSource={(todo) => {
                navigate(projectPath(todo.projectId, `todo-${todo.id}`));
              }}
              onError={(message) => {
                pushToast({ tone: "error", title: "Todo 处理失败", detail: message });
              }}
              onOpenInternalReference={openInternalReference}
              onOpenContactMention={openContactMention}
            />

            <WorkspaceNotesPanel
              notes={workspaceNotesQuery.data ?? []}
              saving={workspaceNoteMutation.isPending}
              deletingNote={workspaceNoteDeleteMutation.isPending}
              aiSettings={aiSettingsQuery.data}
              onUpsertNote={(input) => workspaceNoteMutation.mutateAsync(input)}
              onDeleteNote={(noteId) => workspaceNoteDeleteMutation.mutateAsync({ noteId })}
              onOpenAiSettings={() => openSettings("ai")}
              onOpenInternalReference={openInternalReference}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function appendMarkdownBlock(existingMarkdown: string | undefined, markdownToAppend: string) {
  const existing = existingMarkdown?.trim() ?? "";
  const addition = markdownToAppend.trim();

  if (!existing) {
    return addition;
  }

  if (!addition) {
    return existing;
  }

  return `${existing}\n\n${addition}`;
}

function WidthButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        "inline-flex items-center gap-1.5 rounded-[var(--radius-6)] border px-2.5 py-1.5 text-ui font-medium transition-[background-color,color,border-color] duration-[160ms] ease-[var(--ease-soft)]",
        active
          ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
          : "border-border text-text-soft hover:border-border-strong hover:bg-bg hover:text-text",
      ].join(" ")}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
