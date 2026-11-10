import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentApiError, callAgentCommand } from "./agentApi";
import { recordDocumentApi } from "./recordDocumentApi";
import { registerProjectContentCloseGuard } from "../lib/project-content-lifecycle";
import { fixtureEditorState } from "../test/recordDocumentFixture";
import { moveContentOwner } from "./contentOwnerMoveApi";
import { desktopApi } from "./desktopApi";
import { fileEditorApi } from "./fileEditorApi";

vi.mock("./agentApi", async original => ({ ...await original<typeof import("./agentApi")>(), callAgentCommand: vi.fn() }));
vi.mock("./recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(), editorsFlush: vi.fn() } }));
vi.mock("./desktopApi", () => ({ desktopApi: { fileCommand: vi.fn() } }));
vi.mock("./fileEditorApi", () => ({ fileEditorApi: { flush: vi.fn(async () => null), release: vi.fn(async () => null) } }));
const binding = { workspaceId: "w", generation: "g" };
const source = { scope: { kind: "project" as const, projectId: 2 }, recordId: 7 };
const destination = { kind: "project" as const, projectId: 3 };
const input = { workspaceRoot: "/workspace", binding, sourceProjectId: 2, destinationProjectId: 3, object: { kind: "record" as const, id: 7 } };
const state = fixtureEditorState(source, { id: 7, projectId: 2, title: "记录", contentMarkdown: "正文", contentHtml: "<p>正文</p>", tags: [], defaultCodeLanguage: null, createdAt: "now", updatedAt: "now" });
const result = { logicalId: "a".repeat(32), source, target: { scope: destination, recordId: 99 }, operationId: "request", headRevision: 3, bodyHash: "saved", metadataRevision: "metadata" };
let stops: (() => void)[] = [];
beforeEach(() => { vi.resetAllMocks(); vi.mocked(fileEditorApi.flush).mockResolvedValue(null); vi.mocked(fileEditorApi.release).mockResolvedValue(null); vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding); vi.mocked(recordDocumentApi.editorsFlush).mockResolvedValue(state); vi.mocked(callAgentCommand).mockResolvedValue(result); });
afterEach(() => { stops.forEach(stop => stop()); stops = []; });
it("captures only the selected Record then submits the saved native baseline before closing its source page", async () => {
  const events: string[] = [];
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2, prepare: async target => { expect(target).toEqual(input.object); events.push("save"); }, closeMoved: async () => { events.push("close"); } }));
  vi.mocked(recordDocumentApi.editorsFlush).mockImplementation(async (_binding, target) => { expect(events).toEqual(["save"]); expect(target).toEqual(source); events.push("baseline"); return state; });
  vi.mocked(callAgentCommand).mockImplementation(async (command, requestId, args) => {
    expect(command).toBe("record_owner_move"); expect(events).toEqual(["save", "baseline"]);
    expect(args).toEqual({ input: { binding, requestId, data: { source, destination, headRevision: state.head.headRevision, bodyHash: state.head.projection.bodyHash, metadataRevision: state.metadata.revision } } });
    // Native receipts have their own durable ID; ApiResponse echoes requestId.
    events.push("move"); return { ...result, operationId: "e".repeat(32) };
  });
  await moveContentOwner(input);
  expect(events).toEqual(["save", "baseline", "move", "close"]);
});
it("does not submit or close when this object's save fails", async () => {
  const closeMoved = vi.fn();
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2, prepare: async () => { throw new Error("保存失败"); }, closeMoved }));
  await expect(moveContentOwner(input)).rejects.toThrow("保存失败");
  expect(callAgentCommand).not.toHaveBeenCalled(); expect(closeMoved).not.toHaveBeenCalled();
});
it("does not close on a native ownership rejection", async () => {
  const closeMoved = vi.fn();
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2, prepare: async () => {}, closeMoved }));
  vi.mocked(callAgentCommand).mockRejectedValue(new AgentApiError({ code: "PERMISSION_DENIED", message: "目标无权限", retryable: false }));
  await expect(moveContentOwner(input)).rejects.toThrow("目标无权限");
  expect(callAgentCommand).toHaveBeenCalledOnce(); expect(closeMoved).not.toHaveBeenCalled();
});
it("reads the saved File's native working baseline without opening or archiving it, then releases only its old session", async () => {
  const events: string[] = [];
  const moved = vi.fn();
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2,
    prepare: async target => { expect(target).toEqual({ kind: "file", id: 7 }); events.push("save"); },
    moved, closeMoved: async () => { events.push("close"); } }));
  const baseline = { expectedVersion: 4, expectedWorkingRevision: 9, expectedHash: "saved-working-hash" };
  vi.mocked(fileEditorApi.flush).mockImplementation(async (_binding, object, operationId) => {
    expect(object).toEqual({ workspaceId: "w", scope: source.scope, kind: "file", id: "7" });
    expect(operationId).toEqual(expect.any(String)); events.push("all-target-editors-saved"); return null;
  });
  vi.mocked(desktopApi.fileCommand).mockImplementation(async (command, args) => {
    if (command === "file_owner_move_baseline") {
      expect(events).toEqual(["save", "all-target-editors-saved"]); expect(args).toEqual({ binding, documentId: 7, sourceOwner: 2 });
      events.push("baseline"); return baseline;
    }
    expect(command).toBe("file_owner_move");
    expect(args).toEqual({ binding, requestId: expect.any(String), input: { documentId: 7, sourceOwner: 2, targetOwner: 3, ...baseline } });
    events.push("move"); return { documentId: 7, projectId: 3, managedPath: "/workspace/projects/3/files/a.md", operationId: args.requestId, sourceScope: source.scope, targetScope: destination, oldSessionsClosed: true };
  });
  await moveContentOwner({ ...input, object: { kind: "file", id: 7 } });
  expect(events).toEqual(["save", "all-target-editors-saved", "baseline", "move", "close"]);
  expect(moved).toHaveBeenCalledExactlyOnceWith({ kind: "file", id: 7 }, true);
});
it("cancels before baseline or move when another editor of this File fails to save", async () => {
  vi.mocked(fileEditorApi.flush).mockRejectedValueOnce(new Error("另一窗口保存失败"));
  const closeMoved = vi.fn();
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2, prepare: async () => {}, closeMoved }));
  await expect(moveContentOwner({ ...input, object: { kind: "file", id: 7 } })).rejects.toThrow("另一窗口保存失败");
  expect(desktopApi.fileCommand).not.toHaveBeenCalled(); expect(closeMoved).not.toHaveBeenCalled();
  expect(fileEditorApi.release).toHaveBeenCalledWith(binding, expect.objectContaining({ kind: "file", id: "7" }), expect.any(String));
});
it("releases the same File seal on a baseline failure and preserves its native diagnostic", async () => {
  const failure = { code: "SOURCE_NOT_READY", message: "文件需恢复", details: { reason: "pending_journal" } };
  vi.mocked(desktopApi.fileCommand).mockRejectedValue(failure);
  await expect(moveContentOwner({ ...input, object: { kind: "file", id: 7 } })).rejects.toMatchObject(failure);
  expect(desktopApi.fileCommand).toHaveBeenCalledOnce();
  expect(fileEditorApi.release).toHaveBeenCalledExactlyOnceWith(binding,
    { workspaceId: "w", scope: source.scope, kind: "file", id: "7" }, vi.mocked(fileEditorApi.flush).mock.calls[0][2]);
});
it("confirms a lost Record move response with the identical native request instead of saving and moving again", async () => {
  const prepare = vi.fn(async () => {}), closeMoved = vi.fn(async () => {});
  stops.push(registerProjectContentCloseGuard({ workspaceRoot: input.workspaceRoot, projectId: 2, prepare, closeMoved }));
  let calls = 0;
  vi.mocked(callAgentCommand).mockImplementation(async (_command, requestId) => {
    if (++calls === 1) throw new Error("IPC response was lost");
    return { ...result, operationId: "e".repeat(32) };
  });
  await moveContentOwner(input);
  expect(callAgentCommand).toHaveBeenCalledTimes(2);
  expect(vi.mocked(callAgentCommand).mock.calls[0]).toEqual(vi.mocked(callAgentCommand).mock.calls[1]);
  expect(prepare).toHaveBeenCalledOnce(); expect(recordDocumentApi.editorsFlush).toHaveBeenCalledOnce(); expect(closeMoved).toHaveBeenCalledOnce();
});
