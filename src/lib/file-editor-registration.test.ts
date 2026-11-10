import { beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../services/desktopApi";
import { fileEditorApi } from "../services/fileEditorApi";
import { registerFileEditor } from "./file-editor-registration";
import { prepareContentOwnerMove } from "./project-content-lifecycle";

vi.mock("../services/desktopApi", () => ({ desktopApi: { listenEvent: vi.fn() } }));
vi.mock("../services/fileEditorApi", () => ({ fileEditorApi: {
  register: vi.fn(async () => null), unregister: vi.fn(async () => null), reply: vi.fn(async () => null),
} }));
vi.mock("./project-content-lifecycle", () => ({ prepareContentOwnerMove: vi.fn(async (_binding, _source, _operation, save) => save()) }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const request = { binding, object, editorId: "e", flushId: "f", operationId: "move" };
let deliver: (payload: typeof request) => void;
const stop = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktopApi.listenEvent).mockImplementation(async (_name, listener) => { deliver = listener; return stop; });
});
it("locks and saves this File before acknowledging, then unregisters the original identity on disposal", async () => {
  const flush = vi.fn(async () => {});
  const dispose = await registerFileEditor({ binding, object, editorId: "e", flush });
  deliver(request);
  await vi.waitFor(() => expect(fileEditorApi.reply).toHaveBeenCalledWith(binding, { object, editorId: "e", flushId: "f", outcome: "saved" }));
  expect(prepareContentOwnerMove).toHaveBeenCalledWith(binding, object, "move", expect.any(Function));
  expect(flush).toHaveBeenCalledOnce();
  dispose();
  expect(stop).toHaveBeenCalledOnce();
  expect(fileEditorApi.unregister).toHaveBeenCalledWith(binding, object, "e");
});
it("ignores another kind, scope, editor, or Workspace generation with the same numeric ID", async () => {
  const flush = vi.fn(async () => {});
  const dispose = await registerFileEditor({ binding, object, editorId: "e", flush });
  for (const other of [
    { ...request, object: { ...object, kind: "record" } },
    { ...request, object: { ...object, scope: { kind: "workspace" } } },
    { ...request, editorId: "other" },
    { ...request, binding: { ...binding, generation: "old" } },
  ]) deliver(other as typeof request);
  expect(flush).not.toHaveBeenCalled(); expect(fileEditorApi.reply).not.toHaveBeenCalled();
  dispose();
});
it("replies failure when capture or save fails and never claims a completed save after disposal", async () => {
  let reject!: (error: Error) => void;
  const flush = vi.fn(() => new Promise<void>((_done, fail) => { reject = fail; }));
  const dispose = await registerFileEditor({ binding, object, editorId: "e", flush });
  deliver(request);
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  dispose(); reject(new Error("保存失败"));
  await vi.waitFor(() => expect(fileEditorApi.reply).toHaveBeenCalledWith(binding, { object, editorId: "e", flushId: "f", outcome: "failed" }));
});
it("reports an editor that is still loading as busy without claiming its content was saved", async () => {
  const dispose = await registerFileEditor({ binding, object, editorId: "e", flush: async () => { throw { code: "EDITOR_BUSY" }; } });
  deliver(request);
  await vi.waitFor(() => expect(fileEditorApi.reply).toHaveBeenCalledWith(binding, { object, editorId: "e", flushId: "f", outcome: "busy" }));
  dispose();
});
