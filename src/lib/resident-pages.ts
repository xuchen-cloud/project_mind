export const MAX_WARM_PROJECT_OVERVIEWS = 4;
export const MAX_RESIDENT_PROJECT_OVERVIEWS = MAX_WARM_PROJECT_OVERVIEWS + 1;

/**
 * Keeps the active project and the most recently visited warm pages resident.
 * The returned order is least-recently-used to most-recently-used.
 */
export function touchResidentProject(
  residentProjectIds: readonly number[],
  projectId: number,
  openProjectIds: readonly number[],
) {
  const openIds = new Set(openProjectIds);
  openIds.add(projectId);

  return [...residentProjectIds.filter((id) => id !== projectId && openIds.has(id)), projectId].slice(
    -MAX_RESIDENT_PROJECT_OVERVIEWS,
  );
}

export function pruneResidentProjects(
  residentProjectIds: readonly number[],
  openProjectIds: readonly number[],
) {
  const openIds = new Set(openProjectIds);
  return residentProjectIds.filter((id) => openIds.has(id));
}
