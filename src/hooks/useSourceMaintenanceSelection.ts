import { useEffect } from "react";
import type { AgentScope } from "../lib/agent-types";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";

let selectionTail: Promise<void> = Promise.resolve();
const hidden = () => document.visibilityState === "hidden";

/** Only the route's selected scope participates; resident/prefetched shells do
 * not run this hook. This gate does not expose source.search/read adapters. */
export function useSourceMaintenanceSelection(workspaceRoot: string | null | undefined, projectId: number | null) {
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_MIND_SOURCE_INDEXING_DEV !== "1"
      || !workspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let selecting = false;
    const select = async () => {
      if (disposed || selecting || hidden()) return;
      selecting = true;
      try {
        const binding = await recordDocumentApi.bindingGet(workspaceRoot);
        if (disposed || hidden()) return;
        const scope: AgentScope = projectId === null ? { kind: "workspace" } : { kind: "project", projectId };
        // A previous route's already-dispatched control must settle before the
        // latest selection, so delayed IPC cannot restore an older scope.
        const next = selectionTail.then(async () => {
          if (!disposed && !hidden()) await agentApi.sourceMaintenance(binding, scope, "activate");
        });
        selectionTail = next.catch(() => {});
        await next;
      } catch (error) {
        // Developer validation errors stay observable without changing product
        // UI or manufacturing an assistant/runtime availability claim.
        if (!disposed) console.error("Source maintenance selection failed", error);
      } finally { selecting = false; }
    };
    const focus = () => { void select(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    void select();
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [workspaceRoot, projectId]);
}
