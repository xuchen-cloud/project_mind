import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { FileSourcePage, FileVersionPage } from "../../lib/file-types";
import { readCompleteFileSource } from "../../lib/file-source";
import { queryKeys } from "../../lib/queryKeys";
import { AgentApiError } from "../../services/agentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectMindApi } from "../../services/projectMindApi";
import { commitDocumentVersion } from "../../services/documentVersionAction";
import { desktopApi } from "../../services/desktopApi";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { FileHtmlPreview, type FileHtmlPreviewProps } from "./FileHtmlPreview";
vi.mock("../../lib/file-source", () => ({ readCompleteFileSource: vi.fn() }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn(), restore: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { internalReferenceResolve: vi.fn() } }));
vi.mock("../../services/documentVersionAction", () => ({ commitDocumentVersion: vi.fn() }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { confirm: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const latest = { id: "30", versionNumber: 3, name: "plan.html", createdAt: "2026-10-08T10:00:00Z", contentHash: "sha256:three", isCurrent: true };
const old = { ...latest, id: "20", versionNumber: 2, contentHash: "sha256:two", isCurrent: false };
const page: FileVersionPage = { object, currentVersionNumber: 3, currentContentHash: latest.contentHash, versions: [latest, old], nextCursor: null };
const html = "<style>.plan{color:blue}</style><button id=fixture>测试交互</button><script>window.fixture = '完整脚本';</script>";
function source(versionNumber = 3, text = html): FileSourcePage {
  return { object, versionNumber, contentHash: versionNumber === 2 ? old.contentHash! : latest.contentHash!, title: "plan.html", byteLength: new TextEncoder().encode(text).length, format: "html", text, startChar: 0, endChar: [...text].length, totalChars: [...text].length, nextCursor: null, complete: true };
}
const request = { workspaceRoot: "/actual/workspace", projectId: 2, documentId: 7, title: "plan.html" };
function view(overrides: Partial<FileHtmlPreviewProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const input = { request, onClose: vi.fn(), ...overrides };
  const wrap = (props: FileHtmlPreviewProps) => <QueryClientProvider client={client}><FileHtmlPreview {...props} /></QueryClientProvider>;
  return { ...render(wrap(input)), client, input, wrap };
}
beforeEach(() => {
  vi.resetAllMocks(); useAgentPanelStore.getState().clearWorkspace();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {} disconnect() {}
  });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async (_binding, input) => ({ ...page, object: input.object }));
  vi.mocked(readCompleteFileSource).mockImplementation(async (_binding, input) => ({ ...source(input.versionNumber), object: input.object, contentHash: input.expectedContentHash }));
  vi.mocked(projectMindApi.internalReferenceResolve).mockResolvedValue({ kind: "document", id: 7, label: "实际计划.html", scope: "project", projectId: 2, route: "/projects/2?focus=document-7", managedPath: "/actual/workspace/files/plan.html" });
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue(source(2));
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
});

it("reads the actual complete committed head and shows original CSS and JS only as readonly text", async () => {
  const rendered = view();
  await screen.findByLabelText("完整原始源码文本");
  expect(recordDocumentApi.bindingGet).toHaveBeenCalledWith(request.workspaceRoot);
  expect(fileDocumentApi.versionsList).toHaveBeenCalledWith(binding, { object, limit: 50 });
  expect(readCompleteFileSource).toHaveBeenCalledWith(binding, { object, versionNumber: 3, expectedContentHash: latest.contentHash }, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  const original = screen.getByLabelText("完整原始源码文本");
  expect(original.textContent).toBe(html);
  expect(original).not.toHaveAttribute("contenteditable");
  expect(screen.queryByRole("button", { name: "测试交互" })).not.toBeInTheDocument();
  expect(rendered.container.querySelector("iframe,script,style")).toBeNull();
  expect(fileDocumentApi.restore).not.toHaveBeenCalled();
});

it("follows committed invalidation in latest mode but retains an explicitly selected historical version", async () => {
  const rendered = view(); await screen.findByText(/v3 · 最新已提交版本/);
  const next = { ...latest, id: "40", versionNumber: 4, contentHash: "sha256:four" };
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentVersionNumber: 4, currentContentHash: next.contentHash, versions: [next, { ...latest, isCurrent: false }, old] });
  await act(async () => { await rendered.client.invalidateQueries({ queryKey: queryKeys.documentVersions(7) }); });
  await screen.findByText(/v4 · 最新已提交版本/);
  await waitFor(() => expect(readCompleteFileSource).toHaveBeenCalledWith(binding, { object, versionNumber: 4, expectedContentHash: next.contentHash }, expect.any(AbortSignal)));
  fireEvent.change(screen.getByLabelText("文件版本"), { target: { value: "2" } });
  await screen.findByText(/v2 · 固定版本（当前 v4）/);
  vi.mocked(readCompleteFileSource).mockClear();
  const newest = { ...next, id: "50", versionNumber: 5, contentHash: "sha256:five" };
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentVersionNumber: 5, currentContentHash: newest.contentHash, versions: [newest, next, latest, old] });
  await act(async () => { await rendered.client.invalidateQueries({ queryKey: queryKeys.documentVersions(7) }); });
  await screen.findByText(/v2 · 固定版本（当前 v5）/);
  expect(vi.mocked(readCompleteFileSource).mock.calls.every(call => call[1].versionNumber === 2)).toBe(true);
});

