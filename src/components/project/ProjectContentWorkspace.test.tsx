import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentApiError } from "../../services/agentApi";
import { desktopApi } from "../../services/desktopApi";
import { RecordSaveCoordinator, RecordSaveFailure } from "../../lib/record-save-coordinator";
import { RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { ProjectContentWorkspace, contentTabRoute } from "./ProjectContentWorkspace";
import { prepareProjectContentClose, prepareWorkspaceContentClose } from "../../lib/project-content-lifecycle";
import { openProjectContent } from "../../services/projectContentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { fixtureEditorState } from "../../test/recordDocumentFixture";
import { useProjectContentStore } from "../../state/project-content-store";
import type { RecordTarget } from "../../lib/record-document-types";
import { queryKeys } from "../../lib/queryKeys";
import voiceRecordIcon from "../../assets/icons/voice-record-color.svg";
import { setDshWorkspaceRoot } from "../../lib/dsh-host-events";
import { getContentLayout } from "../../lib/project-content-layout";

const page = vi.hoisted(() => ({ mounts: vi.fn(), guard: vi.fn(async (_projectId: number | null, _recordId: number) => undefined) }));
// Page internals are covered by WP3/4/5; exercise the real route, authority service and layout here.
vi.mock("./ProjectNoteFocusPage", () => ({ ProjectNoteFocusPage: function RecordPage(props: {
  recordIdOverride: number; projectIdOverride: number; visible: boolean; focused: boolean;
  registerCloseGuard: (guard: () => Promise<void>) => () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => { page.mounts(props.projectIdOverride, props.recordIdOverride); }, []);
  useEffect(() => props.registerCloseGuard(() => page.guard(props.projectIdOverride, props.recordIdOverride)), [props.registerCloseGuard]);
  return <section aria-label={`Record ${props.recordIdOverride}`} data-visible={String(props.visible)} data-focused={String(props.focused)}>
    <input aria-label={`编辑${props.recordIdOverride}`} value={value} onChange={event => setValue(event.target.value)} />
  </section>;
} }));
vi.mock("../workspace/WorkspaceRecordFocusPage", () => ({ WorkspaceRecordFocusPage: function RecordPage(props: {
  recordIdOverride: number; visible: boolean; focused: boolean; registerCloseGuard: (guard: () => Promise<void>) => () => void;
}) {
  useEffect(() => props.registerCloseGuard(() => page.guard(null, props.recordIdOverride)), [props.registerCloseGuard]);
  return <section aria-label={`Workspace Record ${props.recordIdOverride}`} data-visible={String(props.visible)} data-focused={String(props.focused)} />;
} }));
vi.mock("../document/ProjectFileContent", () => ({ ProjectFileContent: (props: { fileId: number; versionNumber?: number; line?: number; toolbarActions?: ReactNode }) =>
  <section aria-label="文件页"><header aria-label="文件工具栏">{props.toolbarActions}</header><p>File {props.fileId} / {props.versionNumber ?? "latest"} / line {props.line ?? 1}</p></section> }));
vi.mock("../agent/ProjectSessionContent", () => ({ ProjectSessionContent: () => <section aria-label="会话正文" /> }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(), editorGet: vi.fn() } }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
vi.mock("../../services/agentApi", async importOriginal => ({ ...await importOriginal<typeof import("../../services/agentApi")>(),
  agentApi: { statusGet: async () => ({ binding }) },
}));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { confirm: vi.fn() } }));
const binding = { workspaceId: "workspace-tabs", generation: "open-1" };
const workspaceRoot = "/tmp/tabs";
function fixture(route = "/projects/7/records/1", client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), coordinator?: RecordSaveCoordinator, projectId: number | null = 7) {
  function Root() {
    const [active, setActive] = useState(true);
    return <><button onClick={() => setActive(value => !value)}>切换项目活动状态</button>
      <ProjectContentWorkspace workspaceRoot={workspaceRoot} projectId={projectId} active={active} overview={() => <p>项目概览入口</p>} /></>;
  }
  const router = createMemoryRouter([{ path: "*", element: <Root /> }], { initialEntries: [route] });
  render(<QueryClientProvider client={client}>{coordinator
    ? <RecordSaveCoordinatorProvider coordinator={coordinator}><RouterProvider router={router} /></RecordSaveCoordinatorProvider>
    : <RouterProvider router={router} />}</QueryClientProvider>);
  return router;
}
beforeEach(() => {
  vi.resetAllMocks(); page.guard.mockResolvedValue(undefined); useProjectContentStore.setState({ layouts: {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(recordDocumentApi.editorGet).mockImplementation(async (_binding, target: RecordTarget) => fixtureEditorState(target, {
    id: target.recordId, projectId: target.scope.kind === "project" ? target.scope.projectId : 7,
    title: `Record ${target.recordId}`, contentMarkdown: "正文", contentHtml: "<p>正文</p>", defaultCodeLanguage: null,
    tags: [], createdAt: "now", updatedAt: "now",
  }));
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async (_binding, { object }) => ({ object, currentVersionNumber: 3, currentContentHash: "sha256:current", versions: [], nextCursor: null }));
});
afterEach(() => { setDshWorkspaceRoot(null); vi.restoreAllMocks(); });
it("updates a background Session tab after automatic title generation without changing selection or panes", async () => {
  setDshWorkspaceRoot(workspaceRoot);
  const scope = { workspaceId: binding.workspaceId, projectId: 7 };
  const store = useProjectContentStore.getState();
  const sessionTab = store.open(scope, { kind: "session", id: "session-a", title: "新会话" });
  store.open(scope, { kind: "record", id: 1, title: "Record 1" });
  fixture();
  await screen.findByLabelText("编辑1");
  const before = getContentLayout(useProjectContentStore.getState(), scope);
  act(() => { window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 7, titlesBySession: { "session-a": "自动生成的会话标题" } },
  })); });
  await screen.findByRole("tab", { name: "自动生成的会话标题" });
  const after = getContentLayout(useProjectContentStore.getState(), scope);
  expect(after.tabs.find(tab => tab.id === sessionTab)?.object.title).toBe("自动生成的会话标题");
  expect(after.panes).toEqual(before.panes);
  expect(after.focusedPaneId).toBe(before.focusedPaneId);
  expect(screen.getByRole("tab", { name: "Record 1" })).toHaveAttribute("aria-selected", "true");
});
it("restores the latest Session title when the catalog arrives before the content workspace mounts", async () => {
  setDshWorkspaceRoot(workspaceRoot);
  const scope = { workspaceId: binding.workspaceId, projectId: 7 };
  const store = useProjectContentStore.getState();
  const tabId = store.open(scope, { kind: "session", id: "session-a", title: "新会话" });
  window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 7, titlesBySession: { "session-a": "恢复的会话标题" } },
  }));
  fixture(`/projects/7?content=${tabId}`);
  expect(await screen.findByRole("tab", { name: "恢复的会话标题" })).toHaveAttribute("aria-selected", "true");
  expect(getContentLayout(useProjectContentStore.getState(), scope).tabs[0].id).toBe(tabId);
});
it("preserves an accepted manual rename until a newer catalog title arrives", async () => {
  setDshWorkspaceRoot(workspaceRoot);
  const scope = { workspaceId: binding.workspaceId, projectId: 7 };
  const store = useProjectContentStore.getState();
  const tabId = store.open(scope, { kind: "session", id: "session-a", title: "新会话" });
  window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 7, titlesBySession: { "session-a": "自动标题" } },
  }));
  fixture(`/projects/7?content=${tabId}`);
  await screen.findByRole("tab", { name: "自动标题" });
  // manageProjectSession writes the accepted title before its asynchronous catalog event arrives.
  act(() => store.updateTitle(scope, tabId, "用户重命名"));
  expect(screen.getByRole("tab", { name: "用户重命名" })).toBeInTheDocument();
  act(() => { window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 7, titlesBySession: { "session-a": "用户重命名" } },
  })); });
  expect(screen.getByRole("tab", { name: "用户重命名" })).toBeInTheDocument();
});
it("keeps Session title updates within their Project and Workspace without touching other content", async () => {
  setDshWorkspaceRoot(workspaceRoot);
  const scope = { workspaceId: binding.workspaceId, projectId: 7 };
  const store = useProjectContentStore.getState();
  const tabId = store.open(scope, { kind: "session", id: "same-id", title: "保留的会话标题" });
  store.open({ ...scope, projectId: 8 }, { kind: "session", id: "same-id", title: "另一项目" });
  store.open({ ...scope, workspaceId: "other-workspace" }, { kind: "session", id: "same-id", title: "另一工作区" });
  store.open(scope, { kind: "file", id: 51, title: "文件标题" });
  fixture("/projects/7?view=overview");
  await screen.findByRole("tab", { name: "保留的会话标题" });
  act(() => { window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 8, titlesBySession: { "same-id": "不属于当前项目" } },
  })); });
  expect(screen.getByRole("tab", { name: "保留的会话标题" })).toBeInTheDocument();
  act(() => { window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
    detail: { projectId: 7, titlesBySession: { "same-id": "当前项目新标题", "51": "不能修改文件" } },
  })); });
  await screen.findByRole("tab", { name: "当前项目新标题" });
  expect(screen.getByRole("tab", { name: "文件标题" })).toBeInTheDocument();
  expect(getContentLayout(useProjectContentStore.getState(), { ...scope, projectId: 8 }).tabs[0].object.title).toBe("另一项目");
  expect(getContentLayout(useProjectContentStore.getState(), { ...scope, workspaceId: "other-workspace" }).tabs[0].object.title).toBe("另一工作区");
  act(() => {
    setDshWorkspaceRoot("/other-workspace");
    window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", {
      detail: { projectId: 7, titlesBySession: { "same-id": "不属于当前工作区" } },
    }));
  });
  expect(getContentLayout(useProjectContentStore.getState(), scope).tabs.find(tab => tab.id === tabId)?.object.title).toBe("当前项目新标题");
});
it("restores the voice icon for an older saved Record tab without reopening its editor", async () => {
  const id = useProjectContentStore.getState().open({ workspaceId: binding.workspaceId, projectId: 7 }, { kind: "record", id: 1, title: "Record 1" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.projectPage(7), { records: [{ id: 1, title: "Record 1", isVoice: true }] });
  fixture(`/projects/7?content=${id}`, client);
  const tab = await screen.findByRole("tab", { name: "Record 1" });
  expect(tab).toHaveAttribute("title", expect.stringContaining("语音记录"));
  expect(tab.querySelector("img")).toHaveAttribute("src", voiceRecordIcon);
  expect(recordDocumentApi.editorGet).not.toHaveBeenCalled();
});
it("opens a real Record route through authority, keeps one tab on back navigation and preserves its editor", async () => {
  const router = fixture();
  const input = await screen.findByLabelText("编辑1"); fireEvent.change(input, { target: { value: "Record 1 draft" } });
  expect(recordDocumentApi.editorGet).toHaveBeenCalledWith(binding, { scope: { kind: "project", projectId: 7 }, recordId: 1 });
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  await act(() => router.navigate("/projects/7/records/2")); await screen.findByLabelText("编辑2");
  await act(() => router.navigate(-1));
  await waitFor(() => expect(screen.getByLabelText("编辑1")).toBeVisible());
  expect(screen.getByLabelText("编辑1")).toBe(input); expect(input).toHaveValue("Record 1 draft");
  expect(screen.getAllByRole("tab")).toHaveLength(2); expect(page.mounts.mock.calls.filter(([, id]) => id === 1)).toHaveLength(1);
});
it("renders two visible Records with one focus and keeps their state when moved", async () => {
  const router = fixture(); await screen.findByLabelText("编辑1");
  await act(() => router.navigate("/projects/7/records/2")); const input = await screen.findByLabelText("编辑2");
  fireEvent.change(input, { target: { value: "跨栏草稿" } }); fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  expect(screen.getByRole("region", { name: "Record 1" })).toHaveAttribute("data-visible", "true");
  expect(screen.getByRole("region", { name: "Record 2" })).toHaveAttribute("data-focused", "true");
  expect(screen.getByRole("region", { name: "Record 1" })).toHaveAttribute("data-focused", "false");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Record 2" }), { key: "ArrowLeft", altKey: true, shiftKey: true, ctrlKey: true });
  expect(screen.getByLabelText("编辑2")).toBe(input); expect(input).toHaveValue("跨栏草稿");
  expect(page.mounts.mock.calls.filter(([, id]) => id === 2)).toHaveLength(1);
});
it("opens Home inside the left pane, preserves the right editor, and returns through history and the same Record route", async () => {
  const router = fixture();
  const left = await screen.findByLabelText("编辑1");
  fireEvent.change(left, { target: { value: "左栏草稿" } });
  await act(() => router.navigate("/projects/7/records/2"));
  const right = await screen.findByLabelText("编辑2");
  fireEvent.change(right, { target: { value: "右栏草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "分栏" }));
  fireEvent.click(screen.getByRole("button", { name: "项目首页" }));
  expect(router.state.location.search).toBe("?view=overview");
  expect(screen.getByRole("region", { name: "项目首页" })).toBeVisible();
  expect(screen.getByText("项目概览入口").closest(".project-content__grid")).not.toBeNull();
  expect(left).not.toBeVisible(); expect(right).toBeVisible();
  await act(() => router.navigate(-1));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Record 2" })).toHaveAttribute("aria-selected", "true"));
  await act(() => router.navigate("/projects/7?view=overview"));
  await act(() => router.navigate("/projects/7/records/1"));
  await waitFor(() => expect(left).toBeVisible());
  expect(left).toHaveValue("左栏草稿"); expect(right).toHaveValue("右栏草稿");
  expect(page.mounts.mock.calls.filter(([, id]) => id === 1)).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "项目首页" })).toHaveLength(1);
});
it("reuses the same pinned File view across ordinary entry points and an explicit history request", async () => {
  fixture("/projects/7"); await screen.findByText("项目概览入口");
  const object = { kind: "file" as const, id: 51, title: "context.txt" };
  let original = "";
  await act(async () => { original = (await openProjectContent({ workspaceRoot, projectId: 7, object, view: { versionNumber: 2, line: 12 } })).tabId; });
  expect(await screen.findByText("File 51 / 2 / line 12")).toBeVisible();
  await act(async () => { await openProjectContent({ workspaceRoot, projectId: 7, object }); });
  expect(screen.getByText("File 51 / 2 / line 12")).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  await act(async () => { await openProjectContent({ workspaceRoot, projectId: 7, object, view: { versionNumber: 1, line: 3 } }); });
  expect(screen.getByText("File 51 / 1 / line 3")).toBeVisible();
  expect(screen.getByRole("tab")).toHaveAttribute("aria-controls", `content-page-${original}`);
  expect(fileDocumentApi.versionsList).toHaveBeenCalledWith(binding, { object: { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 7 }, kind: "file", id: "51" }, limit: 1 });
});
it("keeps the Record route, tab and draft when close fails, then closes after a successful retry", async () => {
  const router = fixture(); const input = await screen.findByLabelText("编辑1");
  fireEvent.change(input, { target: { value: "关闭失败草稿" } }); page.guard.mockRejectedValueOnce(new Error("未接受的 AI 修改阻止关闭"));
  fireEvent.click(screen.getByRole("button", { name: "关闭Record 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("未接受的 AI 修改阻止关闭");
  expect(router.state.location.pathname).toBe("/projects/7/records/1"); expect(input).toHaveValue("关闭失败草稿");
  expect(screen.getByRole("tab", { name: "Record 1" })).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "关闭Record 1" })));
  expect(screen.queryByRole("tab")).toBeNull(); expect(router.state.location.pathname).toBe("/projects/7");
});
it("closes a deleted Record tab only after confirmation and clears its orphan save queue", async () => {
  const coordinator = new RecordSaveCoordinator({ workspaceKey: workspaceRoot, adapter: { persist: async () => {
    throw new RecordSaveFailure("Record is missing", { code: "NOT_FOUND", retryable: false });
  } } });
  const router = fixture(undefined, undefined, coordinator);
  await screen.findByLabelText("编辑1");
  coordinator.submit({ scope: "project", workspaceKey: workspaceRoot, projectId: 7, recordId: 1,
    title: "Record 1", tagIds: [], defaultCodeLanguage: null, committedContent: { html: "<p>draft</p>", text: "draft", markdown: "draft" },
    canonicalBody: { binding, requestId: "deleted", baseRevision: 1, editSessionId: null, origin: "manual", document: { type: "doc" } },
  });
  await coordinator.flush().catch(() => undefined);
  vi.mocked(recordDocumentApi.editorGet).mockRejectedValue(new AgentApiError({ code: "NOT_FOUND", message: "Record is missing", retryable: false }));
  vi.mocked(desktopApi.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭Record 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已取消关闭");
  expect(router.state.location.pathname).toBe("/projects/7/records/1");
  expect(coordinator.getLatestSnapshot("project:7:1")).not.toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "关闭Record 1" })));
  expect(screen.queryByRole("tab")).toBeNull();
  expect(router.state.location.pathname).toBe("/projects/7");
  await expect(coordinator.flush()).resolves.toBeUndefined();
});
it("cancels close after a Workspace generation changes during the guard", async () => {
  const router = fixture(); await screen.findByLabelText("编辑1");
  page.guard.mockImplementationOnce(async () => { vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "open-2" }); });
  fireEvent.click(screen.getByRole("button", { name: "关闭Record 1" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(screen.getByRole("tab", { name: "Record 1" })).toBeVisible(); expect(router.state.location.pathname).toBe("/projects/7/records/1");
});

it("does not reload a completed Record route when returning to its resident Project", async () => {
  fixture(); const input = await screen.findByLabelText("编辑1");
  fireEvent.change(input, { target: { value: "返回仍保留" } }); const loads = vi.mocked(recordDocumentApi.editorGet).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "切换项目活动状态" })); expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "切换项目活动状态" }));
  await waitFor(() => expect(input).toBeVisible()); expect(input).toHaveValue("返回仍保留");
  expect(recordDocumentApi.editorGet).toHaveBeenCalledTimes(loads); expect(page.mounts).toHaveBeenCalledTimes(1);
});
it("retries an interrupted Record route when returning to the same Project before it ever opened", async () => {
  const original = vi.mocked(recordDocumentApi.editorGet).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(recordDocumentApi.editorGet).mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { finish = resolve; }); return original(...args);
  });
  fixture(); await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "切换项目活动状态" }));
  await act(async () => finish()); expect(screen.queryByRole("tab")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "切换项目活动状态" }));
  expect(await screen.findByLabelText("编辑1")).toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});

