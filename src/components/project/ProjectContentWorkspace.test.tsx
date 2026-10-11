import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectContentWorkspace } from "./ProjectContentWorkspace";
import { prepareProjectContentClose, prepareWorkspaceContentClose } from "../../lib/project-content-lifecycle";
import { openProjectContent } from "../../services/projectContentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { fixtureEditorState } from "../../test/recordDocumentFixture";
import { useProjectContentStore } from "../../state/project-content-store";
import type { RecordTarget } from "../../lib/record-document-types";

const page = vi.hoisted(() => ({ mounts: vi.fn(), guard: vi.fn(async (_projectId: number, _recordId: number) => undefined) }));
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
vi.mock("../document/ProjectFileContent", () => ({ ProjectFileContent: (props: { fileId: number; versionNumber?: number; line?: number }) =>
  <p>File {props.fileId} / {props.versionNumber ?? "latest"} / line {props.line ?? 1}</p> }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(), editorGet: vi.fn() } }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
const binding = { workspaceId: "workspace-tabs", generation: "open-1" };
const workspaceRoot = "/tmp/tabs";
function fixture(route = "/projects/7/records/1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Root() {
    const [active, setActive] = useState(true);
    return <><button onClick={() => setActive(value => !value)}>切换项目活动状态</button>
      <ProjectContentWorkspace workspaceRoot={workspaceRoot} projectId={7} active={active} overview={() => <p>项目概览入口</p>} /></>;
  }
  const router = createMemoryRouter([{ path: "*", element: <Root /> }], { initialEntries: [route] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
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
afterEach(() => vi.restoreAllMocks());
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
  fireEvent.click(screen.getByRole("button", { name: "Record 2的操作" })); fireEvent.click(screen.getByRole("menuitem", { name: "移动到左栏" }));
  expect(screen.getByLabelText("编辑2")).toBe(input); expect(input).toHaveValue("跨栏草稿");
  expect(page.mounts.mock.calls.filter(([, id]) => id === 2)).toHaveLength(1);
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
