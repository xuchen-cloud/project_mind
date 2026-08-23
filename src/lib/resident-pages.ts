export const MAX_WARM_PROJECT_SHELLS = 4;
export const MAX_RESIDENT_PROJECT_SHELLS = MAX_WARM_PROJECT_SHELLS + 1;
export const RESIDENT_PROJECT_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
} as const;

/**
 * Keeps the active project and the most recently visited warm pages resident.
 * The returned order is least-recently-used to most-recently-used.
 */
export function touchResidentProjectShell(
  residentProjectIds: readonly number[],
  projectId: number,
  openProjectIds: readonly number[],
) {
  const openIds = new Set(openProjectIds);
  openIds.add(projectId);

  return [...residentProjectIds.filter((id) => id !== projectId && openIds.has(id)), projectId].slice(
    -MAX_RESIDENT_PROJECT_SHELLS,
  );
}

export function pruneResidentProjectShells(
  residentProjectIds: readonly number[],
  openProjectIds: readonly number[],
) {
  const openIds = new Set(openProjectIds);
  return residentProjectIds.filter((id) => openIds.has(id));
}
