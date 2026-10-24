import { fileOwnerScope } from "../lib/file-types";
import { useEffect } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { projectFileApi } from "../services/projectFileApi";

export function fileApplicationOptions(workspaceRoot: string, projectId: number | null, fileId: number, name?: string) {
  const extension = name?.match(/\.([^.]+)$/u)?.[1]?.toLocaleLowerCase();
  return queryOptions({
    queryKey: ["file-applications", workspaceRoot, extension ? `extension:${extension}` : name ? `name:${name}` : `file:${projectId}:${fileId}`],
    queryFn: async () => {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      return projectFileApi.applications(binding, { workspaceId: binding.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId) });
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

/** Warm native handler artwork by file type before any file content is opened. */
export function usePrefetchFileApplications(workspaceRoot: string, projectId: number | null, documents: readonly { id: number; name: string }[]) {
  const client = useQueryClient();
  useEffect(() => {
    const types = new Set<string>();
    for (const document of documents) {
      const options = fileApplicationOptions(workspaceRoot, projectId, document.id, document.name);
      const type = options.queryKey[2];
      if (types.has(type)) continue;
      types.add(type);
      void client.prefetchQuery(options);
    }
  }, [client, workspaceRoot, projectId, documents]);
}
