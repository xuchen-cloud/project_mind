import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";
import type { TodoRecord } from "../lib/types";
import { createTodoQueryCache, optimisticTodoFromInput } from "./todo-query-cache";

export function useTodoMutations(allTodos?: TodoRecord[]) {
  const queryClient = useQueryClient();
  const todoCache = createTodoQueryCache(queryClient);
  const { pushToast, setStatus } = useFeedbackStore();

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
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error, variables, context) => {
      todoCache.restore(variables.projectId, context?.snapshot);
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
      await refreshAll(queryClient, todo.projectId);
    },
    onError: (error, _variables, context) => {
      if (context?.projectId) {
        todoCache.restore(context.projectId, context.snapshot);
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
