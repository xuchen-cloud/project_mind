import { useMemo } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import { useFeedbackStore } from "../state/feedback-store";
import { queryKeys } from "../lib/queryKeys";
import type { ProjectListItem, TodoRecord } from "../lib/types";
import {
  createTodoModule,
  isTodoRevisionConflict,
  productionTodoTransport,
  type TodoChange,
  type TodoViewScope,
} from "./todo-module";

export function useTodoModule(scope: TodoViewScope, enabled = true) {
  const queryClient = useQueryClient();
  const feedback = useFeedbackStore();
  const collectionKey = scope.kind === "workspace"
    ? queryKeys.todoCollections.workspaceRail
    : queryKeys.todoCollections.projectOwned(scope.projectId);
  // Observe the exact data we render. A cache event listener alone does not
  // retain queries: they can be garbage-collected while this rail is visible.
  const collection = useQuery<TodoRecord[]>({ queryKey: collectionKey, queryFn: skipToken });
  const projects = useQuery<ProjectListItem[]>({ queryKey: queryKeys.projects.all, queryFn: skipToken });
  const module = useMemo(
    () => createTodoModule({ queryClient, transport: productionTodoTransport }),
    [queryClient],
  );
  const query = useQuery({
    queryKey:
      scope.kind === "workspace"
        ? queryKeys.todoViews.workspace
        : queryKeys.todoViews.project(scope.projectId),
    queryFn: () => module.load(scope),
    enabled,
    // A cold page may outlive one of its derived collections in the cache.
    refetchOnMount: () => (
      queryClient.getQueryData(collectionKey) === undefined ||
      queryClient.getQueryData(queryKeys.projects.all) === undefined
    ) ? "always" : false,
  });

  const view = useMemo(
    () => module.read(scope),
    [collection.data, projects.data, query.data, module, scope.kind, scope.kind === "current-project" ? scope.projectId : null],
  );

  async function change(command: TodoChange) {
    try {
      const result = await module.change(command);
      feedback.setStatus({
        tone: "success",
        label: "Saved",
        message: "Todo 已更新",
      });
      return result;
    } catch (error) {
      const detail = isTodoRevisionConflict(error) ? "Todo 已变化，已刷新最新数据。请核对后重新操作。" : String(error);
      feedback.setStatus({
        tone: "error",
        label: "Error",
        message: "Todo 更新失败",
      });
      feedback.pushToast({
        tone: "error",
        title: "Todo 更新失败",
        detail,
      });
      throw error;
    }
  }

  return {
    view,
    change,
    refresh: () => module.load(scope, { force: true }),
    ready: query.isSuccess,
    error: query.error,
  };
}
