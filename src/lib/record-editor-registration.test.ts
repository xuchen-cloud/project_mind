import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { registerCanonicalRecordEditor } from "./record-editor-registration";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { prepareContentOwnerMove } from "./project-content-lifecycle";

vi.mock("./project-content-lifecycle", () => ({ prepareContentOwnerMove: vi.fn(async (_binding, _source, _operation, save) => save()) }));

vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: {
  editorRegister: vi.fn(async () => null), editorUnregister: vi.fn(async () => null), editorFlushReply: vi.fn(async () => null),
} }));
const binding = { workspaceId: "workspace", generation: "open-1" };
const target = { scope: { kind: "workspace" as const }, recordId: 7 };
let deliver: (event: { payload: unknown }) => void;
const stop = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockImplementation(async (_event, listener) => {
    deliver = listener as typeof deliver;
    return stop;
  });
});
it("listens before registration, acknowledges a completed flush and unregisters on dispose", async () => {
  const flush = vi.fn(async () => "saved" as const);
  const dispose = await registerCanonicalRecordEditor({ binding, target, editorId: "a".repeat(32), flush });
  expect(vi.mocked(listen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(recordDocumentApi.editorRegister).mock.invocationCallOrder[0]);
  deliver({ payload: { binding, target, editorId: "a".repeat(32), flushId: "flush-1" } });
  await vi.waitFor(() => expect(recordDocumentApi.editorFlushReply).toHaveBeenCalledWith(binding, {
    target, editorId: "a".repeat(32), flushId: "flush-1", outcome: "saved",
  }));
  dispose();
  expect(stop).toHaveBeenCalledOnce();
  expect(recordDocumentApi.editorUnregister).toHaveBeenCalledWith(binding, target, "a".repeat(32));
});
it("does not flush for a different editor, target or Workspace generation", async () => {
  const flush = vi.fn(async () => "saved" as const);
  const dispose = await registerCanonicalRecordEditor({ binding, target, editorId: "a".repeat(32), flush });
  const request = { binding, target, editorId: "a".repeat(32), flushId: "flush-1" };
  deliver({ payload: { ...request, editorId: "b".repeat(32) } });
  deliver({ payload: { ...request, target: { ...target, recordId: 8 } } });
  deliver({ payload: { ...request, binding: { ...binding, generation: "old" } } });
  expect(flush).not.toHaveBeenCalled();
  expect(recordDocumentApi.editorFlushReply).not.toHaveBeenCalled();
  dispose();
});
it("acknowledges pending review or failed saving without reporting success", async () => {
  const flush = vi.fn().mockResolvedValueOnce("review_pending").mockRejectedValueOnce(new Error("conflict"));
  const dispose = await registerCanonicalRecordEditor({ binding, target, editorId: "a".repeat(32), flush });
  deliver({ payload: { binding, target, editorId: "a".repeat(32), flushId: "flush-1" } });
  await vi.waitFor(() => expect(recordDocumentApi.editorFlushReply).toHaveBeenCalledTimes(1));
  deliver({ payload: { binding, target, editorId: "a".repeat(32), flushId: "flush-2" } });
  await vi.waitFor(() => expect(recordDocumentApi.editorFlushReply).toHaveBeenCalledTimes(2));
  expect(vi.mocked(recordDocumentApi.editorFlushReply).mock.calls.map((call) => call[1].outcome)).toEqual(["review_pending", "busy"]);
  dispose();
});
it("holds only this Record's view until an owner move ends while ordinary flushes stay unfrozen", async () => {
  const flush = vi.fn(async () => "saved" as const);
  const dispose = await registerCanonicalRecordEditor({ binding, target, editorId: "e", flush });
  deliver({ payload: { binding, target, editorId: "e", flushId: "ordinary" } });
  await vi.waitFor(() => expect(recordDocumentApi.editorFlushReply).toHaveBeenCalledTimes(1));
  expect(prepareContentOwnerMove).not.toHaveBeenCalled();
  deliver({ payload: { binding, target, editorId: "e", flushId: "move", ownerMoveRequestId: "operation" } });
  await vi.waitFor(() => expect(recordDocumentApi.editorFlushReply).toHaveBeenCalledTimes(2));
  expect(prepareContentOwnerMove).toHaveBeenCalledExactlyOnceWith(binding,
    { workspaceId: binding.workspaceId, scope: target.scope, kind: "record", id: "7" }, "operation", flush);
  dispose();
});
