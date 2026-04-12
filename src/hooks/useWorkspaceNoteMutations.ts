import { useMutation, useQueryClient } from "@tanstack/react-query";

import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";

export function useWorkspaceNoteMutations() {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const workspaceNoteMutation = useMutation({
    mutationFn: projectMindApi.workspaceNoteUpsert,
    onSuccess: async (note, input) => {
      setStatus({
        tone: "success",
        label: input.noteId ? "Saved" : "Created",
        message: "工作区记录已保存",
      });
      await queryClient.invalidateQueries({ queryKey: ["workspace-notes"] });
      return note;
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存工作区记录失败" });
      pushToast({ tone: "error", title: "保存工作区记录失败", detail: String(error) });
    },
  });

  const workspaceNoteDeleteMutation = useMutation({
    mutationFn: projectMindApi.workspaceNoteDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "工作区记录已删除" });
      await queryClient.invalidateQueries({ queryKey: ["workspace-notes"] });
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除工作区记录失败" });
      pushToast({ tone: "error", title: "删除工作区记录失败", detail: String(error) });
    },
  });

  return { workspaceNoteMutation, workspaceNoteDeleteMutation };
}
