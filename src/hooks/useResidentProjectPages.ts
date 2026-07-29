import { useEffect, useState } from "react";

import {
  pruneResidentProjects,
  touchResidentProject,
} from "../lib/resident-pages";

interface ResidentProjectPagesOptions {
  activeProjectId: number | null;
  enabled: boolean;
  hasWorkspace: boolean;
  openProjectIds: number[];
}

/** Browser-like bounded page residency: one active page plus two warm pages. */
export function useResidentProjectPages({
  activeProjectId,
  enabled,
  hasWorkspace,
  openProjectIds,
}: ResidentProjectPagesOptions) {
  const [residentProjectIds, setResidentProjectIds] = useState<number[]>([]);

  useEffect(() => {
    if (!hasWorkspace || !enabled) {
      setResidentProjectIds([]);
      return;
    }

    setResidentProjectIds((current) =>
      pruneResidentProjects(current, openProjectIds),
    );
  }, [enabled, hasWorkspace, openProjectIds]);

  useEffect(() => {
    if (!hasWorkspace || !enabled || activeProjectId === null) {
      return;
    }

    setResidentProjectIds((current) =>
      touchResidentProject(current, activeProjectId, openProjectIds),
    );
  }, [activeProjectId, enabled, hasWorkspace, openProjectIds]);

  // Route changes render before effects run. Include the new active project in
  // the current render so a cold tab never produces an intermediate blank frame.
  return activeProjectId === null || !enabled || !hasWorkspace
    ? residentProjectIds
    : touchResidentProject(residentProjectIds, activeProjectId, openProjectIds);
}
