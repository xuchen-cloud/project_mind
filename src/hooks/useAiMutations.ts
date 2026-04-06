import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";

export function useAiMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const aiGenerateMutation = useMutation({
    mutationFn: projectMindApi.aiGenerateNoteSuggestions,
    onSuccess: async (suggestions, input) => {
      setStatus({
        tone: "success",
        label: "Generated",
        message: `AI 已生成 ${suggestions.length} 条候选项`,
      });
      await refreshAll(queryClient, input.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "AI 建议生成失败" });
      pushToast({ tone: "error", title: "AI 建议生成失败", detail: String(error) });
    },
  });

  const aiAcceptMutation = useMutation({
    mutationFn: projectMindApi.aiAcceptSuggestion,
    onSuccess: async (result) => {
      setStatus({
        tone: "success",
        label: "Accepted",
        message: `AI 建议已采纳为 ${result.entityKind}`,
      });
      await refreshAll(queryClient, result.suggestion.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "采纳建议失败" });
      pushToast({ tone: "error", title: "采纳建议失败", detail: String(error) });
    },
  });

  return { aiGenerateMutation, aiAcceptMutation };
}
