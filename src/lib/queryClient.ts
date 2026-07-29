import { QueryClient } from "@tanstack/react-query";

export const QUERY_STALE_TIME_MS = 15_000;
export const QUERY_GC_TIME_MS = 10 * 60_000;

export function createProjectMindQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        gcTime: QUERY_GC_TIME_MS,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
