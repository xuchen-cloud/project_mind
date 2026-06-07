import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DocumentRecord } from "../lib/types";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { useUiStore } from "../state/ui-store";
import { refreshAll } from "./shared";

interface UseDocumentImportFlowOptions {
  projectId: number | null;
  onDocumentsImported?: (documents: DocumentRecord[]) => void;
}

export function useDocumentImportFlow({
  projectId,
  onDocumentsImported,
}: UseDocumentImportFlowOptions) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const openSettings = useUiStore((state) => state.openSettings);
  const [pendingImportPaths, setPendingImportPaths] = useState<string[] | null>(null);
  const [pendingImportTagIds, setPendingImportTagIds] = useState<number[]>([]);

  const fileTagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings"],
    queryFn: projectMindApi.fileTagSettingsGet,
  });

  const importFiles = useCallback(
    async (paths: string[], tagIds: number[]) => {
      if (!projectId) {
        pushToast({
          tone: "error",
          title: "导入文件失败",
          detail: "当前上下文尚未加载完成，请稍后重试。",
        });
        return [];
      }

      try {
        const documents = await Promise.all(
          paths.map((sourcePath) =>
            projectMindApi.documentImport({
              projectId,
              sourcePath,
              isStarred: false,
              ...(tagIds.length > 0 ? { tagIds } : {}),
            }),
          ),
        );

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
          queryClient.invalidateQueries({ queryKey: ["file-tag-settings"] }),
        ]);

        onDocumentsImported?.(documents);
        return documents;
      } catch (error) {
        setStatus({ tone: "error", label: "Error", message: "导入文件失败" });
        pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
        return [];
      }
    },
    [onDocumentsImported, projectId, pushToast, queryClient, setStatus],
  );

  const requestImportPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        pushToast({
          tone: "error",
          title: "无法读取拖拽文件",
          detail: "当前拖拽源没有暴露本地路径，请改用“选择文件”导入。",
        });
        return [];
      }

      let availableTags = fileTagSettingsQuery.data?.tags ?? [];
      if (!fileTagSettingsQuery.data && !fileTagSettingsQuery.isError) {
        const result = await fileTagSettingsQuery.refetch();
        availableTags = result.data?.tags ?? [];
      }

      if (availableTags.length > 0) {
        setPendingImportPaths(paths);
        setPendingImportTagIds([]);
        return [];
      }

      return importFiles(paths, []);
    },
    [fileTagSettingsQuery, importFiles, pushToast],
  );

  const togglePendingImportTag = useCallback((tagId: number) => {
    setPendingImportTagIds((current) =>
      current.includes(tagId)
        ? current.filter((value) => value !== tagId)
        : [...current, tagId],
    );
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
    return importFiles(paths, tagIds);
  }, [importFiles, pendingImportPaths, pendingImportTagIds]);

  const manageImportTags = useCallback(() => {
    closeImportTagDialog();
    openSettings("file-tags");
  }, [closeImportTagDialog, openSettings]);

  return {
    fileTags: fileTagSettingsQuery.data?.tags ?? [],
    fileTagSettingsQuery,
    pendingImportPaths,
    pendingImportTagIds,
    requestImportPaths,
    togglePendingImportTag,
    closeImportTagDialog,
    confirmImportTagDialog,
    manageImportTags,
  };
}