it("uses the actual hidden Record guard for Project and Workspace leave, keeping both tabs on failure", async () => {
  const router = fixture(); const first = await screen.findByLabelText("编辑1");
  fireEvent.change(first, { target: { value: "隐藏的待审阅内容" } });
  await act(() => router.navigate("/projects/7/records/2")); const second = await screen.findByLabelText("编辑2");
  fireEvent.change(second, { target: { value: "当前记录草稿" } });
  page.guard.mockImplementation(async (_projectId, recordId) => { if (recordId === 1) throw new Error("隐藏记录仍待审阅"); });
  await expect(prepareProjectContentClose(workspaceRoot, 7)).rejects.toThrow("隐藏记录仍待审阅");
  await expect(prepareWorkspaceContentClose(workspaceRoot)).rejects.toThrow("隐藏记录仍待审阅");
  expect(page.guard).toHaveBeenCalledWith(7, 1);
  expect(first).toHaveValue("隐藏的待审阅内容"); expect(second).toHaveValue("当前记录草稿");
  expect(screen.getAllByRole("tab")).toHaveLength(2); expect(second).toBeVisible(); expect(first).not.toBeVisible();
  const calls = page.guard.mock.calls.length;
  await prepareProjectContentClose(workspaceRoot, 8); await prepareWorkspaceContentClose("/another/workspace");
  expect(page.guard).toHaveBeenCalledTimes(calls);
  page.guard.mockResolvedValue(undefined);
  await prepareWorkspaceContentClose(workspaceRoot);
  expect(page.guard).toHaveBeenCalledWith(7, 2); expect(screen.getAllByRole("tab")).toHaveLength(2);
});
it("restores the selected pinned File Tab through browser history after opening a Record", async () => {
  const router = fixture("/projects/7"); await screen.findByText("项目概览入口");
  let fileId = "";
  await act(async () => { fileId = (await openProjectContent({ workspaceRoot, projectId: 7, object: { kind: "file", id: 51, title: "context.txt" }, view: { versionNumber: 2, line: 9 } })).tabId; });
  await act(() => router.navigate(`/projects/7?content=${encodeURIComponent(fileId)}`));
  expect(await screen.findByText("File 51 / 2 / line 9")).toBeVisible();
  await act(() => router.navigate("/projects/7/records/2")); const record = await screen.findByLabelText("编辑2");
  expect(record).toBeVisible(); expect(screen.getByText("File 51 / 2 / line 9")).not.toBeVisible();
  await act(() => router.navigate(-1));
  expect(await screen.findByText("File 51 / 2 / line 9")).toBeVisible(); expect(record).not.toBeVisible();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("tab", { name: /context.txt/ })).toHaveAttribute("aria-selected", "true");
  expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(1);
});

