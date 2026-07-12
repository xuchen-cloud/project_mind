import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";

export function refreshAll(queryClient: QueryClient, projectId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTodos }),
    queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage }),
    queryClient.invalidateQueries({ queryKey: queryKeys.aiArtifacts }),
  ]);
}
