import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import type { FileRestoreInput, FileSourcePage, FileVersionGetResult, FileVersionPage } from "../lib/file-types";
import type { DocumentVersionCommitResult } from "../lib/types";
import { callAgentCommand } from "./agentApi";

function call<T>(command: string, binding: AgentWorkspaceBinding, data: unknown, requestId: string) {
  return callAgentCommand<T>(command, requestId, { input: { binding, requestId, data } });
}
export const fileDocumentApi = {
  versionsList(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; cursor?: number | null; limit?: number }, requestId: string = crypto.randomUUID()) {
    return call<FileVersionPage>("file_versions_list", binding, data, requestId);
  },
  versionGet(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; versionId: string }, requestId: string = crypto.randomUUID()) {
    return call<FileVersionGetResult>("file_versions_get", binding, data, requestId);
  },
  sourceRead(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; versionNumber: number; expectedContentHash?: string | null; cursor?: string | null; budgetChars?: number }, requestId: string = crypto.randomUUID()) {
    return call<FileSourcePage>("file_source_read", binding, data, requestId);
  },
  restore(binding: AgentWorkspaceBinding, data: FileRestoreInput, requestId: string) {
    return call<DocumentVersionCommitResult>("file_version_restore", binding, data, requestId);
  },
};
