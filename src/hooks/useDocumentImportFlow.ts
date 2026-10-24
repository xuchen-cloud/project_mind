import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DocumentImportInput, DocumentRecord, WorkspaceStatusSnapshot } from "../lib/types";
import { projectMindApi } from "../services/projectMindApi";
import { queryKeys } from "../lib/queryKeys";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";
import { RESIDENT_PROJECT_QUERY_OPTIONS } from "../lib/resident-pages";

interface UseDocumentImportFlowOptions {
  projectId: number | null;
  workspaceRoot?: string;
  enabled?: boolean;
  resident?: boolean;
  onDocumentsImported?: (documents: DocumentRecord[]) => void;
}

export function useDocumentImportFlow({
  projectId,
  workspaceRoot,
  enabled = true,
  resident = false,
  onDocumentsImported,
}: UseDocumentImportFlowOptions) {
  const queryClient = useQueryClient();
  const active = useRef(false);
  const epoch = useRef(0);
  const pendingBinding = useRef<AgentWorkspaceBinding | undefined>(undefined);
  const { pushToast, setStatus } = useFeedbackStore();
  const [pendingImportPaths, setPendingImportPaths] = useState<string[] | null>(null);
  const [pendingImportTagIds, setPendingImportTagIds] = useState<number[]>([]);
  useLayoutEffect(() => {
    active.current = enabled; epoch.current++;
    pendingBinding.current = undefined;
    setPendingImportPaths(null); setPendingImportTagIds([]);
    return () => { active.current = false; epoch.current++; };
  }, [enabled, workspaceRoot, projectId]);

  const projectTagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
    enabled,
    ...(resident ? RESIDENT_PROJECT_QUERY_OPTIONS : {}),
  });

  const importFiles = useCallback(
    async (paths: string[], tagIds: number[], binding?: AgentWorkspaceBinding) => {
      if (!active.current) {
        pushToast({
          tone: "error",
          title: "导入文件失败",
          detail: "当前上下文尚未加载完成，请稍后重试。",
        });
        return [];
      }

      const generation = epoch.current;
      try {
        const documents = await Promise.all(
          paths.map((sourcePath) => {
            const input: DocumentImportInput = { projectId, sourcePath, isStarred: false, ...(tagIds.length > 0 ? { tagIds } : {}) };
            return binding ? projectMindApi.documentImport(input, binding) : projectMindApi.documentImport(input);
          }),
        );

        if (!active.current || epoch.current !== generation) return documents;
        setStatus({
          tone: "success",
          label: "Imported",
          message:
            documents.length === 1
              ? `文件 ${documents[0].name} 已导入`
              : `已导入 ${documents.length} 个文件`,
        });

        await Promise.all([
          refreshAll(queryClient, projectId),
          queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.project(projectId) }),
        ]);

        onDocumentsImported?.(documents);
        return documents;
      } catch (error) {
        if (!active.current || epoch.current !== generation) return [];
        setStatus({ tone: "error", label: "Error", message: "导入文件失败" });
        pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
        return [];
      }
    },
    [onDocumentsImported, projectId, enabled, pushToast, queryClient, setStatus],
  );

  const requestImportPaths = useCallback(
    async (paths: string[]) => {
      if (!active.current) return [];
      const generation = epoch.current;
      let binding: AgentWorkspaceBinding | undefined;
      if (projectId === null || workspaceRoot) {
        const root = workspaceRoot ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
        if (!root) { pushToast({ tone: "error", title: "导入文件失败", detail: "工作区信息尚未就绪。" }); return []; }
        try { binding = await recordDocumentApi.bindingGet(root); }
        catch (error) { if (active.current && epoch.current === generation) pushToast({ tone: "error", title: "导入文件失败", detail: String(error) }); return []; }
      }
      if (!active.current || epoch.current !== generation) return [];
      if (paths.length === 0) {
        pushToast({
          tone: "error",
          title: "无法读取拖拽文件",
          detail: "当前拖拽源没有暴露本地路径，请改用“选择文件”导入。",
        });
        return [];
      }

      let availableTags = projectTagSettingsQuery.data?.tags ?? [];
      if (!projectTagSettingsQuery.data && !projectTagSettingsQuery.isError) {
        const result = await projectTagSettingsQuery.refetch();
        availableTags = result.data?.tags ?? [];
      }

      if (!active.current || epoch.current !== generation) return [];
      if (availableTags.length > 0) {
        pendingBinding.current = binding;
        setPendingImportPaths(paths);
        setPendingImportTagIds([]);
        return [];
      }

      return importFiles(paths, [], binding);
    },
    [projectTagSettingsQuery, importFiles, pushToast, workspaceRoot, projectId, queryClient],
  );

  const setPendingImportTagIdsDirectly = useCallback((tagIds: number[]) => {
    setPendingImportTagIds(tagIds);
  }, []);

  const closeImportTagDialog = useCallback(() => {
    setPendingImportPaths(null);
    setPendingImportTagIds([]);
  }, []);

  const confirmImportTagDialog = useCallback(async () => {
    if (!pendingImportPaths) {
      return [];
    }

    const paths = pendingImportPaths;
    const tagIds = pendingImportTagIds;
    setPendingImportPaths(null);
    setPendingImportTagIds([]);
    return importFiles(paths, tagIds, pendingBinding.current);
  }, [importFiles, pendingImportPaths, pendingImportTagIds]);

  return {
    projectTags: projectTagSettingsQuery.data?.tags ?? [],
    projectTagSettingsQuery,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag: setPendingImportTagIdsDirectly,
    setPendingImportTagIds: setPendingImportTagIdsDirectly,
    closeImportTagDialog,
    confirmImportTagDialog,
  };
}
