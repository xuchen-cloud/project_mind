import type { QueryClient } from "@tanstack/react-query";
import type { AgentChangeEntry, AgentChangePage, AgentObjectRef, AgentScope, AgentWorkspaceBinding } from "./agent-types";
import { agentQueryKeys, agentScopeKey } from "./agent-query-keys";
import { queryKeys } from "./queryKeys";

export interface BusinessChangeHint {
  binding: AgentWorkspaceBinding;
  seq: number;
  changedRefs: AgentObjectRef[];
  resetRequired: boolean;
}
interface SyncOptions {
  binding: AgentWorkspaceBinding;
  queryClient: QueryClient;
  readChanges: (afterSeq: number) => Promise<AgentChangePage>;
  initialSeq?: number;
}
function sourceObject(entry: AgentChangeEntry, binding: AgentWorkspaceBinding): AgentObjectRef | null {
  const parts = entry.objectKey.split("/");
  if (parts.length !== 4 || parts[0] !== binding.workspaceId || parts[1] !== agentScopeKey(entry.scope)) return null;
  const kind = parts[2];
  if (!["project", "quick_note", "record", "todo", "file", "transcript", "session_summary", "session_message"].includes(kind)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[3])) return null;
  return { workspaceId: parts[0], scope: entry.scope, kind: kind as AgentObjectRef["kind"], id: parts[3] };
}
/** Each window has one serialized log consumer. Events never advance the cursor
 * on their own, so a later notification can recover any intervening lost event. */
export function createBusinessChangeSync({ binding, queryClient, readChanges, initialSeq = 0 }: SyncOptions) {
  let stopped = false;
  let cursor = initialSeq;
  let pending = false;
  let flight: Promise<void> | undefined;
  const invalidate = (key: readonly unknown[]) => {
    // Disabled Warm observers are marked dirty without fetching. Their existing
    // visible/enabled transition fetches the dirty data when shown again.
    void queryClient.invalidateQueries({ queryKey: key, refetchType: "active" });
  };
  const reset = () => { for (const key of queryKeys.workspaceScoped) invalidate(key); };
  function scopeChanged(scope: AgentScope) {
    invalidate(agentQueryKeys.scope(binding, scope));
    invalidate(scope.kind === "project" ? queryKeys.projectPage(scope.projectId) : queryKeys.workspacePage);
    void queryClient.invalidateQueries({ queryKey: queryKeys.searchAll, refetchType: "active", predicate: query =>
      query.queryKey[1] === "workspace" || (scope.kind === "project" && query.queryKey[2] === scope.projectId) });
  }
  function objectChanged(object: AgentObjectRef) {
    scopeChanged(object.scope);
    if (object.scope.kind === "project") invalidate(queryKeys.projects.all);
    if (object.kind === "file") {
      const id = Number(object.id);
      if (Number.isSafeInteger(id) && id > 0) invalidate(queryKeys.documentVersions(id));
    }
    if (object.kind === "todo" || object.kind === "project") {
      invalidate(queryKeys.todoCollections.workspaceRail);
      invalidate(queryKeys.todoViews.workspace);
      if (object.scope.kind === "project") {
        invalidate(queryKeys.todoCollections.projectOwned(object.scope.projectId));
        invalidate(queryKeys.todoViews.project(object.scope.projectId));
      } else invalidate(queryKeys.todoCollections.workspaceOwned);
    }
  }
  const catchUp = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    pending = true;
    if (flight) return flight;
    flight = (async () => {
      while (pending && !stopped) {
        pending = false;
        const page = await readChanges(cursor);
        if (stopped) return;
        if (!Number.isSafeInteger(page.cursor) || page.cursor < cursor || (page.hasMore && page.cursor === cursor)) {
          throw new Error("Business change cursor did not advance");
        }
        if (page.resetRequired) reset();
        const keys = new Set<string>();
        for (const entry of page.entries) {
          if (keys.has(entry.objectKey)) continue;
          keys.add(entry.objectKey);
          const object = sourceObject(entry, binding);
          if (object) objectChanged(object);
          else invalidate(agentQueryKeys.scope(binding, entry.scope));
        }
        cursor = page.cursor;
        pending ||= page.hasMore;
      }
    })().finally(() => {
      flight = undefined;
      if (pending && !stopped) return catchUp();
    });
    return flight;
  };
  return {
    catchUp,
    lastSeq: () => cursor,
    stop: () => { stopped = true; pending = false; },
    notify(hint: BusinessChangeHint) {
      if (stopped || hint.binding.workspaceId !== binding.workspaceId || hint.binding.generation !== binding.generation
        || !Number.isSafeInteger(hint.seq) || hint.seq <= cursor) return Promise.resolve();
      // Pull authoritative refs from the log rather than trusting an event's
      // shape or skipping earlier commits by assigning hint.seq to the cursor.
      if (hint.resetRequired) reset();
      return catchUp();
    },
  };
}
