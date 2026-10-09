import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSourceNavigation, AgentSourceRef } from "../../lib/agent-types";
import { closeFilePreview, useFilePreviewStore } from "../../state/file-preview-store";
import { AgentSourceCard } from "./AgentSourceCard";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), statusGet: vi.fn(), sessionMessagesRead: vi.fn(), sourceResolve: vi.fn(), resolve: vi.fn(), versions: vi.fn(), openFile: vi.fn(), restore: vi.fn(), workspaceStatus: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../services/agentApi", () => ({ agentApi: { statusGet: mocks.statusGet, sessionMessagesRead: mocks.sessionMessagesRead, sourceResolve: mocks.sourceResolve, operationRestoreCreated: mocks.restore } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { internalReferenceResolve: mocks.resolve, documentListVersions: mocks.versions, workspaceStatusGet: mocks.workspaceStatus } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { openFile: mocks.openFile } }));
const binding = { workspaceId: "w1", generation: "g1" };
const source: AgentSourceRef = { object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "record", id: "42" },
  revision: "sha256:cited", fileVersion: null, recordVersion: null, blockId: "a".repeat(32), locator: { kind: "paragraph", start: 0, end: 1 }, title: "原始决策", excerpt: "已读取的证据" };
const navigation: AgentSourceNavigation = { object: source.object, status: "current", recordTarget: { scope: source.object.scope, recordId: 42 },
  currentRevision: source.revision, revisionMatches: true, recordVersion: null, recordVersionId: null, headRevision: 3,
  blockId: source.blockId, blockStatus: "available", voiceRecordId: null, startMs: null, endMs: null, timeStatus: "not_requested" };
beforeEach(() => { vi.clearAllMocks(); closeFilePreview(); mocks.workspaceStatus.mockResolvedValue({ currentWorkspace: { rootPath: "/actual/workspace" } }); mocks.statusGet.mockResolvedValue({ binding }); mocks.sourceResolve.mockResolvedValue(navigation); mocks.openFile.mockResolvedValue(undefined); });

it("expands a cited session range inside the source card and collapses it without navigation", async () => {
  const cited: AgentSourceRef = { ...source, object: { ...source.object, kind: "session_message", id: "m1" }, blockId: null,
    locator: { kind: "messages", sessionId: "s1", branchId: "b1", startMessageId: "m1", endMessageId: "m1" } };
  mocks.sessionMessagesRead.mockResolvedValue({ sessionId: "s1", branchId: "b1", messages: [], nextCursor: null, hasMore: false });
  render(<AgentSourceCard source={cited} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "查看原始讨论" }));
  expect(await screen.findByRole("region", { name: "引用的原始讨论" })).toBeInTheDocument();
  expect(mocks.sessionMessagesRead).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "收起原始讨论" }));
  expect(screen.queryByRole("region", { name: "引用的原始讨论" })).not.toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.sourceResolve).not.toHaveBeenCalled();
});