it("locates a deep explicit historical version through the real exclusive version cursor", async () => {
  const oldest = { ...old, id: "10", versionNumber: 1, contentHash: "sha256:one" };
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, versions: [oldest] });
  view({ request: { ...request, versionNumber: 1 } });
  await screen.findByText(/v1 · 固定版本/);
  await waitFor(() => expect(readCompleteFileSource).toHaveBeenCalledWith(binding, { object, versionNumber: 1, expectedContentHash: oldest.contentHash }, expect.any(AbortSignal)));
  expect(fileDocumentApi.versionsList).toHaveBeenLastCalledWith(binding, { object, cursor: 2, limit: 50 });
});

it("defaults to readonly source and reports unavailable interaction without exposing inactive viewport controls", async () => {
  const rendered = view(); await screen.findByLabelText("完整原始源码文本");
  expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(screen.getByText("交互预览暂不可用，可以查看源码或继续修改。")).toBeInTheDocument();
  expect(screen.queryByLabelText("预览宽度")).not.toBeInTheDocument();
  expect(rendered.container.querySelector("iframe,script,[data-css-width]")).toBeNull();
  expect(readCompleteFileSource).toHaveBeenCalledOnce();
  expect(fileDocumentApi.restore).not.toHaveBeenCalled();
});

it("guides unregistered files through the existing explicit registration flow without inventing a hash", async () => {
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentContentHash: null, versions: [{ ...latest, contentHash: null }] });
  vi.mocked(commitDocumentVersion).mockResolvedValue(null);
  view(); await screen.findByRole("alert");
  expect(readCompleteFileSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "登记当前内容为新版本" }));
  await waitFor(() => expect(commitDocumentVersion).toHaveBeenCalledWith({ documentId: 7, projectId: 2, managedPath: "/actual/workspace/files/plan.html", expectedVersionNumber: 3 }));
  expect(readCompleteFileSource).not.toHaveBeenCalled();
});

it("keeps the preview and existing same-scope chat while explicitly selecting the verified File target", async () => {
  const store = useAgentPanelStore.getState(); store.openPanel(request.workspaceRoot, object.scope); store.closePanel();
  const previousBinding = useAgentPanelStore.getState().binding;
  const rendered = view(); await screen.findByLabelText("完整原始源码文本");
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  await waitFor(() => expect(useAgentPanelStore.getState().discussionTarget).toEqual({ binding, object, label: "实际计划.html" }));
  expect(useAgentPanelStore.getState().binding).toBe(previousBinding);
  expect(useAgentPanelStore.getState().open).toBe(true);
  expect(rendered.input.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "完整原始源码" })).toBeInTheDocument();
});

it("keeps an existing Workspace conversation when selecting its project's verified File", async () => {
  const store = useAgentPanelStore.getState();
  store.openPanel(request.workspaceRoot, { kind: "workspace" });
  const previousBinding = useAgentPanelStore.getState().binding;
  view(); await screen.findByLabelText("完整原始源码文本");
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  await waitFor(() => expect(useAgentPanelStore.getState().discussionTarget).toEqual({ binding, object, label: "实际计划.html" }));
  expect(useAgentPanelStore.getState().binding).toBe(previousBinding);
  expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "workspace" });
});

it("preserves an existing different scope and refuses target selection after a generation switch", async () => {
  useAgentPanelStore.getState().openPanel(request.workspaceRoot, { kind: "project", projectId: 9 });
  const rendered = view(); await screen.findByLabelText("完整原始源码文本");
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("现有草稿会保留"));
  expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 9 });
  expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
  vi.mocked(projectMindApi.internalReferenceResolve).mockClear();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "changed" });
  fireEvent.click(screen.getByRole("button", { name: "继续修改" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("工作区已切换"));
  expect(projectMindApi.internalReferenceResolve).not.toHaveBeenCalled();
  expect(rendered.input.onClose).not.toHaveBeenCalled();
});

