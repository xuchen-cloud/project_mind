import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { noteTemplateLabel } from "../lib/note-templates";
import { projectMindApi } from "../services/projectMindApi";
import type { ActivityCardData, NoteRecord, RecordTypeSettingsSnapshot } from "../lib/types";
import { useFeedbackStore } from "../state/feedback-store";
import { refreshAll } from "./shared";

interface UseActivityMutationsOptions {
  onCreateActivitySuccess?: (activity: ActivityCardData) => void;
}

export function useActivityMutations(options: UseActivityMutationsOptions = {}) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();

  const createActivityMutation = useMutation({
    mutationFn: projectMindApi.activityCreate,
    onSuccess: async (activity) => {
      setStatus({ tone: "success", label: "Created", message: "活动已创建" });
      options.onCreateActivitySuccess?.(activity);
      await refreshAll(queryClient, activity.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "创建活动失败" });
      pushToast({ tone: "error", title: "创建活动失败", detail: String(error) });
    },
  });

  const activityMetaMutation = useMutation({
    mutationFn: projectMindApi.activityUpdateMeta,
    onSuccess: async (activity) => {
      setStatus({ tone: "success", label: "Updated", message: "活动元数据已更新" });
      await refreshAll(queryClient, activity.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "活动更新失败" });
      pushToast({ tone: "error", title: "活动更新失败", detail: String(error) });
    },
  });

  const noteMutation = useMutation({
    mutationFn: projectMindApi.noteUpsert,
    onSuccess: async (note, input) => {
      const recordTypeSettings = queryClient.getQueryData<RecordTypeSettingsSnapshot>([
        "record-type-settings",
      ]);
      setStatus({
        tone: "success",
        label: input.noteId ? "Saved" : "Created",
        message: `${noteTemplateLabel(note.noteType, recordTypeSettings)}已保存`,
      });
      upsertNoteInCache(queryClient, note);
      if (!input.noteId) {
        await refreshAll(queryClient, note.projectId);
      }
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存记录失败" });
      pushToast({ tone: "error", title: "保存记录失败", detail: String(error) });
    },
  });

  const noteDeleteMutation = useMutation({
    mutationFn: projectMindApi.noteDelete,
    onSuccess: async (note) => {
      const recordTypeSettings = queryClient.getQueryData<RecordTypeSettingsSnapshot>([
        "record-type-settings",
      ]);
      setStatus({
        tone: "success",
        label: "Deleted",
        message: `${noteTemplateLabel(note.noteType, recordTypeSettings)}已删除`,
      });
      deleteNoteFromCache(queryClient, note);
      await refreshAll(queryClient, note.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除记录失败" });
      pushToast({ tone: "error", title: "删除记录失败", detail: String(error) });
    },
  });

  const conclusionMutation = useMutation({
    mutationFn: projectMindApi.conclusionCreate,
    onSuccess: async (conclusion) => {
      setStatus({ tone: "success", label: "Saved", message: "结论已保存" });
      await refreshAll(queryClient, conclusion.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "新增结论失败" });
      pushToast({ tone: "error", title: "新增结论失败", detail: String(error) });
    },
  });

  const conclusionUpdateMutation = useMutation({
    mutationFn: projectMindApi.conclusionUpdate,
    onSuccess: async (conclusion) => {
      setStatus({ tone: "success", label: "Saved", message: "结论已更新" });
      await refreshAll(queryClient, conclusion.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "更新结论失败" });
      pushToast({ tone: "error", title: "更新结论失败", detail: String(error) });
    },
  });

  const conclusionDeleteMutation = useMutation({
    mutationFn: projectMindApi.conclusionDelete,
    onSuccess: async (conclusion) => {
      setStatus({ tone: "success", label: "Deleted", message: "结论已删除" });
      await refreshAll(queryClient, conclusion.projectId);
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除结论失败" });
      pushToast({ tone: "error", title: "删除结论失败", detail: String(error) });
    },
  });

  return {
    createActivityMutation,
    activityMetaMutation,
    noteMutation,
    noteDeleteMutation,
    conclusionMutation,
    conclusionUpdateMutation,
    conclusionDeleteMutation,
  };
}

export function upsertNoteInCache(
  queryClient: QueryClient,
  note: NoteRecord,
) {
  queryClient.setQueryData<ActivityCardData[] | undefined>(
    ["activities", note.projectId],
    (currentActivities) => {
      if (!currentActivities) {
        return currentActivities;
      }

      return currentActivities.map((activity) => {
        if (activity.id !== note.activityId) {
          return activity;
        }

        const existingIndex = activity.notes.findIndex((item) => item.id === note.id);
        const nextNotes =
          existingIndex >= 0
            ? activity.notes.map((item) => (item.id === note.id ? note : item))
            : [note, ...activity.notes];

        const sortedNotes = nextNotes.sort(
          (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );

        const nextNoteCount =
          existingIndex >= 0 ? activity.digest.noteCount : activity.digest.noteCount + 1;

        return {
          ...activity,
          notes: sortedNotes,
          updatedAt: note.updatedAt,
          digest: {
            ...activity.digest,
            noteCount: nextNoteCount,
          },
        };
      });
    },
  );
}

export function deleteNoteFromCache(
  queryClient: QueryClient,
  note: NoteRecord,
) {
  queryClient.setQueryData<ActivityCardData[] | undefined>(
    ["activities", note.projectId],
    (currentActivities) => {
      if (!currentActivities) {
        return currentActivities;
      }

      return currentActivities.map((activity) => {
        if (activity.id !== note.activityId) {
          return activity;
        }

        const nextNotes = activity.notes.filter((item) => item.id !== note.id);
        if (nextNotes.length === activity.notes.length) {
          return activity;
        }

        return {
          ...activity,
          notes: nextNotes,
          digest: {
            ...activity.digest,
            noteCount: Math.max(0, activity.digest.noteCount - 1),
          },
        };
      });
    },
  );
}
