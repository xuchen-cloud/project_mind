import { agentApi, AgentApiError } from "../services/agentApi";
import { desktopApi } from "../services/desktopApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "./agent-types";
import type { RecordTarget } from "./record-document-types";
import { RecordSaveFailure, type RecordSaveCoordinator } from "./record-save-coordinator";

export function isMissingRecordError(error: unknown) {
  return (error instanceof RecordSaveFailure || error instanceof AgentApiError) && error.code === "NOT_FOUND";
}

/** NOT_FOUND can refer to a referenced object too: check the actual Record before offering to discard. */
export async function discardDeletedRecordForClose(options: {
  coordinator: RecordSaveCoordinator;
  recordKey: string;
  target: RecordTarget;
  binding: AgentWorkspaceBinding | null;
  error: unknown;
  isCurrent: () => boolean;
}) {
  const { coordinator, recordKey, target, binding, error, isCurrent } = options;
  if (!binding || !isMissingRecordError(error)) throw error;
  const snapshot = coordinator.getLatestSnapshot(recordKey);
  let missing = false;
  try { await recordDocumentApi.editorGet(binding, target); }
  catch (failure) {
    if (!isMissingRecordError(failure)) throw failure;
    missing = true;
  }
  if (!missing) throw error;
  const title = snapshot?.title.trim();
  const accepted = await desktopApi.confirm(
    `原始记录已删除，无法保存${title ? `“${title}”` : "当前记录"}。关闭会丢失此页面中未保存的内容和待审阅修改。是否仍要关闭？`,
    "原始记录已删除",
  );
  if (!accepted) throw new Error("已取消关闭，当前记录内容已保留");
  // The dialog yields control: do not discard a changed draft or another Workspace's queue.
  const current = (await agentApi.statusGet()).binding;
  if (!current || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) {
    throw new Error("工作区已切换，关闭已取消");
  }
  if (!isCurrent() || coordinator.getLatestSnapshot(recordKey) !== snapshot) {
    throw new Error("记录内容已变化，请重新确认关闭");
  }
  coordinator.discard(recordKey);
}

/** Handles failed drafts whose editor was already unmounted before a window/Workspace close. */
export async function flushRecordSavesForClose(coordinator: RecordSaveCoordinator, onlyRecordKey?: string) {
  for (const recordKey of onlyRecordKey ? [onlyRecordKey] : coordinator.getPendingRecordKeys()) {
    try { await coordinator.flush(recordKey); }
    catch (error) {
      const snapshot = coordinator.getLatestSnapshot(recordKey);
      if (!snapshot) throw error;
      await discardDeletedRecordForClose({ coordinator, recordKey, error,
        binding: snapshot.canonicalBody?.binding ?? null,
        target: { recordId: snapshot.recordId, scope: snapshot.scope === "project"
          ? { kind: "project", projectId: snapshot.projectId } : { kind: "workspace" } },
        isCurrent: () => true,
      });
    }
  }
  await coordinator.flush(onlyRecordKey);
}