it("aborts an unfinished full-source read on close and never shows a late source from another object", async () => {
  let finish!: (value: FileSourcePage) => void;
  let aborted!: AbortSignal;
  vi.mocked(readCompleteFileSource).mockImplementationOnce((_binding, _input, signal) => { aborted = signal!; return new Promise(resolve => { finish = resolve; }); });
  const rendered = view(); await waitFor(() => expect(readCompleteFileSource).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...rendered.input, request: { ...request, documentId: 8 } }));
  expect(aborted.aborted).toBe(true);
  await act(async () => finish(source(3, "obsolete object source")));
  fireEvent.click(screen.getByRole("button", { name: "源码" }));
  await screen.findByLabelText("完整原始源码文本");
  expect(screen.queryByText("obsolete object source")).not.toBeInTheDocument();
});

it("reports an incomplete or oversized source as an error and offers no execution surface", async () => {
  vi.mocked(readCompleteFileSource).mockRejectedValue(new AgentApiError({ code: "BUDGET_EXCEEDED", message: "too large", retryable: false }));
  const rendered = view();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("不能执行截断内容"));
  expect(rendered.container.querySelector("[data-css-width]")).toBeNull();
  expect(screen.queryByLabelText("完整原始源码文本")).not.toBeInTheDocument();
});

it("restores through the existing native history service and retains the fixed source while head advances", async () => {
  vi.mocked(fileDocumentApi.restore).mockImplementation(async () => {
    const restored = { ...latest, id: "40", versionNumber: 4, contentHash: old.contentHash };
    vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentVersionNumber: 4, currentContentHash: old.contentHash, versions: [restored, { ...latest, isCurrent: false }, old] });
    return { receipt: { documentId: 7, versionNumber: 4, contentHash: old.contentHash!, noChange: false }, versionPath: null };
  });
  view({ request: { ...request, versionNumber: 2 } }); await screen.findByLabelText("完整原始源码文本");
  fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
  fireEvent.click(await screen.findByRole("button", { name: /^查看 v2 / }));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复此版本" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
  await waitFor(() => expect(fileDocumentApi.restore).toHaveBeenCalledWith(binding, { object, versionId: "20", expectedVersionNumber: 3, expectedContentHash: latest.contentHash }, expect.any(String)));
  await screen.findByText(/v2 · 固定版本（当前 v4）/);
  expect(vi.mocked(readCompleteFileSource).mock.calls.every(call => call[1].versionNumber === 2 && call[1].expectedContentHash === old.contentHash)).toBe(true);
  expect(fileDocumentApi.restore).toHaveBeenCalledOnce();
});

it("reports the actual historical source format despite an HTML entry title", async () => {
  vi.mocked(readCompleteFileSource).mockResolvedValue({ ...source(2, "old plain-text file"), format: "text", title: "old.txt" });
  const rendered = view({ request: { ...request, versionNumber: 2 } });
  await screen.findByText("所选版本不是 HTML 文件，可在源码页查看原文。");
  expect(screen.getByLabelText("完整原始源码文本")).toHaveTextContent("old plain-text file");
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(rendered.container.querySelector("iframe,script")).toBeNull();
  expect(screen.getByText("交互预览暂不可用，可以查看源码或继续修改。")).toBeInTheDocument();
});

it("reopens the same File at latest only for a new explicit request", async () => {
  const rendered = view(); await screen.findByLabelText("完整原始源码文本");
  fireEvent.change(screen.getByLabelText("文件版本"), { target: { value: "2" } });
  await screen.findByText(/v2 · 固定版本/);
  rendered.rerender(rendered.wrap(rendered.input));
  expect(screen.getByLabelText("文件版本")).toHaveValue("2");
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(screen.getByText("交互预览暂不可用，可以查看源码或继续修改。")).toBeInTheDocument();
  rendered.rerender(rendered.wrap({ ...rendered.input, request: { ...request } }));
  await screen.findByText(/v3 · 最新已提交版本/);
  expect(screen.getByLabelText("文件版本")).toHaveValue("");
  expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(readCompleteFileSource).toHaveBeenLastCalledWith(binding, { object, versionNumber: 3, expectedContentHash: latest.contentHash }, expect.any(AbortSignal)));
  expect(screen.queryByText(/v2 · 固定版本/)).not.toBeInTheDocument();
});