it("places the File reference action inside its toolbar and omits the normal location panel",async()=>{
  fixture("/projects/7"); await screen.findByText("项目概览入口");
  await act(async()=>{await openProjectContent({workspaceRoot,projectId:7,object:{kind:"file",id:51,title:"context.txt"}});});
  const reference=await screen.findByRole("button",{name:"引用到新会话"});
  expect(reference.closest('header')).toHaveAttribute('aria-label','文件工具栏');
  expect(reference).toBeDisabled();
  expect(screen.queryByRole("button",{name:"文件位置"})).toBeNull();
  expect(screen.queryByRole("combobox",{name:"目标会话"})).toBeNull();
});


it("uses the same layout and close guards for Workspace Record tabs", async () => {
  const router = fixture("/workspace/records/1", undefined, undefined, null);
  await screen.findByRole("tab", { name: /Record 1/ });
  await screen.findByLabelText("Workspace Record 1");
  expect(screen.getByRole("button", { name: "工作区首页" })).toBeInTheDocument();
  await prepareWorkspaceContentClose(workspaceRoot);
  expect(page.guard).toHaveBeenCalledWith(null, 1);
  expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: null }).tabs).toHaveLength(1);
  expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: 7 }).tabs).toHaveLength(0);
  expect(contentTabRoute(null, { id: "session-tab", object: { kind: "session", id: "session", title: "Session" }, view: {} })).toBe("/workspace?content=session-tab");
  expect(router.state.location.pathname).toBe("/workspace/records/1");
});
