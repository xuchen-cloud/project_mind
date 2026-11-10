import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import { callAgentCommand } from "./agentApi";

export type FileEditorFlushOutcome = "saved" | "busy" | "failed";
function call(command: string, binding: AgentWorkspaceBinding, data: unknown, requestId: string) {
  return callAgentCommand<null>(command, requestId, { input: { binding, requestId, data } });
}

/** The File registry coordinates one object; it never requests a window-wide save. */
export const fileEditorApi = {
  register(binding: AgentWorkspaceBinding, object: AgentObjectRef, editorId: string, requestId = crypto.randomUUID()) {
    return call("file_editor_register", binding, { object, editorId }, requestId);
  },
  unregister(binding: AgentWorkspaceBinding, object: AgentObjectRef, editorId: string, requestId = crypto.randomUUID()) {
    return call("file_editor_unregister", binding, { object, editorId }, requestId);
  },
  flush(binding: AgentWorkspaceBinding, object: AgentObjectRef, operationId: string) {
    return call("file_editors_flush", binding, object, operationId);
  },
  release(binding: AgentWorkspaceBinding, object: AgentObjectRef, operationId: string) {
    return call("file_editors_release", binding, object, operationId);
  },
  reply(binding: AgentWorkspaceBinding, data: { object: AgentObjectRef; editorId: string; flushId: string; outcome: FileEditorFlushOutcome }, requestId = crypto.randomUUID()) {
    return call("file_editor_flush_reply", binding, data, requestId);
  },
};
