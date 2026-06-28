import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";
import type {
  ProjectListItem,
  ProjectPageData,
  TodoCreateInput,
  TodoRecord,
  WorkspacePageData,
} from "../lib/types";

type TodoListData = ProjectPageData | WorkspacePageData;
type TodoSnapshot = {
  projectPage?: ProjectPageData;
  workspacePage?: WorkspacePageData;
  workspaceTodos?: TodoRecord[];
  projects?: ProjectListItem[];
};

function withoutTodo(todos: TodoRecord[] | undefined, todoId: number) {
  return (todos ?? []).filter((todo) => todo.id !== todoId);
}

function mergeTodoByStatus<T extends TodoListData>(current: T | undefined, todo: TodoRecord) {
  if (!current) {
    return current;
  }

  const unfinishedTodos = current.unfinishedTodos ?? [];
  const finishedTodos = current.finishedTodos ?? [];
  const previousTodo =
    unfinishedTodos.find((item) => item.id === todo.id) ??
    finishedTodos.find((item) => item.id === todo.id);
  const baseUnfinishedTodos = withoutTodo(current.unfinishedTodos, todo.id);
  const baseFinishedTodos = withoutTodo(current.finishedTodos, todo.id);
  const nextTodo = previousTodo ? { ...previousTodo, ...todo } : todo;

  if (previousTodo?.status === nextTodo.status) {
    return {
      ...current,
      unfinishedTodos:
        nextTodo.status === "unfinished"
          ? unfinishedTodos.map((item) => (item.id === nextTodo.id ? nextTodo : item))
          : baseUnfinishedTodos,
      finishedTodos:
        nextTodo.status === "finished"
          ? finishedTodos.map((item) => (item.id === nextTodo.id ? nextTodo : item))
          : baseFinishedTodos,
    };
  }

  return {
    ...current,
    unfinishedTodos:
      nextTodo.status === "finished" ? baseUnfinishedTodos : [nextTodo, ...baseUnfinishedTodos],
    finishedTodos:
      nextTodo.status === "finished" ? [nextTodo, ...baseFinishedTodos] : baseFinishedTodos,
  };
}

function removeTodoFromListData<T extends TodoListData>(current: T | undefined, todoId: number) {
  if (!current) {
    return current;
  }

  return {
    ...current,
    unfinishedTodos: withoutTodo(current.unfinishedTodos, todoId),
    finishedTodos: withoutTodo(current.finishedTodos, todoId),
  };
}

function mergeWorkspaceTodos(current: TodoRecord[] | undefined, todo: TodoRecord) {
  if (!current) {
    return current;
  }

  const existing = current.find((item) => item.id === todo.id);
  const nextTodo = existing ? { ...existing, ...todo } : todo;
  return [nextTodo, ...current.filter((item) => item.id !== todo.id)];
}

function updateProjectOpenTodoCount(
  projects: ProjectListItem[] | undefined,
  projectId: number,
  delta: number,
) {
  if (!projects || delta === 0) {
    return projects;
  }

  return projects.map((project) =>
    project.id === projectId
      ? { ...project, openTodoCount: Math.max(0, project.openTodoCount + delta) }
      : project,
  );
}

function optimisticTodoFromInput(input: TodoCreateInput): TodoRecord {
  const now = new Date().toISOString();
  return {
    id: -Date.now(),
    projectId: input.projectId,
    content: input.content,
    status: "unfinished",
    priority: input.priority,
    tags: [],
    createdAt: now,
    updatedAt: now,
    progresses: [],
  };
}

