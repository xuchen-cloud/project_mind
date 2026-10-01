import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { createBusinessChangeSync, type BusinessChangeHint } from "../lib/business-change-sync";
import { agentApi } from "../services/agentApi";
import { desktopApi } from "../services/desktopApi";
import { recordDocumentApi } from "../services/recordDocumentApi";

export function useWorkspaceBusinessChanges(workspaceRoot: string | null | undefined) {
  const queryClient = useQueryClient();
  const last = useRef<{ binding: AgentWorkspaceBinding; seq: number } | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setError(null);
    if (!workspaceRoot || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let sync: ReturnType<typeof createBusinessChangeSync> | undefined;
    let starting = false;
    const report = (failure: unknown) => { if (!disposed) setError(failure); };
    const catchUp = async () => {
      if (!sync || disposed) return;
      await sync.catchUp();
      if (!disposed) setError(null);
    };
    const initialize = async () => {
      if (starting || disposed) return;
      starting = true;
      try {
        // Subscribe first, then read the log: commits racing registration cannot
        // disappear between a watermark read and the start of event listening.
        if (!unlisten) unlisten = await desktopApi.listenEvent<BusinessChangeHint>("mind:changed", hint => {
          if (!sync || disposed) return;
          if (hint.binding.workspaceId === last.current?.binding.workspaceId
            && hint.binding.generation !== last.current.binding.generation) {
            void initialize().catch(report);
          } else void sync.notify(hint).catch(report);
        });
        if (disposed) { unlisten(); return; }
        const binding = await recordDocumentApi.bindingGet(workspaceRoot);
        if (disposed) return;
        const previous = last.current;
        if (sync && previous?.binding.workspaceId === binding.workspaceId && previous.binding.generation === binding.generation) {
          await catchUp();
          return;
        }
        sync?.stop();
        const initialSeq = previous?.binding.workspaceId === binding.workspaceId && previous.binding.generation === binding.generation ? previous.seq : 0;
        last.current = { binding, seq: initialSeq };
        sync = createBusinessChangeSync({ binding, queryClient,
          initialSeq,
          readChanges: afterSeq => agentApi.businessChangesList(binding, afterSeq),
        });
        await catchUp();
      } finally { starting = false; }
    };
    const focus = () => { void initialize().catch(report); };
    window.addEventListener("focus", focus);
    void initialize().catch(report);
    return () => {
      disposed = true;
      if (sync) {
        // This cursor belongs to this generation and this window, never to
        // Workspace data or another concurrently open window.
        const previous = last.current;
        if (previous) previous.seq = sync.lastSeq();
        sync.stop();
      }
      unlisten?.();
      window.removeEventListener("focus", focus);
    };
  }, [workspaceRoot, queryClient]);
  return error;
}
