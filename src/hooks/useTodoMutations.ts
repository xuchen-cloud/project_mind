import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { queryKeys } from "../lib/queryKeys";
import type {
  TodoRecord,
  TodoTagUpdatePayload,
} from "../lib/types";
import { createTodoQueryCache, optimisticTodoFromInput } from "./todo-query-cache";

export function useTodoMutations(allTodos?: TodoRecord[]) {
  const queryClient = useQueryClient();
  const todoCache = createTodoQueryCache(queryClient);
  const { pushToast, setStatus } = useFeedbackStore();

  async function optimisticallyUpdateTodo(
    todoId: number,
    patch: Partial<TodoRecord>,
  ) {
    const source = allTodos?.find((todo) => todo.id === todoId);
    if (!source) {
      return undefined;
    }

    await todoCache.cancel(source.projectId);
    const snapshot = todoCache.snapshot(source.projectId);
    const optimisticTodo = { ...source, ...patch };
    todoCache.upsert(optimisticTodo);
    return { snapshot, projectId: source.projectId, source, optimisticTodo };
  }

  function invalidateTodoTagSettings(projectId: number | null | undefined) {
    return queryClient.invalidateQueries({
      queryKey:
        projectId == null
          ? queryKeys.projectTags.workspace
          : queryKeys.projectTags.project(projectId),
    });
  }

  const todoMutation = useMutation({
    mutationFn: projectMindApi.todoCreate,
    onMutate: async (variables) => {
      await todoCache.cancel(variables.projectId);
      const snapshot = todoCache.snapshot(variables.projectId);
      const optimisticTodo = optimisticTodoFromInput(variables);
      todoCache.upsert(optimisticTodo);
      todoCache.updateProjectOpenCount(variables.projectId, 1);
      return { snapshot, optimisticTodo };
    },
    onSuccess: async (todo, _variables, context) => {
      if (context?.optimisticTodo) {
        todoCache.remove(context.optimisticTodo);
      }
      todoCache.upsert(todo);
      setStatus({ tone: "success", label: "Created", message: "待办已创建" });
      await invalidateTodoTagSettings(todo.projectId);
    },
    onError: (error, variables, context) => {
      todoCache.restore(variables.projectId, context?.snapshot);
      setStatus({ tone: "error", label: "Error", message: "新增待办失败" });
      pushToast({ tone: "error", title: "新增待办失败", detail: String(error) });
    },
  });

  const todoContentMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateContent,
    onMutate: (variables) =>
      optimisticallyUpdateTodo(variables.todoId, {
        content: variables.content,
        dueDate: variables.dueDate ?? null,
      }),
    onSuccess: async (todo) => {
      todoCache.upsert(todo);
      setStatus({ tone: "success", label: "Saved", message: "待办内容已更新" });
      await invalidateTodoTagSettings(todo.projectId);
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
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

      await todoCache.cancel(source.projectId);
      const snapshot = todoCache.snapshot(source.projectId);
      const optimisticTodo = { ...source, status: variables.status };
      const openTodoDelta =
        source.status === variables.status
          ? 0
          : variables.status === "finished"
            ? -1
            : 1;
      todoCache.upsert(optimisticTodo);
      todoCache.updateProjectOpenCount(source.projectId, openTodoDelta);
      return { snapshot, projectId: source.projectId };
    },
    onSuccess: async (todo) => {
      todoCache.upsert(todo);
      setStatus({
        tone: "success",
        label: todo.status === "finished" ? "Completed" : "Active",
        message: "待办状态已更新",
      });
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "更新待办失败" });
      pushToast({ tone: "error", title: "更新待办失败", detail: String(error) });
    },
  });

  const todoPriorityMutation = useMutation({
    mutationFn: projectMindApi.todoUpdatePriority,
    onMutate: (variables) =>
      optimisticallyUpdateTodo(variables.todoId, {
        priority: variables.priority,
      }),
    onSuccess: async (todo) => {
      todoCache.upsert(todo);
      setStatus({ tone: "success", label: "Priority", message: "待办优先级已更新" });
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "更新待办优先级失败" });
      pushToast({ tone: "error", title: "更新待办优先级失败", detail: String(error) });
    },
  });

  const todoTagMutation = useMutation({
    mutationFn: ({ optimisticTags: _optimisticTags, ...input }: TodoTagUpdatePayload) =>
      projectMindApi.todoUpdateTags(input),
    onMutate: (variables) =>
      optimisticallyUpdateTodo(variables.todoId, {
        tags: variables.optimisticTags,
      }),
    onSuccess: async (todo) => {
      todoCache.upsert(todo);
      setStatus({ tone: "success", label: "Tags", message: "待办标签已更新" });
      await invalidateTodoTagSettings(todo.projectId);
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "更新待办标签失败" });
      pushToast({ tone: "error", title: "更新待办标签失败", detail: String(error) });
    },
  });

  const todoProgressMutation = useMutation({
    mutationFn: projectMindApi.todoAddProgress,
    onMutate: (variables) => {
      const source = allTodos?.find((todo) => todo.id === variables.todoId);
      if (!source) {
        return undefined;
      }
      const optimisticProgress = {
        id: -Date.now(),
        todoId: variables.todoId,
        content: variables.content,
        progressDate: variables.progressDate,
        dueDate: variables.dueDate ?? null,
        status: "unfinished" as const,
        completedAt: null,
        orderIndex: source.progresses.length,
        createdAt: new Date().toISOString(),
      };
      return optimisticallyUpdateTodo(variables.todoId, {
        progresses: [optimisticProgress, ...source.progresses],
      });
    },
    onSuccess: (progress, variables, context) => {
      const source =
        context?.optimisticTodo ??
        allTodos?.find((todo) => todo.id === variables.todoId);
      if (!source) return;
      todoCache.upsert({
        ...source,
        progresses: [
          progress,
          ...source.progresses.filter((item) => item.id >= 0),
        ],
      });
      setStatus({ tone: "success", label: "Updated", message: "进展已追加" });
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "追加进展失败" });
      pushToast({ tone: "error", title: "追加进展失败", detail: String(error) });
    },
  });

  const todoProgressUpdateMutation = useMutation({
    mutationFn: projectMindApi.todoUpdateProgress,
    onMutate: (variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((item) => item.id === variables.progressId),
      );
      if (!source) {
        return undefined;
      }
      return optimisticallyUpdateTodo(source.id, {
        progresses: source.progresses.map((progress) =>
          progress.id === variables.progressId
            ? {
                ...progress,
                content: variables.content,
                progressDate: variables.progressDate,
                dueDate: variables.dueDate ?? null,
                status: variables.status ?? progress.status,
                completedAt:
                  variables.status === "finished"
                    ? progress.completedAt ?? new Date().toISOString()
                    : variables.status === "unfinished"
                      ? null
                      : progress.completedAt,
              }
            : progress,
        ),
      });
    },
    onSuccess: (progress, variables, context) => {
      const source =
        context?.optimisticTodo ??
        allTodos?.find((todo) =>
          todo.progresses.some((item) => item.id === variables.progressId),
        );
      if (!source) return;
      todoCache.upsert({
        ...source,
        progresses: source.progresses.map((item) =>
          item.id === progress.id ? progress : item,
        ),
      });
      setStatus({ tone: "success", label: "Updated", message: "进展已更新" });
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "更新进展失败" });
      pushToast({ tone: "error", title: "更新进展失败", detail: String(error) });
    },
  });

  const todoProgressDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDeleteProgress,
    onMutate: (variables) => {
      const source = allTodos?.find((todo) =>
        todo.progresses.some((item) => item.id === variables.progressId),
      );
      if (!source) {
        return undefined;
      }
      return optimisticallyUpdateTodo(source.id, {
        progresses: source.progresses.filter(
          (progress) => progress.id !== variables.progressId,
        ),
      });
    },
    onSuccess: (progress, variables, context) => {
      const source =
        context?.optimisticTodo ??
        allTodos?.find((todo) =>
          todo.progresses.some((item) => item.id === variables.progressId),
        );
      if (!source) return;
      todoCache.upsert({
        ...source,
        progresses: source.progresses.filter((item) => item.id !== progress.id),
      });
      setStatus({ tone: "success", label: "Deleted", message: "进展已删除" });
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
      setStatus({ tone: "error", label: "Error", message: "删除进展失败" });
      pushToast({ tone: "error", title: "删除进展失败", detail: String(error) });
    },
  });

  const todoDeleteMutation = useMutation({
    mutationFn: projectMindApi.todoDelete,
    onMutate: async (variables) => {
      const source = allTodos?.find((todo) => todo.id === variables.todoId);
      if (!source) {
        return undefined;
      }

      await todoCache.cancel(source.projectId);
      const snapshot = todoCache.snapshot(source.projectId);
      todoCache.remove(source);
      todoCache.updateProjectOpenCount(
        source.projectId,
        source.status === "unfinished" ? -1 : 0,
      );
      return { snapshot, projectId: source.projectId };
    },
    onSuccess: async (todo) => {
      todoCache.remove(todo);
      setStatus({ tone: "success", label: "Deleted", message: "待办已删除" });
      await invalidateTodoTagSettings(todo.projectId);
    },
    onError: (error, _variables, context) => {
      if (context) {
        todoCache.restore(context.projectId, context.snapshot);
      }
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
