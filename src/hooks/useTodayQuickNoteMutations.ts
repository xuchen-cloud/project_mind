import { useMutation, useQueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";

export function useTodayQuickNoteMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const todayQuickNoteMutation = useMutation({
    mutationFn: projectMindApi.todayQuickNoteUpsert,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Saved", message: "今日快记已保存" });
      await queryClient.invalidateQueries({ queryKey: ["today-quick-note"] });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存今日快记失败" });
      pushToast({ tone: "error", title: "保存今日快记失败", detail: String(error) });
    },
  });

  return { todayQuickNoteMutation };
}