it("restores a withdrawn source then resolves its actual destination again", async () => {
  mocks.sourceResolve.mockRejectedValueOnce(JSON.stringify({ code: "OBJECT_WITHDRAWN", details: { workspaceId: "w1", creationOperationId: "b".repeat(32), withdrawalRevision: 3, restoreAvailable: true } })).mockResolvedValue(navigation);
  mocks.restore.mockResolvedValue({ restored: true });
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={source} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("引用记录已撤回");
  fireEvent.click(screen.getByRole("button", { name: "恢复并打开" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  expect(mocks.restore).toHaveBeenCalledWith(binding, { creationOperationId: "b".repeat(32), expectedWithdrawalRevision: 3 });
  expect(mocks.sourceResolve).toHaveBeenCalledTimes(2);
});

it("shows recovery failure without opening or restoring in a changed binding", async () => {
  mocks.sourceResolve.mockRejectedValueOnce(JSON.stringify({ code: "OBJECT_WITHDRAWN", details: { workspaceId: "w1", creationOperationId: "b".repeat(32), withdrawalRevision: 3, restoreAvailable: true } }));
  render(<AgentSourceCard source={source} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await screen.findByRole("button", { name: "恢复并打开" });
  mocks.statusGet.mockResolvedValue({ binding: { ...binding, generation: "g2" } });
  fireEvent.click(screen.getByRole("button", { name: "恢复并打开" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("恢复引用失败：工作区已切换"));
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("previews evidence before resolving and opens only the verified canonical Record block", async () => {
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={source} binding={binding} />);
  expect(mocks.statusGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  expect(screen.getByText("已读取的证据")).toBeVisible();
  expect(mocks.sourceResolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(`/projects/7/records/42?sourceBlock=${source.blockId}&sourceRevision=3`));
  expect(mocks.sourceResolve).toHaveBeenCalledWith(binding, source);
  expect(mocks.resolve).toHaveBeenCalledWith({ kind: "note", id: 42 });
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it("opens the cited File Version instead of the current file and shows its actual older status", async () => {
  const file: AgentSourceRef = { ...source, object: { ...source.object, kind: "file", id: "51" }, fileVersion: 1, blockId: null,
    locator: { kind: "page", page: 4, start: 0, end: 10 }, title: "立项材料" };
  mocks.resolve.mockResolvedValue({ kind: "document", id: 51, scope: "project", projectId: 7, route: "/projects/7?focus=document-51", managedPath: "/private/current.pdf" });
  mocks.versions.mockResolvedValue([{ documentId: 51, versionNumber: 3, managedPath: "/private/current.pdf" }, { documentId: 51, versionNumber: 1, managedPath: "/private/history/old.pdf" }]);
  render(<AgentSourceCard source={file} />);
  fireEvent.click(screen.getByRole("button", { name: "立项材料" }));
  expect(screen.getByText("第 4 页")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith("/private/history/old.pdf"));
  expect(mocks.versions).toHaveBeenCalledWith({ documentId: 51 });
  expect(screen.getByText("旧版 v1 · 当前 v3")).toBeVisible();
  expect(screen.queryByText(/\/private/)).not.toBeInTheDocument();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("reports a missing retained File Version and does not substitute current bytes", async () => {
  mocks.resolve.mockResolvedValue({ kind: "document", id: 51, scope: "project", projectId: 7, route: "/projects/7", managedPath: "/private/current.pdf" });
  mocks.versions.mockResolvedValue([{ versionNumber: 3, managedPath: "/private/current.pdf" }]);
  render(<AgentSourceCard source={{ ...source, object: { ...source.object, kind: "file", id: "51" }, fileVersion: 1 }} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("引用版本 v1 已删除或不再保留");
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it("blocks citations belonging to a different selected Workspace", async () => {
  mocks.statusGet.mockResolvedValue({ binding: { ...binding, workspaceId: "w2" } });
  render(<AgentSourceCard source={source} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("does not navigate when a source resolution finishes after the card closes", async () => {
  let finish!: (value: object) => void;
  mocks.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AgentSourceCard source={source} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
  view.unmount();
  finish({ kind: "note", scope: "project", projectId: 7, route: "/projects/7/records/42" });
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("opens the verified Transcript owner and clipped time instead of guessing a Record from its voice ID", async () => {
  mocks.sourceResolve.mockResolvedValue({ ...navigation, blockId: null, blockStatus: "not_requested", voiceRecordId: 99,
    startMs: 75500, endMs: 79000, timeStatus: "available" });
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={{ ...source, object: { ...source.object, kind: "transcript", id: "99" }, blockId: null,
    locator: { kind: "time", startMs: 75000, endMs: 80000 }, title: "会议转写", excerpt: "" }} />);
  fireEvent.click(screen.getByRole("button", { name: "会议转写" }));
  expect(screen.getByText("1:15–1:20")).toBeVisible();
  expect(screen.getByText("引用未含正文")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/projects/7/records/42?sourceTimeMs=75500"));
  expect(mocks.resolve).toHaveBeenCalledWith({ kind: "note", id: 42 });
  expect(mocks.resolve).not.toHaveBeenCalledWith(expect.objectContaining({ id: 99 }));
});

it("warns about changed evidence before opening current content and omits original block/time highlighting", async () => {
  mocks.sourceResolve.mockResolvedValue({ ...navigation, status: "changed", revisionMatches: false, currentRevision: "sha256:new" });
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={source} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  expect(await screen.findByText(/引用内容已变化/)).toBeVisible();
  expect(mocks.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开当前记录" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/projects/7/records/42"));
});

it("preserves the selected historical numeric revision and visibly labels retained snapshots", async () => {
  mocks.sourceResolve.mockResolvedValue({ ...navigation, status: "historical", recordVersion: 2, recordVersionId: "retained", headRevision: 1 });
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={{ ...source, recordVersion: 2 }} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(`/projects/7/records/42?sourceBlock=${source.blockId}&sourceRevision=1`));
  expect(screen.getByText(/历史版本 v2，请在记录版本历史中核对/)).toBeVisible();
});

it("opens an available Record page while explicitly reporting a missing time locator", async () => {
  mocks.sourceResolve.mockResolvedValue({ ...navigation, blockId: null, blockStatus: "not_requested", startMs: null, timeStatus: "missing" });
  mocks.resolve.mockResolvedValue({ kind: "note", id: 42, scope: "project", projectId: 7, route: "/projects/7/records/42" });
  render(<AgentSourceCard source={{ ...source, object: { ...source.object, kind: "transcript", id: "99" } }} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/projects/7/records/42"));
  expect(screen.getByText(/引用时间片段已缺失/)).toBeVisible();
});

it("does not substitute an available current page for a deleted retained Record snapshot", async () => {
  mocks.sourceResolve.mockResolvedValue({ ...navigation, status: "not_found", recordTarget: null });
  render(<AgentSourceCard source={{ ...source, recordVersion: 2 }} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "原始决策" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保留版本已删除");
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("opens an HTML source at the exact retained version instead of the current head or desktop browser", async () => {
  const file = { ...source, object: { ...source.object, kind: "file" as const, id: "51" }, fileVersion: 1, blockId: null, title: "历史网页" };
  mocks.resolve.mockResolvedValue({ kind: "document", id: 51, label: "页面.htm", scope: "project", projectId: 7, route: "/projects/7?document=51", managedPath: "/head/页面.htm" });
  mocks.versions.mockResolvedValue([{ id: 2, documentId: 51, versionNumber: 2, managedPath: "/head/页面.htm" }, { id: 1, documentId: 51, versionNumber: 1, managedPath: "/history/页面.htm" }]);
  render(<AgentSourceCard source={file} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "历史网页" }));
  fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
  await waitFor(() => expect(useFilePreviewStore.getState().request).toEqual({ workspaceRoot: "/actual/workspace", projectId: 7, documentId: 51, title: "页面.htm", versionNumber: 1 }));
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.getByText("旧版 v1 · 当前 v2")).toBeInTheDocument();
});
