import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "./agent-types";
import { dshAssistantApi } from "../services/dshAssistantApi";
import { recordDocumentApi } from "../services/recordDocumentApi";

export const SESSION_SUMMARIES_STALE_TIME = 15_000;

// App removes the agent namespace whenever a Workspace closes or reopens.
export function sessionSummariesBindingOptions(workspaceRoot: string) {
  return queryOptions({
    queryKey: ["agent", "session-summaries-binding", workspaceRoot] as const,
    queryFn: async ({ signal }) => {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      signal.throwIfAborted();
      return binding;
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function sessionSummariesQueryOptions(binding: AgentWorkspaceBinding, projectId: number | null) {
  return queryOptions({
    queryKey: ["agent", "session-summaries", binding.workspaceId, binding.generation, projectId] as const,
    // Keep a same-generation read reusable when navigation temporarily removes
    // the last sidebar. Native checks expectedBinding before and after its I/O.
    queryFn: () => dshAssistantApi.summaries(projectId, binding),
    staleTime: SESSION_SUMMARIES_STALE_TIME,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

const refreshes = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/** Coalesce sidebars handling the same event; later mutations replace older reads. */
export function refreshSessionSummaries(client: QueryClient, binding: AgentWorkspaceBinding, projectId: number | null) {
  const options = sessionSummariesQueryOptions(binding, projectId);
  const pending = refreshes.get(client) ?? new Map<string, Promise<void>>();
  refreshes.set(client, pending);
  const key = JSON.stringify(options.queryKey);
  const shared = pending.get(key);
  if (shared) return shared;
  const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
  if (!query) return client.fetchQuery({ ...options, staleTime: 0 }).then(() => {}, () => {});
  const refresh = (async () => {
    await client.cancelQueries({ queryKey: options.queryKey, exact: true });
    // Workspace closure removes the query while cancellation is awaiting.
    if (client.getQueryCache().find({ queryKey: options.queryKey, exact: true }) !== query) return;
    void client.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: "none" });
    // Query owns errors for sidebar retry. No unhandled event-handler rejection.
    await client.fetchQuery({ ...options, staleTime: 0 }).catch(() => {});
  })();
  pending.set(key, refresh);
  const clear = () => { if (pending.get(key) === refresh) pending.delete(key); };
  void refresh.then(clear, clear);
  return refresh;
}
