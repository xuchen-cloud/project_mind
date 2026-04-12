import type { QueryClient } from "@tanstack/react-query";

export function refreshAll(queryClient: QueryClient, projectId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["projects", "all"] }),
    queryClient.invalidateQueries({ queryKey: ["overview", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["activities", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-todos"] }),
    queryClient.invalidateQueries({ queryKey: ["ai-artifact"] }),
  ]);
}
