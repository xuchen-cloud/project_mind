import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useFeedbackStore } from "../state/feedback-store";
import { queryKeys } from "../lib/queryKeys";
import {
  createTodoModule,
  productionTodoTransport,
  type TodoChange,
  type TodoViewScope,
} from "./todo-module";

export function useTodoModule(scope: TodoViewScope, enabled = true) {
  const queryClient = useQueryClient();
  const feedback = useFeedbackStore();
  const [cacheVersion, setCacheVersion] = useState(0);
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
  });

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          (event.type === "updated" || event.type === "added" || event.type === "removed") &&
          (queryKeyStartsWith(event.query.queryKey, queryKeys.todoCollections.all) ||
            queryKeyStartsWith(event.query.queryKey, queryKeys.projects.all))
        ) {
          setCacheVersion((version) => version + 1);
        }
      }),
    [queryClient],
  );

  const view = useMemo(
    () => module.read(scope),
    // cacheVersion intentionally represents every exact cache projection update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheVersion, module, scope.kind, scope.kind === "current-project" ? scope.projectId : null],
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
      feedback.setStatus({
        tone: "error",
        label: "Error",
        message: "Todo 更新失败",
      });
      feedback.pushToast({
        tone: "error",
        title: "Todo 更新失败",
        detail: String(error),
      });
      throw error;
    }
  }

  return {
    view,
    change,
    refresh: () => module.load(scope, { force: true }),
    refreshing: query.isFetching,
    ready: query.isSuccess,
    error: query.error,
  };
}

function queryKeyStartsWith(queryKey: readonly unknown[], prefix: readonly unknown[]) {
  return prefix.every((part, index) => Object.is(queryKey[index], part));
}
