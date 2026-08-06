import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";

export function refreshAll(queryClient: QueryClient, projectId?: number | null) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.todoCollections.workspaceRail }),
    queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage }),
    queryClient.invalidateQueries({ queryKey: queryKeys.aiArtifacts }),
  ];

  if (projectId != null) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) }),
    );
  }

  return Promise.all(invalidations);
}
