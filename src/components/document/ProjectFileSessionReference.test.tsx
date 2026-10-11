import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectFileSessionReference } from "./ProjectFileSessionReference";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { setDshWorkspaceRoot, useDshFileReferences } from "../../lib/dsh-host-events";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { useProjectContentStore } from "../../state/project-content-store";
import { getContentLayout } from "../../lib/project-content-layout";
import { PROJECT_CONTENT_OPEN_EVENT } from "../../services/projectContentApi";
import type { AgentSourceRef } from "../../lib/agent-types";
import type { FileBytesResult } from "../../lib/file-types";
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: vi.fn(), readBytes: vi.fn() } }));
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: { start: vi.fn(), sessions: vi.fn() } }));
const binding = { workspaceId: "reference-workspace", generation: "open-1" };
const object = { workspaceId: binding.workspaceId, scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" };
const bytes: FileBytesResult = { object, versionNumber: 2, contentHash: "sha256:retained-v2", name: "historical.txt", mime: "text/plain", byteLength: 3, base64: btoa("old") };
const source: AgentSourceRef = { object, revision: bytes.contentHash, fileVersion: 2, recordVersion: null, blockId: null, locator: null, title: "historical.txt", excerpt: "" };
const props = { workspaceRoot: "/tmp/reference-workspace", projectId: 7, fileId: 51, versionNumber: 2, sourceRef: source };
const pending = () => useDshFileReferences.getState().pending;
async function choose(id = "session-b") {
  fireEvent.click(screen.getByRole("button", { name: "引用到会话" }));
  const select = await screen.findByRole("combobox", { name: "目标会话" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: id } });
  fireEvent.click(screen.getByRole("button", { name: "插入引用" }));
}
beforeEach(() => {
  vi.resetAllMocks(); useProjectContentStore.setState({ layouts: {} });
  useAgentPanelStore.getState().clearWorkspace(); setDshWorkspaceRoot(null); setDshWorkspaceRoot(props.workspaceRoot);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(dshAssistantApi.start).mockResolvedValue(undefined);
  vi.mocked(dshAssistantApi.sessions).mockResolvedValue([{ id: "session-a", title: "材料分析", running: true }, { id: "session-b", title: "方案讨论", running: false }]);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "renamed/current.txt", name: "current.txt", versionNumber: 3, contentHash: "sha256:current-v3", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: "sha256:current-v3",
    versions: [{ id: "retained-2", versionNumber: 2, name: bytes.name, contentHash: bytes.contentHash, createdAt: "yesterday", isCurrent: false }], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockResolvedValue(bytes);
});
afterEach(() => { setDshWorkspaceRoot(null); });
it("offers two real Session destinations and queues the exact fixed File version only to the selected Session", async () => {
  render(<ProjectFileSessionReference {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "引用到会话" }));
  const select = await screen.findByRole("combobox", { name: "目标会话" });
  await waitFor(() => expect(select).toBeEnabled());
  expect(within(select).getByRole("option", { name: "材料分析" })).toHaveValue("session-a");
  expect(within(select).getByRole("option", { name: "方案讨论" })).toHaveValue("session-b");
  expect(screen.getByRole("button", { name: "插入引用" })).toBeDisabled();
  fireEvent.change(select, { target: { value: "session-b" } }); fireEvent.click(screen.getByRole("button", { name: "插入引用" }));
  await waitFor(() => expect(pending()).toHaveLength(1));
  expect(pending()[0]).toEqual(expect.objectContaining({ workspaceRoot: props.workspaceRoot, projectId: 7, sessionId: "session-b", path: "renamed/current.txt", sourceRef: source }));
  expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, { object, versionNumber: 2, expectedContentHash: "sha256:retained-v2" });
  expect(fileDocumentApi.versionsList).toHaveBeenCalledWith(binding, { object, cursor: 3, limit: 1 });
  expect(dshAssistantApi.sessions).toHaveBeenCalledWith(7);
  const layout = getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: 7 });
  expect(layout.tabs.map(tab => tab.object.id)).toEqual(["session-b"]); expect(layout.panes).toHaveLength(1);
  expect(useAgentPanelStore.getState().open).toBe(false);
});
it("does not drift queued or subsequent pinned references when the same File gets a newer current version", async () => {
  const view = render(<ProjectFileSessionReference {...props} />); await choose("session-b");
  await waitFor(() => expect(pending()).toHaveLength(1));
  const first = structuredClone(pending()[0]);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "again/moved.txt", name: "moved.txt", versionNumber: 4, contentHash: "sha256:new-v4", state: "ready", reason: null });
  view.rerender(<ProjectFileSessionReference {...props} />); await choose("session-a");
  await waitFor(() => expect(pending()).toHaveLength(2));
  expect(pending()[0]).toEqual(first);
  expect(pending()[1]).toMatchObject({ sessionId: "session-a", path: "again/moved.txt", sourceRef: source });
  for (const [, input] of vi.mocked(projectFileApi.readBytes).mock.calls) expect(input).toEqual({ object, versionNumber: 2, expectedContentHash: bytes.contentHash });
});
it("shows a missing historical snapshot error without queueing a reference or opening a destination", async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValue(new Error("固定版本快照不存在"));
  render(<ProjectFileSessionReference {...props} />); await choose();
  expect(await screen.findByRole("alert")).toHaveTextContent("固定版本快照不存在");
  expect(pending()).toHaveLength(0);
  expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: 7 }).tabs).toHaveLength(0);
  expect(screen.getByRole("combobox", { name: "目标会话" })).toHaveValue("session-b");
});
it("rejects a mismatched retained version response instead of queueing a mislabeled source", async () => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ ...bytes, versionNumber: 3, contentHash: "sha256:new-v3" });
  render(<ProjectFileSessionReference {...props} />); await choose();
  expect(await screen.findByRole("alert")).toHaveTextContent("文件版本与引用目标不符"); expect(pending()).toHaveLength(0);
});
it("rejects a Workspace generation change between snapshot read and delivery", async () => {
  let finish!: (result: FileBytesResult) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<ProjectFileSessionReference {...props} />); await choose();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "open-2" });
  await act(async () => finish(bytes));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换"); expect(pending()).toHaveLength(0);
  expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: 7 }).tabs).toHaveLength(0);
});
it.each([{ fileId: 52 }, { projectId: 8 }, { versionNumber: 3 }, { workspaceRoot: "/another/workspace" }])("discards an in-flight insertion when props change to %j", async change => {
  let finish!: (result: FileBytesResult) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ProjectFileSessionReference {...props} />); await choose();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<ProjectFileSessionReference {...props} {...change} />);
  await act(async () => finish(bytes));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "目标会话" })).toBeEnabled());
  expect(pending()).toHaveLength(0); expect(screen.getByRole("combobox", { name: "目标会话" })).toHaveValue("");
  expect(useProjectContentStore.getState().layouts).toEqual({});
});
it("disables reference actions until the preview has a verified SourceRef", async () => {
  const view = render(<ProjectFileSessionReference {...props} sourceRef={null} />);
  const open = screen.getByRole("button", { name: "引用到会话" });
  expect(open).toBeDisabled(); fireEvent.click(open);
  expect(screen.queryByRole("combobox", { name: "目标会话" })).toBeNull();
  expect(dshAssistantApi.sessions).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
  view.rerender(<ProjectFileSessionReference {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "引用到会话" }));
  const select = await screen.findByRole("combobox", { name: "目标会话" });
  await waitFor(() => expect(select).toBeEnabled()); fireEvent.change(select, { target: { value: "session-b" } });
  expect(screen.getByRole("button", { name: "插入引用" })).toBeEnabled();
  view.rerender(<ProjectFileSessionReference {...props} sourceRef={null} />);
  const insert = screen.getByRole("button", { name: "插入引用" }); expect(insert).toBeDisabled(); fireEvent.click(insert);
  expect(projectFileApi.readBytes).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
});
it("references the bytes currently displayed in latest mode even when the live File changes before clicking", async () => {
  render(<ProjectFileSessionReference {...props} versionNumber={undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "引用到会话" }));
  const select = await screen.findByRole("combobox", { name: "目标会话" });
  await waitFor(() => expect(select).toBeEnabled()); fireEvent.change(select, { target: { value: "session-b" } });
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "new-location.txt", name: "updated.txt", versionNumber: 4, contentHash: "sha256:new-v4", state: "ready", reason: null });
  fireEvent.click(screen.getByRole("button", { name: "插入引用" }));
  await waitFor(() => expect(pending()).toHaveLength(1));
  expect(pending()[0]).toMatchObject({ sessionId: "session-b", path: "new-location.txt", sourceRef: source });
  expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, { object, versionNumber: 2, expectedContentHash: source.revision });
});
it("refuses a retained hash that does not match the displayed preview SourceRef", async () => {
  render(<ProjectFileSessionReference {...props} sourceRef={{ ...source, revision: "sha256:another-preview" }} />);
  await choose(); expect(await screen.findByRole("alert")).toHaveTextContent("无法建立固定引用");
  expect(projectFileApi.readBytes).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
});
it("queues the fixed reference before revealing its Session even when reveal immediately unmounts the File UI", async () => {
  const view = render(<ProjectFileSessionReference {...props} />);
  const atReveal: Array<ReturnType<typeof pending>> = [];
  const reveal = vi.fn((event: Event) => {
    atReveal.push(structuredClone(pending()));
    view.unmount();
    return (event as CustomEvent).detail;
  });
  window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, reveal);
  try {
    await choose("session-b");
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1));
    expect(atReveal).toEqual([[expect.objectContaining({ sessionId: "session-b", sourceRef: source })]]);
    expect(reveal.mock.results[0].value).toMatchObject({ workspaceRoot: props.workspaceRoot, scope: { workspaceId: binding.workspaceId, projectId: 7 }, object: { kind: "session", id: "session-b" } });
    expect(pending()).toHaveLength(1); expect(pending()[0]).toMatchObject({ sessionId: "session-b", sourceRef: source });
    expect(screen.queryByRole("button", { name: "引用到会话" })).toBeNull();
  } finally { window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT, reveal); }
});
