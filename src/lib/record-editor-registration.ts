import { desktopApi } from "../services/desktopApi";
import type { AgentWorkspaceBinding } from "./agent-types";
import type { RecordTarget } from "./record-document-types";
import { recordDocumentApi } from "../services/recordDocumentApi";

export type RecordEditorFlushOutcome = "saved" | "review_pending" | "busy";
interface FlushRequest { binding: AgentWorkspaceBinding; target: RecordTarget; editorId: string; flushId: string }
export async function registerCanonicalRecordEditor(options: {
  binding: AgentWorkspaceBinding; target: RecordTarget; editorId: string;
  flush: () => Promise<RecordEditorFlushOutcome>;
}) {
  let disposed = false;
  const stop = await desktopApi.listenEvent<FlushRequest>("record:flush-request", (payload) => {
    if (disposed || payload.editorId !== options.editorId
      || payload.binding.workspaceId !== options.binding.workspaceId || payload.binding.generation !== options.binding.generation
      || payload.target.recordId !== options.target.recordId
      || JSON.stringify(payload.target.scope) !== JSON.stringify(options.target.scope)) return;
    void (async () => {
      let outcome: RecordEditorFlushOutcome;
      try { outcome = await options.flush(); } catch { outcome = "busy"; }
      if (disposed) outcome = "busy";
      await recordDocumentApi.editorFlushReply(options.binding, {
        target: options.target, editorId: options.editorId, flushId: payload.flushId, outcome,
      });
    })().catch(() => undefined);
  });
  try { await recordDocumentApi.editorRegister(options.binding, options.target, options.editorId); }
  catch (error) { disposed = true; stop(); throw error; }
  return () => {
    disposed = true;
    stop();
    void recordDocumentApi.editorUnregister(options.binding, options.target, options.editorId).catch(() => undefined);
  };
}
