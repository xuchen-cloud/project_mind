import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectFilePreviewLayer } from "./ProjectFilePreviewLayer";
import { openProjectFilePreview, useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { projectFileApi } from "../../services/projectFileApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { openProjectContent, PROJECT_CONTENT_OPEN_EVENT } from "../../services/projectContentApi";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import type { AgentSourceRef } from "../../lib/agent-types";
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { resolveReference: vi.fn(), preview: vi.fn(), open: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { register: vi.fn(), readBytes: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
const binding = { workspaceId: "fixture-workspace", generation: "open-1" };
const scope = { workspaceId: binding.workspaceId, projectId: 7 };
const object = { workspaceId: binding.workspaceId, scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" };
const registered = { object, relativePath: "notes/context.txt", name: "context.txt", versionNumber: 3, contentHash: "sha256:current", state: "ready" as const, reason: null };
const layout = () => getContentLayout(useProjectContentStore.getState(), scope);
beforeEach(() => {
  vi.resetAllMocks(); useProjectFileNavigation.setState({ request: null, revisions: {} }); useProjectContentStore.setState({ layouts: {} });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectDirectoryApi.resolveReference).mockResolvedValue("notes/context.txt");
  vi.mocked(projectFileApi.register).mockResolvedValue(registered);
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: registered.contentHash,
    versions: [{ id: "version-3", versionNumber: 3, name: "context.txt", createdAt: "now", contentHash: registered.contentHash, isCurrent: true }], nextCursor: null });
});
it("resolves and registers an assistant absolute link before revealing a unified File Tab", async () => {
  const revealed = vi.fn(); window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed);
  try {
    render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
    act(() => openProjectFilePreview(7, "/actual/project/notes/context.txt", 3));
    await waitFor(() => expect(revealed).toHaveBeenCalledOnce());
    expect(projectDirectoryApi.resolveReference).toHaveBeenCalledWith(7, "/actual/project/notes/context.txt");
    expect(projectFileApi.register).toHaveBeenCalledWith(binding, 7, "notes/context.txt");
    expect(fileDocumentApi.versionsList).toHaveBeenCalledWith(binding, { object, limit: 1 });
    expect(layout().tabs).toHaveLength(1); expect(layout().tabs[0]).toMatchObject({ object: { kind: "file", id: 51 }, view: { line: 3 } });
    expect((revealed.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ scope, tabId: layout().tabs[0].id });
    expect(projectDirectoryApi.preview).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
    expect(useProjectFileNavigation.getState().request).toBeNull();
  } finally { window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed); }
});
it("discards a path resolution from the previous project before registering or revealing its file", async () => {
  let resolve!: (path: string) => void;
  vi.mocked(projectDirectoryApi.resolveReference).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt")); await waitFor(() => expect(resolve).toBeTypeOf("function"));
  view.rerender(<ProjectFilePreviewLayer currentProjectId={8} workspaceRoot="/tmp/workspace" />);
  await act(async () => resolve("old-project-secret.txt"));
  expect(projectFileApi.register).not.toHaveBeenCalled(); expect(fileDocumentApi.versionsList).not.toHaveBeenCalled();
  expect(layout().tabs).toHaveLength(0); expect(screen.queryByRole("dialog")).toBeNull(); expect(useProjectFileNavigation.getState().request).toBeNull();
});
it("surfaces refusal for outside links while preserving the request for explicit dismissal", async () => {
  vi.mocked(projectDirectoryApi.resolveReference).mockRejectedValue(new Error("文件引用位于当前项目目录之外"));
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "/outside/secret.txt"));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前项目目录之外");
  expect(projectFileApi.register).not.toHaveBeenCalled(); expect(layout().tabs).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "关闭对话框" })); expect(useProjectFileNavigation.getState().request).toBeNull();
});
it("locates the same pinned File Tab from an assistant path without inventing history or moving it", async () => {
  const first = await openProjectContent({ workspaceRoot: "/tmp/workspace", projectId: 7, object: { kind: "file", id: 51, title: "context.txt" }, view: { versionNumber: 1, line: 20 } });
  useProjectContentStore.getState().split(scope);
  useProjectContentStore.getState().focus(scope, "left");
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt", 4));
  await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
  expect(layout().tabs).toHaveLength(1); expect(layout().tabs[0]).toMatchObject({ id: first.tabId, view: { versionNumber: 1, line: 4 } });
  expect(layout().panes.find(pane => pane.id === "right")?.selectedTabId).toBe(first.tabId); expect(layout().focusedPaneId).toBe("right");
});
it("retains an explicit unavailable identity and never creates a substitute File Tab", async () => {
  vi.mocked(projectFileApi.register).mockResolvedValue({ ...registered, state: "ambiguous", reason: "文件身份需要用户核对" });
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt"));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件身份需要用户核对");
  expect(fileDocumentApi.versionsList).not.toHaveBeenCalled(); expect(layout().tabs).toHaveLength(0);
});
it("rejects a completed registration when its Workspace generation has expired", async () => {
  let resolve!: (file: typeof registered) => void;
  vi.mocked(projectFileApi.register).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt")); await waitFor(() => expect(resolve).toBeTypeOf("function"));
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "open-2" });
  await act(async () => resolve(registered));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换"); expect(layout().tabs).toHaveLength(0);
});
it("opens a Session-origin file in the existing single pane without creating a split", async () => {
  useProjectContentStore.getState().open(scope, { kind: "session", id: "origin-session", title: "来源会话" });
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt", 3, "origin-session"));
  await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
  expect(layout().panes).toHaveLength(1); expect(layout().tabs).toHaveLength(2);
  const file = layout().tabs.find(tab => tab.object.kind === "file")!;
  expect(layout().panes[0].selectedTabId).toBe(file.id); expect(file.view).toEqual({ line: 3 });
});
it("opens a new Session-origin file in the other existing pane even when the origin pane has focus", async () => {
  useProjectContentStore.getState().open(scope, { kind: "session", id: "origin-session", title: "来源会话" });
  useProjectContentStore.getState().open(scope, { kind: "record", id: 9, title: "记录" });
  useProjectContentStore.getState().split(scope); useProjectContentStore.getState().focus(scope, "left");
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt", 3, "origin-session"));
  await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
  const file = layout().tabs.find(tab => tab.object.kind === "file")!;
  const left = layout().panes.find(pane => pane.id === "left")!; const right = layout().panes.find(pane => pane.id === "right")!;
  expect(layout().panes).toHaveLength(2); expect(right.selectedTabId).toBe(file.id);
  expect(layout().tabs.find(tab => tab.id === left.selectedTabId)?.object.id).toBe("origin-session");
});
it("focuses an already-open pinned File without moving it out of the origin Session pane", async () => {
  const file = await openProjectContent({ workspaceRoot: "/tmp/workspace", projectId: 7, object: { kind: "file", id: 51, title: "context.txt" }, view: { versionNumber: 1, line: 20 } });
  const originId = useProjectContentStore.getState().open(scope, { kind: "session", id: "origin-session", title: "来源会话" });
  useProjectContentStore.getState().split(scope); useProjectContentStore.getState().move(scope, file.tabId, "right");
  useProjectContentStore.getState().focus(scope, "left"); useProjectContentStore.getState().open(scope, { kind: "record", id: 9, title: "记录" });
  useProjectContentStore.getState().select(scope, "right", originId);
  render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
  act(() => openProjectFilePreview(7, "notes/context.txt", 5, "origin-session"));
  await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
  expect(layout().tabs.filter(tab => tab.object.kind === "file")).toEqual([expect.objectContaining({ id: file.tabId, view: { versionNumber: 1, line: 5 } })]);
  expect(layout().panes.find(pane => pane.id === "right")?.selectedTabId).toBe(file.tabId);
  expect(layout().panes.find(pane => pane.id === "left")?.tabIds).not.toContain(file.tabId);
  expect(layout().focusedPaneId).toBe("right");
});

