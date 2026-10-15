import { useMutation, useQueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { queryKeys } from "../lib/queryKeys";

export function useWorkspaceRecordMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const workspaceRecordDeleteMutation = useMutation({
    mutationFn: projectMindApi.workspaceRecordDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "工作区记录已删除" });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除工作区记录失败" });
      pushToast({ tone: "error", title: "删除工作区记录失败", detail: String(error) });
    },
  });

  return { workspaceRecordDeleteMutation };
}
