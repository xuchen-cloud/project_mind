import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { activityPath, projectPath } from "../../lib/formatters";
import { workspaceDayString } from "../../lib/aiArtifacts";
import { isAiFeatureReady, isAiFeatureVisible } from "../../lib/ai";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useTodayQuickNoteMutations } from "../../hooks/useTodayQuickNoteMutations";
import { useWorkspaceNoteMutations } from "../../hooks/useWorkspaceNoteMutations";
import { useTodoMutations } from "../../hooks/useTodoMutations";
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
  const today = useMemo(() => workspaceDayString(), []);
  const { pushToast } = useFeedbackStore();
  const { openSettings } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();

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
  const activityQueries = useQueries({
    queries: visibleProjects.map((project) => ({
      queryKey: ["activities", project.id],
      queryFn: () => projectMindApi.activityList({ projectId: project.id }),
      enabled: visibleProjects.length > 0,
    })),
  });
  const showTodayBrief = isAiFeatureVisible(aiSettingsQuery.data, "summary.daily_brief");
  const aiEnabled = isAiFeatureReady(aiSettingsQuery.data, "summary.daily_brief");
  const allTodos = workspaceTodosQuery.data ?? [];
  const { todayQuickNoteMutation } = useTodayQuickNoteMutations();
  const { workspaceNoteMutation, workspaceNoteDeleteMutation } = useWorkspaceNoteMutations();
  const {
    todoMutation,
    todoContentMutation,
    todoActivityMutation,
    todoDeleteMutation,
    todoPriorityMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoStatusMutation,
  } = useTodoMutations(allTodos);
  const activityOptionsByProject = useMemo(
    () =>
      new Map(
        visibleProjects.map((project, index) => [
          project.id,
          (activityQueries[index]?.data ?? []).map((activity) => ({
            id: activity.id,
            title: activity.title,
          })),
        ]),
      ),
    [activityQueries, visibleProjects],
  );

  return (
    <section className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-8">
        <h1 className="text-display font-medium tracking-tight text-text">Today</h1>

        {showTodayBrief ? (
          !projectsQuery.isLoading && visibleProjects.length === 0 ? (
            <SurfaceCard className="w-full p-4">
              <EmptyState
                compact
                title="还没有可聚合的项目"
                text="先创建项目并开始记录后，Today 的 AI 今日概览才会汇总最近变化和建议跟进。"
              />
            </SurfaceCard>
          ) : (
            <AiArtifactCard
              eyebrow="Today"
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
          onUpsertNote={(input) => todayQuickNoteMutation.mutateAsync(input)}
          onOpenInternalReference={openInternalReference}
        />

        <TodayTodoSection
          projects={visibleProjects}
          activityOptionsByProject={activityOptionsByProject}
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
          onUpdateActivity={(todoId, activityId) =>
            todoActivityMutation.mutateAsync({ todoId, activityId })
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
            if (todo.activityId) {
              navigate(activityPath(todo.projectId, todo.activityId, `todo-${todo.id}`));
              return;
            }

            navigate(projectPath(todo.projectId, `todo-${todo.id}`));
          }}
          onError={(message) => {
            pushToast({ tone: "error", title: "Todo 处理失败", detail: message });
          }}
          onOpenInternalReference={openInternalReference}
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
    </section>
  );
}
