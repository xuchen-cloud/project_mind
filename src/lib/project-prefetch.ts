import { withWorkspaceBinding } from "./workspace-operation";
import type { QueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { sessionSummariesBindingOptions, sessionSummariesQueryOptions } from "./session-summaries";
import { queryKeys } from "./queryKeys";

export function prefetchProjectPageData(queryClient: QueryClient, projectId: number) {
  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectPage(projectId),
      queryFn: () => projectMindApi.projectPageGet({ projectId }),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectTags.project(projectId),
      queryFn: () => withWorkspaceBinding(queryClient, binding => projectMindApi.projectTagSettingsGet({ projectId }, binding)),
    }),
  ]);
}

const summaryPrefetches = new WeakMap<QueryClient, Promise<void>>();

/** Workspace-ready/hover work has a fixed budget and yields between scopes. */
export function scheduleSessionSummariesPrefetch(queryClient: QueryClient, workspaceRoot: string, scopes: readonly (number | null)[]) {
  const queue = [...new Set(scopes)].slice(0, 4);
  let cancelled = false;
  let cancelIdle: (() => void) | undefined;
  const schedule = () => {
    if (cancelled || !queue.length) return;
    const run = () => {
      if (cancelled) return;
      const ongoing = summaryPrefetches.get(queryClient);
      if (ongoing) { void ongoing.finally(schedule); return; }
      const projectId = queue.shift()!;
      const task = (async () => {
        const binding = await queryClient.fetchQuery(sessionSummariesBindingOptions(workspaceRoot));
        if (cancelled) return;
        await queryClient.prefetchQuery(sessionSummariesQueryOptions(binding, projectId));
      })().catch(() => {
        // Destination queries surface prefetch failures with their usual retry UI.
      });
      summaryPrefetches.set(queryClient, task);
      void task.finally(() => {
        if (summaryPrefetches.get(queryClient) === task) summaryPrefetches.delete(queryClient);
        schedule();
      });
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run);
      cancelIdle = () => cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(run, 200);
      cancelIdle = () => clearTimeout(handle);
    }
  };
  schedule();
  return () => { cancelled = true; cancelIdle?.(); };
}
