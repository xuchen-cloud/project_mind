import type { AgentObjectRef, AgentWorkspaceBinding } from "./agent-types";
import { sameFileOwner } from "./file-types";
import { desktopApi } from "../services/desktopApi";
import { fileEditorApi, type FileEditorFlushOutcome } from "../services/fileEditorApi";
import { prepareContentOwnerMove } from "./project-content-lifecycle";

interface FlushRequest {
  binding: AgentWorkspaceBinding; object: AgentObjectRef; editorId: string; flushId: string; operationId: string;
}

export async function registerFileEditor(options: {
  binding: AgentWorkspaceBinding; object: AgentObjectRef; editorId: string; flush: () => Promise<void>;
}) {
  let disposed = false;
  const stop = await desktopApi.listenEvent<FlushRequest>("file:editor-flush-request", payload => {
    if (disposed || !payload.operationId || payload.editorId !== options.editorId
      || payload.binding.workspaceId !== options.binding.workspaceId || payload.binding.generation !== options.binding.generation
      || payload.object.workspaceId !== options.object.workspaceId || payload.object.kind !== "file"
      || payload.object.id !== options.object.id || !sameFileOwner(payload.object.scope, options.object.scope)) return;
    void (async () => {
      let outcome: FileEditorFlushOutcome;
      try {
        await prepareContentOwnerMove(options.binding, options.object, payload.operationId, options.flush);
        outcome = disposed ? "busy" : "saved";
      } catch (failure) {
        outcome = failure && typeof failure === "object" && "code" in failure && failure.code === "EDITOR_BUSY" ? "busy" : "failed";
      }
      await fileEditorApi.reply(options.binding, { object: options.object, editorId: options.editorId, flushId: payload.flushId, outcome });
    })().catch(() => undefined);
  });
  try { await fileEditorApi.register(options.binding, options.object, options.editorId); }
  catch (failure) { disposed = true; stop(); throw failure; }
  return () => {
    disposed = true;
    stop();
    void fileEditorApi.unregister(options.binding, options.object, options.editorId).catch(() => undefined);
  };
}
