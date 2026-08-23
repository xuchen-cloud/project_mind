import type { QueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { queryKeys } from "./queryKeys";

export function prefetchProjectPageData(queryClient: QueryClient, projectId: number) {
  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectPage(projectId),
      queryFn: () => projectMindApi.projectPageGet({ projectId }),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.projectTags.project(projectId),
      queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
    }),
  ]);
}
