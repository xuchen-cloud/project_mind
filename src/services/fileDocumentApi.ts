import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import type { FileRestoreInput, FileSourcePage, FileVersionGetResult, FileVersionPage, FileVersionMetadata, FileVersionMetadataUpdate, FileVersionMetadataUpdateResult } from "../lib/file-types";
import type { DocumentVersionCommitResult } from "../lib/types";
import { callAgentCommand } from "./agentApi";

function call<T>(command: string, binding: AgentWorkspaceBinding, data: unknown, requestId: string) {
  return callAgentCommand<T>(command, requestId, { input: { binding, requestId, data } });
}
function editableVersion(version: FileVersionMetadata, binding: AgentWorkspaceBinding, object: AgentObjectRef): FileVersionMetadata {
  return { ...version, metadataTarget: { binding, object: { ...object, scope: { ...object.scope } } } };
}
export const fileDocumentApi = {
  async versionsList(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; cursor?: number | null; limit?: number }, requestId: string = crypto.randomUUID()) {
    const frozenBinding = { ...binding };
    const result = await call<FileVersionPage>("file_versions_list", frozenBinding, data, requestId);
    return { ...result, versions: result.versions.map(version => editableVersion(version, frozenBinding, result.object)) };
  },
  async versionGet(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; versionId: string }, requestId: string = crypto.randomUUID()) {
    const frozenBinding = { ...binding };
    const result = await call<FileVersionGetResult>("file_versions_get", frozenBinding, data, requestId);
    return { ...result, version: editableVersion(result.version, frozenBinding, result.object) };
  },
  sourceRead(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; versionNumber: number; expectedContentHash?: string | null; cursor?: string | null; budgetChars?: number }, requestId: string = crypto.randomUUID()) {
    return call<FileSourcePage>("file_source_read", binding, data, requestId);
  },
  restore(binding: AgentWorkspaceBinding, data: FileRestoreInput, requestId: string) {
    return call<DocumentVersionCommitResult>("file_version_restore", binding, data, requestId);
  },
  versionMetadataUpdate(binding: AgentWorkspaceBinding, data: FileVersionMetadataUpdate, requestId: string = crypto.randomUUID()) {
    return call<FileVersionMetadataUpdateResult>("file_version_metadata_update", binding, data, requestId);
  },
};
