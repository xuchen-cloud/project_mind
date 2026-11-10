import { useLayoutEffect, useRef, useState } from "react";

import {
  MAX_RESIDENT_PROJECT_SHELLS,
  pruneResidentProjectShells,
  touchResidentProjectShell,
} from "../lib/resident-pages";

interface ResidentProjectShellsOptions {
  activeProjectId: number | null;
  enabled: boolean;
  hasWorkspace: boolean;
  openProjectIds: number[];
  workspaceKey?: string | null;
  prepareEviction?: (projectId: number) => Promise<void>;
}

/** Keep an Overview mounted until its QuickNote has crossed the save barrier. */
export function useResidentProjectShells({ activeProjectId, enabled, hasWorkspace, openProjectIds,
  workspaceKey, prepareEviction }: ResidentProjectShellsOptions) {
  const [resident, setResident] = useState<{ key: typeof workspaceKey; ids: number[] }>({ key: workspaceKey, ids: [] });
  const current = resident.key === workspaceKey ? resident.ids : [];
  const open = pruneResidentProjectShells(current, openProjectIds);
  const ordered = !enabled || !hasWorkspace ? [] : activeProjectId === null ? open
    : prepareEviction ? [...open.filter(id => id !== activeProjectId), activeProjectId]
      : touchResidentProjectShell(current, activeProjectId, openProjectIds);
  const membership = ordered.join(",");
  const latest = useRef({ ordered, workspaceKey, activeProjectId });
  latest.current = { ordered, workspaceKey, activeProjectId };

  useLayoutEffect(() => {
    setResident(previous => previous.key === workspaceKey && previous.ids.join(",") === membership
      ? previous : { key: workspaceKey, ids: ordered });
  }, [membership, workspaceKey]);

  useLayoutEffect(() => {
    if (!prepareEviction || ordered.length <= MAX_RESIDENT_PROJECT_SHELLS) return;
    let cancelled = false;
    const candidates = ordered.filter(id => id !== activeProjectId);
    void (async () => {
      for (const id of candidates) {
        if (cancelled || latest.current.ordered.length <= MAX_RESIDENT_PROJECT_SHELLS) break;
        try { await prepareEviction(id); }
        catch { continue; } // The page retains its editor and draft for retry.
        if (cancelled || latest.current.workspaceKey !== workspaceKey || latest.current.activeProjectId === id) return;
        setResident(previous => previous.key === workspaceKey
          ? { ...previous, ids: previous.ids.filter(candidate => candidate !== id) } : previous);
        // Wait for the removal render before selecting another eviction.
        return;
      }
    })();
    return () => { cancelled = true; };
  }, [membership, activeProjectId, workspaceKey, prepareEviction]);

  return ordered;
}
