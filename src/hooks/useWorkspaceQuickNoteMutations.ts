import { useMutation, useQueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { queryKeys } from "../lib/queryKeys";

export function useWorkspaceQuickNoteMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const workspaceQuickNoteMutation = useMutation({
    mutationFn: projectMindApi.workspaceQuickNoteUpsert,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Saved", message: "工作区 QuickNote 已保存" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存工作区 QuickNote 失败" });
      pushToast({ tone: "error", title: "保存工作区 QuickNote 失败", detail: String(error) });
    },
  });

  return { workspaceQuickNoteMutation };
}
