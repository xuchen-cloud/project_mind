import { useLayoutEffect, useState } from "react";

import {
  pruneResidentProjectShells,
  touchResidentProjectShell,
} from "../lib/resident-pages";

interface ResidentProjectShellsOptions {
  activeProjectId: number | null;
  enabled: boolean;
  hasWorkspace: boolean;
  openProjectIds: number[];
}

/** Browser-like bounded Project residency: one Active shell plus four Warm shells. */
export function useResidentProjectShells({
  activeProjectId,
  enabled,
  hasWorkspace,
  openProjectIds,
}: ResidentProjectShellsOptions) {
  const [residentProjectIds, setResidentProjectIds] = useState<number[]>([]);

  useLayoutEffect(() => {
    if (!hasWorkspace || !enabled) {
      setResidentProjectIds([]);
      return;
    }

    setResidentProjectIds((current) =>
      pruneResidentProjectShells(current, openProjectIds),
    );
  }, [enabled, hasWorkspace, openProjectIds]);

  useLayoutEffect(() => {
    if (!hasWorkspace || !enabled || activeProjectId === null) {
      return;
    }

    setResidentProjectIds((current) =>
      touchResidentProjectShell(current, activeProjectId, openProjectIds),
    );
  }, [activeProjectId, enabled, hasWorkspace, openProjectIds]);

  // Route changes render before effects run. Include the new active project in
  // the current render so a cold tab never produces an intermediate blank frame.
  return activeProjectId === null || !enabled || !hasWorkspace
    ? residentProjectIds
    : touchResidentProjectShell(residentProjectIds, activeProjectId, openProjectIds);
}
