import { callAgentCommand } from "./agentApi";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type {
  RecordBodySaveInput, RecordCheckpointInput, RecordCheckpointResult, RecordEditorSaveResult,
  RecordEditorState, RecordMetadata, RecordMetadataUpdate, RecordTarget, RecordVersion,
  RecordVersionCapacity, RecordVersionPage,
} from "../lib/record-document-types";
import type { RecordVersionDifference } from "../lib/record-version-compare";

function call<T>(command: string, binding: AgentWorkspaceBinding, data: unknown, requestId: string) {
  return callAgentCommand<T>(command, requestId, { input: { binding, requestId, data } });
}
export const recordDocumentApi = {
  editorGet(binding: AgentWorkspaceBinding, target: RecordTarget, requestId = crypto.randomUUID()) {
    return call<RecordEditorState>("record_editor_get", binding, target, requestId);
  },
  bodySave(binding: AgentWorkspaceBinding, data: RecordBodySaveInput, requestId: string) {
    return call<RecordEditorSaveResult>("record_body_save", binding, data, requestId);
  },
  metadataUpdate(binding: AgentWorkspaceBinding, data: RecordMetadataUpdate, requestId: string) {
    return call<RecordMetadata>("record_metadata_update", binding, data, requestId);
  },
  checkpoint(binding: AgentWorkspaceBinding, data: RecordCheckpointInput, requestId = crypto.randomUUID()) {
    return call<RecordCheckpointResult>("record_checkpoint", binding, data, requestId);
  },
  versionsList(binding: AgentWorkspaceBinding, target: RecordTarget, before: number | null = null, limit = 50, requestId = crypto.randomUUID()) {
    return call<RecordVersionPage>("record_versions_list", binding, { target, before, limit }, requestId);
  },
  versionGet(binding: AgentWorkspaceBinding, target: RecordTarget, versionId: string, requestId = crypto.randomUUID()) {
    return call<RecordVersion>("record_version_get", binding, { target, versionId }, requestId);
  },
  versionsCompare(binding: AgentWorkspaceBinding, target: RecordTarget, beforeVersionId: string, afterVersionId: string, requestId = crypto.randomUUID()) {
    return call<RecordVersionDifference>("record_versions_compare", binding, { target, beforeVersionId, afterVersionId }, requestId);
  },
  capacity(binding: AgentWorkspaceBinding, target: RecordTarget, requestId = crypto.randomUUID()) {
    return call<RecordVersionCapacity>("record_version_capacity", binding, target, requestId);
  },
};
