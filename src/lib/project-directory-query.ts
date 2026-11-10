import type { AgentWorkspaceBinding } from "./agent-types";
import { queryKeys } from "./queryKeys";
import type { QueryClient } from "@tanstack/react-query";

export function projectDirectoryQueryKey(rootPath: string, projectId: number | null, relativePath: string,
  workspaceRoot: string | undefined, binding: AgentWorkspaceBinding | undefined) {
  return [...queryKeys.projectDirectory(rootPath, projectId, relativePath, 0), workspaceRoot,
    ...(binding ? [binding.workspaceId, binding.generation] : [])];
}

export function matchesDirectoryQueryBinding(key: readonly unknown[], workspaceRoot: string | undefined,
  binding: AgentWorkspaceBinding | undefined) {
  return key[5] === workspaceRoot
    && (!binding || (key[6] === binding.workspaceId && key[7] === binding.generation));
}

export function directoryQueryRelativePath(key: readonly unknown[]) {
  return String(key[3]);
}

/** Reconcile a committed path change without reading its retired source. */
export async function refreshDirectoryMutation(client: QueryClient, scope: {
  rootPath: string; projectId: number | null; workspaceRoot?: string; binding?: AgentWorkspaceBinding;
}, sourcePaths: readonly string[], current: () => boolean) {
  const prefix = ["project-directory", scope.rootPath, scope.projectId];
  const pageKey = scope.projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(scope.projectId);
  const matches = (key: readonly unknown[]) => matchesDirectoryQueryBinding(key, scope.workspaceRoot, scope.binding);
  const retired = (key: readonly unknown[]) => {
    const path = directoryQueryRelativePath(key);
    return sourcePaths.some(source => path === source || path.startsWith(`${source}/`));
  };
  await Promise.allSettled([...client.getQueryCache().findAll({ queryKey: prefix, predicate: query => matches(query.queryKey) }),
    ...client.getQueryCache().findAll({ queryKey: pageKey })]
    .filter(query => query.state.fetchStatus !== "idle").map(query => query.promise));
  if (!current()) return;
  await Promise.all([
    client.invalidateQueries({ queryKey: prefix, predicate: query => matches(query.queryKey) && retired(query.queryKey), refetchType: "none" }),
    client.invalidateQueries({ queryKey: prefix, predicate: query => matches(query.queryKey) && !retired(query.queryKey) }, { cancelRefetch: false, throwOnError: true }),
    client.invalidateQueries({ queryKey: pageKey }, { cancelRefetch: false, throwOnError: true }),
  ]);
}
