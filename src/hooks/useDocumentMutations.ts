import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";

export function useDocumentMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const documentImportMutation = useMutation({
    mutationFn: projectMindApi.documentImport,
    onSuccess: async (document) => {
      setStatus({ tone: "success", label: "Imported", message: `文件 ${document.name} 已导入` });
      await Promise.all([
        refreshAll(queryClient, document.projectId),
        queryClient.invalidateQueries({ queryKey: ["file-tag-settings", document.projectId] }),
      ]);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "导入文件失败" });
      pushToast({ tone: "error", title: "导入文件失败", detail: String(error) });
    },
  });

  const documentMetaMutation = useMutation({
    mutationFn: projectMindApi.documentUpdateMeta,
    onSuccess: async (document) => {
      setStatus({
        tone: "success",
        label: "Updated",
        message: `文件 ${document.baseName} 已更新`,
      });
      await Promise.all([
        refreshAll(queryClient, document.projectId),
        queryClient.invalidateQueries({ queryKey: ["file-tag-settings", document.projectId] }),
      ]);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新文件失败" });
      pushToast({ tone: "error", title: "更新文件失败", detail: String(error) });
    },
  });

  const documentRelocateMutation = useMutation({
    mutationFn: projectMindApi.documentRelocate,
    onSuccess: async (document) => {
      setStatus({
        tone: "success",
        label: "Relinked",
        message: `文件 ${document.name} 已重新定位`,
      });
      await Promise.all([
        refreshAll(queryClient, document.projectId),
        queryClient.invalidateQueries({ queryKey: ["file-tag-settings", document.projectId] }),
      ]);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "重新定位失败" });
      pushToast({ tone: "error", title: "重新定位失败", detail: String(error) });
    },
  });

  const documentAddVersionMutation = useMutation({
    mutationFn: projectMindApi.documentAddVersion,
    onSuccess: async (document) => {
      setStatus({
        tone: "success",
        label: "Versioned",
        message: `文件 ${document.baseName} 已创建 v${document.currentVersionNumber} 并打开`,
      });
      await Promise.all([
        refreshAll(queryClient, document.projectId),
        queryClient.invalidateQueries({ queryKey: ["file-tag-settings", document.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["documentVersions", document.id] }),
      ]);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "新增版本失败" });
      pushToast({ tone: "error", title: "新增版本失败", detail: String(error) });
    },
  });

  const documentDeleteMutation = useMutation({
    mutationFn: projectMindApi.documentDelete,
    onSuccess: async (document) => {
      setStatus({
        tone: "success",
        label: "Deleted",
        message: `文件 ${document.baseName} 已删除`,
      });
      await Promise.all([
        refreshAll(queryClient, document.projectId),
        queryClient.invalidateQueries({ queryKey: ["file-tag-settings", document.projectId] }),
        queryClient.invalidateQueries({ queryKey: ["documentVersions", document.id] }),
      ]);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除文件失败" });
      pushToast({ tone: "error", title: "删除文件失败", detail: String(error) });
    },
  });

  return {
    documentImportMutation,
    documentMetaMutation,
    documentRelocateMutation,
    documentAddVersionMutation,
    documentDeleteMutation,
  };
}