const fixedSource: AgentSourceRef = {
  object, revision: "sha256:cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4",
  fileVersion: 2, recordVersion: null, blockId: null,
  locator: { kind: "line", start: 4, end: 6 }, title: "old-name.txt", excerpt: "old",
};
it("opens a fixed reference after its old path was renamed using exact historical bytes in the same File Tab", async () => {
  const first = await openProjectContent({ workspaceRoot: "/tmp/workspace", projectId: 7,
    object: { kind: "file", id: 51, title: "renamed.txt" }, view: { versionNumber: 3 } });
  useProjectContentStore.getState().split(scope);
  useProjectContentStore.getState().focus(scope, "left");
  // The old path is gone; resolving it would refuse the request. Fixed evidence uses identity instead.
  vi.mocked(projectDirectoryApi.resolveReference).mockRejectedValue(new Error("旧路径已改名"));
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2,
    contentHash: fixedSource.revision, name: "old-name.txt", mime: "text/plain", byteLength: 3, base64: btoa("old") });
  const revealed = vi.fn(); window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed);
  try {
    render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
    act(() => openProjectFilePreview(7, "obsolete/old-name.txt", 99, undefined, fixedSource));
    await waitFor(() => expect(useProjectFileNavigation.getState().request).toBeNull());
    expect(projectFileApi.readBytes).toHaveBeenCalledExactlyOnceWith(binding,
      { object, versionNumber: 2, expectedContentHash: fixedSource.revision });
    expect(projectDirectoryApi.resolveReference).not.toHaveBeenCalled();
    expect(projectFileApi.register).not.toHaveBeenCalled();
    expect(layout().tabs).toEqual([expect.objectContaining({ id: first.tabId, view: expect.objectContaining({ versionNumber: 2, line: 4, sourceLocator: fixedSource.locator }) })]);
    expect(layout().panes.find(pane => pane.id === "right")?.selectedTabId).toBe(first.tabId);
    expect(layout().focusedPaneId).toBe("right");
    expect(revealed).toHaveBeenCalledOnce();
    expect((revealed.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ tabId: first.tabId, view: expect.objectContaining({ versionNumber: 2, line: 4, sourceLocator: fixedSource.locator }) });
  } finally { window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed); }
});
it("refuses a missing fixed snapshot without falling back to the current path or revealing another File", async () => {
  const first = await openProjectContent({ workspaceRoot: "/tmp/workspace", projectId: 7,
    object: { kind: "file", id: 51, title: "current.txt" }, view: { versionNumber: 3, line: 10 } });
  vi.mocked(fileDocumentApi.versionsList).mockClear();
  vi.mocked(projectFileApi.readBytes).mockRejectedValue(new Error("历史文件快照已缺失"));
  const revealed = vi.fn(); window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed);
  try {
    render(<ProjectFilePreviewLayer currentProjectId={7} workspaceRoot="/tmp/workspace" />);
    act(() => openProjectFilePreview(7, "notes/context.txt", undefined, undefined, fixedSource));
    expect(await screen.findByRole("alert")).toHaveTextContent("历史文件快照已缺失");
    expect(projectFileApi.readBytes).toHaveBeenCalledExactlyOnceWith(binding,
      { object, versionNumber: 2, expectedContentHash: fixedSource.revision });
    expect(projectDirectoryApi.resolveReference).not.toHaveBeenCalled();
    expect(projectFileApi.register).not.toHaveBeenCalled();
    expect(fileDocumentApi.versionsList).not.toHaveBeenCalled();
    expect(revealed).not.toHaveBeenCalled();
    expect(layout().tabs).toEqual([expect.objectContaining({ id: first.tabId, view: { versionNumber: 3, line: 10 } })]);
    expect(useProjectFileNavigation.getState().request?.sourceRef).toEqual(fixedSource);
  } finally { window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed); }
});
