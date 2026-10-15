import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectContentStore } from "../state/project-content-store";
import { getContentLayout } from "../lib/project-content-layout";
import { openProjectContent, manageProjectSession } from "./projectContentApi";

const mocks = vi.hoisted(() => ({ binding: vi.fn(), record: vi.fn(), file: vi.fn(), sessions: vi.fn(), start: vi.fn(), manage: vi.fn(), remove: vi.fn() }));
vi.mock("./recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: mocks.binding, editorGet: mocks.record } }));
vi.mock("./fileDocumentApi", () => ({ fileDocumentApi: { versionsList: mocks.file } }));
vi.mock("./dshAssistantApi", () => ({ dshAssistantApi: { start: mocks.start, sessions: mocks.sessions, manageSession: mocks.manage, deleteSession: mocks.remove } }));

const binding = { workspaceId: "workspace-a", generation: "one" };
const scope = { workspaceId: "workspace-a", projectId: 7 };
const input = { workspaceRoot: "/workspace", projectId: 7, object: { kind: "record" as const, id: 12, title: "caller title" } };
beforeEach(() => {
  vi.clearAllMocks();
  useProjectContentStore.setState({ layouts: {} });
  mocks.binding.mockResolvedValue(binding);
  mocks.record.mockResolvedValue({ head: { target: { scope: { kind: "project", projectId: 7 }, recordId: 12 } }, record: { id: 12, title: "Actual record" } });
  mocks.start.mockResolvedValue(undefined);
  mocks.sessions.mockResolvedValue([{ id: "session-a", title: "Actual session", running: false }]);
});
describe("authoritative project content open", () => {
  it("deduplicates concurrent opens after async authority checks and uses the actual title", async () => {
    const [first, second] = await Promise.all([openProjectContent(input), openProjectContent(input)]);
    expect(first.tabId).toBe(second.tabId);
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(1);
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs[0].object.title).toBe("Actual record");
  });
  it("rejects an unrelated Record before changing layout", async () => {
    const beforeOpen = vi.fn();
    mocks.record.mockResolvedValue({ head: { target: { scope: { kind: "project", projectId: 8 }, recordId: 12 } }, record: { id: 12 } });
    await expect(openProjectContent({ ...input, beforeOpen })).rejects.toThrow("归属");
    expect(beforeOpen).not.toHaveBeenCalled();
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  });

  it.each([
    [true, false],
    [true, undefined],
    [false, true],
    [undefined, true],
  ])("uses native voice metadata %s despite caller metadata %s", async (nativeVoice, callerVoice) => {
    mocks.record.mockResolvedValue({
      head: { target: { scope: { kind: "project", projectId: 7 }, recordId: 12 } },
      record: { id: 12, title: "Actual record", isVoice: nativeVoice },
    });
    const result = await openProjectContent({ ...input, object: { ...input.object, isVoice: callerVoice } });
    const expected = { ...input.object, title: "Actual record", ...(nativeVoice === true ? { isVoice: true } : {}) };
    expect(result.object).toEqual(expected);
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs[0].object).toEqual(expected);
    expect(Object.hasOwn(result.object, "isVoice")).toBe(nativeVoice === true);
  });

  it("discards caller voice metadata for File and Session results", async () => {
    mocks.file.mockResolvedValue({ object: { workspaceId: binding.workspaceId,
      scope: { kind: "project", projectId: 7 }, kind: "file", id: "31" }, versions: [{ name: "Actual file" }] });
    const file = await openProjectContent({ ...input, object: { kind: "file", id: 31, title: "File", isVoice: true } });
    const session = await openProjectContent({ ...input, object: { kind: "session", id: "session-a", title: "Session", isVoice: true } });
    expect(file.object).toEqual({ kind: "file", id: 31, title: "Actual file" });
    expect(session.object).toEqual({ kind: "session", id: "session-a", title: "Actual session" });
  });
  it("rejects a late response from an older Workspace generation", async () => {
    mocks.binding.mockResolvedValueOnce(binding).mockResolvedValueOnce({ ...binding, generation: "two" });
    await expect(openProjectContent(input)).rejects.toThrow("工作区已切换");
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  });
  it("rejects an already stale reference binding before loading the object", async () => {
    await expect(openProjectContent({ ...input, expectedBinding: { ...binding, generation: "old" } })).rejects.toThrow("工作区已切换");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  });
  it("cancels an outstanding navigation before mutating the layout", async () => {
    const controller = new AbortController();
    mocks.record.mockImplementation(async () => { controller.abort(); return { head: { target: { scope: { kind: "project", projectId: 7 }, recordId: 12 } }, record: { id: 12 } }; });
    await expect(openProjectContent({ ...input, signal: controller.signal })).rejects.toThrow("取消");
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  });
  it("normalizes numeric File identities and keeps an existing pinned view on ordinary open", async () => {
    mocks.file.mockResolvedValue({ object: { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 7 }, kind: "file", id: "31" }, versions: [{ name: "File", versionNumber: 1 }], currentVersionNumber: 1 });
    const file = { ...input, object: { kind: "file" as const, id: "31", title: "File" }, view: { versionNumber: 1, line: 4 } };
    await openProjectContent(file);
    await openProjectContent({ ...file, object: { ...file.object, id: 31 }, view: undefined });
    const layout = getContentLayout(useProjectContentStore.getState(), scope);
    expect(layout.panes).toHaveLength(1);
    expect(layout.tabs).toHaveLength(1);
    expect(layout.tabs[0].view).toEqual({ versionNumber: 1, line: 4 });
  });
  it("does not create or substitute an unknown Session", async () => {
    await expect(openProjectContent({ ...input, object: { kind: "session", id: "missing", title: "Session" } })).rejects.toThrow("会话");
    expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  });
});


it("renames open session tabs with the accepted title without changing selection", async () => {
  const store = useProjectContentStore.getState();
  const tab = store.open(scope, { kind: "session", id: "session-a", title: "Old" });
  const other = store.open(scope, { kind: "session", id: "other", title: "Other" });
  await manageProjectSession({ workspaceRoot: "/workspace", projectId: 7, sessionId: "session-a", action: { kind: "rename", title: "requested" } });
  const layout = getContentLayout(useProjectContentStore.getState(), scope);
  expect(layout.tabs.find(item => item.id === tab)?.object.title).toBe("Actual session");
  expect(layout.panes[0].selectedTabId).toBe(other);
});

it.each(["archive", "delete"] as const)("closes only the %s target's project content", async kind => {
  const store = useProjectContentStore.getState();
  store.open(scope, { kind: "session", id: "session-a", title: "Chat" });
  store.open({ ...scope, projectId: 8 }, { kind: "session", id: "session-a", title: "Other project" });
  await manageProjectSession({ workspaceRoot: "/workspace", projectId: 7, sessionId: "session-a", action: { kind } });
  expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(0);
  expect(getContentLayout(useProjectContentStore.getState(), { ...scope, projectId: 8 }).tabs).toHaveLength(1);
});

it("does not mutate new-workspace tabs after a delayed session operation crosses the binding", async () => {
  useProjectContentStore.getState().open(scope, { kind: "session", id: "session-a", title: "Old" });
  mocks.binding.mockResolvedValueOnce(binding).mockResolvedValueOnce({ ...binding, generation: "new" });
  await expect(manageProjectSession({ workspaceRoot: "/workspace", projectId: 7, sessionId: "session-a", action: { kind: "archive" } })).rejects.toThrow("工作区已切换");
  expect(getContentLayout(useProjectContentStore.getState(), scope).tabs).toHaveLength(1);
});