export function useTodoMutations(allTodos?: TodoRecord[]) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  async function cancelTodoQueries(projectId: number) {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ["project-page", projectId] }),
      queryClient.cancelQueries({ queryKey: ["workspace-page"] }),
      queryClient.cancelQueries({ queryKey: ["workspace-todos"] }),
      queryClient.cancelQueries({ queryKey: ["projects", "all"] }),
    ]);
  }

  function snapshotTodoQueries(projectId: number): TodoSnapshot {
    return {
      projectPage: queryClient.getQueryData<ProjectPageData>(["project-page", projectId]),
      workspacePage: queryClient.getQueryData<WorkspacePageData>(["workspace-page"]),
      workspaceTodos: queryClient.getQueryData<TodoRecord[]>(["workspace-todos"]),
      projects: queryClient.getQueryData<ProjectListItem[]>(["projects", "all"]),
    };
  }

  function restoreTodoSnapshot(projectId: number, snapshot?: TodoSnapshot) {
    if (!snapshot) {
      return;
    }

    queryClient.setQueryData(["project-page", projectId], snapshot.projectPage);
    queryClient.setQueryData(["workspace-page"], snapshot.workspacePage);
    queryClient.setQueryData(["workspace-todos"], snapshot.workspaceTodos);
    queryClient.setQueryData(["projects", "all"], snapshot.projects);
  }

  function upsertTodoCache(todo: TodoRecord) {
    queryClient.setQueryData<ProjectPageData | undefined>(
      ["project-page", todo.projectId],
      (current) => mergeTodoByStatus(current, todo),
    );
    queryClient.setQueryData<WorkspacePageData | undefined>(
      ["workspace-page"],
      (current) => mergeTodoByStatus(current, todo),
    );
    queryClient.setQueryData<TodoRecord[] | undefined>(
      ["workspace-todos"],
      (current) => mergeWorkspaceTodos(current, todo),
    );
  }

  function removeTodoCache(todo: TodoRecord) {
    queryClient.setQueryData<ProjectPageData | undefined>(
      ["project-page", todo.projectId],
      (current) => removeTodoFromListData(current, todo.id),
    );
    queryClient.setQueryData<WorkspacePageData | undefined>(
      ["workspace-page"],
      (current) => removeTodoFromListData(current, todo.id),
    );
    queryClient.setQueryData<TodoRecord[] | undefined>(
      ["workspace-todos"],
      (current) => current?.filter((item) => item.id !== todo.id),
    );
  }

  const todoMutation = useMutation({
    mutationFn: projectMindApi.todoCreate,
    onMutate: async (variables) => {
      await cancelTodoQueries(variables.projectId);
      const snapshot = snapshotTodoQueries(variables.projectId);
      const optimisticTodo = optimisticTodoFromInput(variables);
      upsertTodoCache(optimisticTodo);
      queryClient.setQueryData<ProjectListItem[] | undefined>(
        ["projects", "all"],
        (current) => updateProjectOpenTodoCount(current, variables.projectId, 1),
      );
      return { snapshot, optimisticTodo };
    },
    onSuccess: async (todo, _variables, context) => {
      if (context?.optimisticTodo) {
        removeTodoCache(context.optimisticTodo);
      }
      upsertTodoCache(todo);
      setStatus({ tone: "success", label: "Created", message: "待办已创建" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error, variables, context) => {
      restoreTodoSnapshot(variables.projectId, context?.snapshot);
      setStatus({ tone: "error", label: "Error", message: "新增待办失败" });
      pushToast({ tone: "error", title: "新增待办失败", detail: String(error) });
    },
  });

  const todoContentMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateContent,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Saved", message: "待办内容已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办内容失败" });
      pushToast({ tone: "error", title: "更新待办内容失败", detail: String(error) });
    },
  });

  const todoStatusMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateStatus,
    onMutate: async (variables) => {
      const source = allTodos?.find((todo) => todo.id === variables.todoId);
      if (!source) {
        return undefined;
      }

      await cancelTodoQueries(source.projectId);
      const snapshot = snapshotTodoQueries(source.projectId);
      const optimisticTodo = { ...source, status: variables.status };
      const openTodoDelta =
        source.status === variables.status
          ? 0
          : variables.status === "finished"
            ? -1
            : 1;
      upsertTodoCache(optimisticTodo);
      queryClient.setQueryData<ProjectListItem[] | undefined>(
        ["projects", "all"],
        (current) => updateProjectOpenTodoCount(current, source.projectId, openTodoDelta),
      );
      return { snapshot, projectId: source.projectId };
    },
    onSuccess: async (todo) => {
      upsertTodoCache(todo);
      setStatus({
        tone: "success",
        label: todo.status === "finished" ? "Completed" : "Active",
        message: "待办状态已更新",
      });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error, _variables, context) => {
      if (context?.projectId) {
        restoreTodoSnapshot(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "更新待办失败" });
      pushToast({ tone: "error", title: "更新待办失败", detail: String(error) });
    },
  });

  const todoPriorityMutation = useMutation({
    mutationFn: projectMindApi.todoUpdatePriority,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Priority", message: "待办优先级已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办优先级失败" });
      pushToast({ tone: "error", title: "更新待办优先级失败", detail: String(error) });
    },
  });

  const todoTagMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateTags,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Tags", message: "待办标签已更新" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新待办标签失败" });
      pushToast({ tone: "error", title: "更新待办标签失败", detail: String(error) });
    },
  });

  const todoProgressMutation = useMutation({
    mutationFn: projectMindApi.todoAddProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((t) => t.id === variables.todoId);
      if (!source) return;
      setStatus({ tone: "success", label: "Updated", message: "进展已追加" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "追加进展失败" });
      pushToast({ tone: "error", title: "追加进展失败", detail: String(error) });
    },
  });

  const todoProgressUpdateMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((progress) => progress.id === variables.progressId),
      );
      if (!source) return;
      setStatus({ tone: "success", label: "Updated", message: "进展已更新" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新进展失败" });
      pushToast({ tone: "error", title: "更新进展失败", detail: String(error) });
    },
  });

  const todoProgressDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDeleteProgress,
    onSuccess: async (_, variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((progress) => progress.id === variables.progressId),
      );
      if (!source) return;
      setStatus({ tone: "success", label: "Deleted", message: "进展已删除" });
      await refreshAll(queryClient, source.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除进展失败" });
      pushToast({ tone: "error", title: "删除进展失败", detail: String(error) });
    },
  });

  const todoDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDelete,
    onSuccess: async (todo) => {
      setStatus({ tone: "success", label: "Deleted", message: "待办已删除" });
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除待办失败" });
      pushToast({ tone: "error", title: "删除待办失败", detail: String(error) });
    },
  });

  return {
    todoMutation,
    todoContentMutation,
    todoStatusMutation,
    todoPriorityMutation,
    todoTagMutation,
    todoProgressMutation,
    todoProgressUpdateMutation,
    todoProgressDeleteMutation,
    todoDeleteMutation,
  };
}
