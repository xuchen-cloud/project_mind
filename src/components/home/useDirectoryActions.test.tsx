import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDirectoryBrowser } from "./ProjectDirectoryBrowser";
import { projectDirectoryQueryKey } from "../../lib/project-directory-query";

const api = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), rename: vi.fn(), trash: vi.fn(), binding: vi.fn(), confirm: vi.fn() }));
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { list: api.list, prepareChange: api.prepare, rename: api.rename, delete: api.trash } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: api.binding } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { confirm: api.confirm } }));
const binding = { workspaceId: "w", generation: "g" };
const prepared = { token: "before", identityToken: "physical-dir", relativePath: "folder", files: [{ fileId: 2, revision: 3 }] };
beforeEach(() => {
  vi.resetAllMocks();
  api.binding.mockResolvedValue(binding);
  api.list.mockResolvedValue([{ name: "folder", relativePath: "folder", kind: "directory", bytes: 0 }]);
  api.prepare.mockResolvedValue(prepared);
  api.rename.mockResolvedValue({ relativePath: "renamed", fileIds: [2] });
  api.trash.mockResolvedValue({ relativePath: null, fileIds: [2] });
  api.confirm.mockResolvedValue(true);
});
async function setup(projectId: number | null = 7) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrap = (workspaceRoot = "/workspace", generation?: string) => <QueryClientProvider client={client}><ProjectDirectoryBrowser projectId={projectId} workspaceRoot={workspaceRoot} rootPath="/root" binding={generation ? { ...binding, generation } : undefined} /></QueryClientProvider>;
  const view = render(wrap());
  const row = await screen.findByRole("button", { name: "folder" });
  return { ...view, row, invalidate, wrap, client };
}
async function rename(row: HTMLElement) {
  fireEvent.contextMenu(row);
  fireEvent.click(within(await screen.findByRole("menu", { name: "文件夹操作" })).getByRole("menuitem", { name: "重命名" }));
  return screen.findByRole("textbox", { name: "重命名文件夹 folder" });
}
it.each([7, null])("opens a folder menu by mouse/keyboard and commits inline rename (owner=%s)", async owner => {
  const view = await setup(owner);
  fireEvent.keyDown(view.row, { key: "F10", shiftKey: true });
  expect(await screen.findByRole("menu", { name: "文件夹操作" })).toBeVisible();
  fireEvent.keyDown(window, { key: "Escape" });
  const input = await rename(view.row);
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.rename).toHaveBeenCalledExactlyOnceWith({ binding, projectId: owner, relativePath: "folder", token: "before", name: "renamed", requestId: expect.any(String) }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(view.invalidate).toHaveBeenCalledWith({ queryKey: ["project-directory", "/root", owner], predicate: expect.any(Function) }, { cancelRefetch: false, throwOnError: true });
  expect(view.invalidate).toHaveBeenCalledWith({ queryKey: owner === null ? ["workspace-page"] : ["project-page", owner] }, { cancelRefetch: false, throwOnError: true });
});
it("confirms the whole folder goes to system Trash, reprepares and commits once", async () => {
  const view = await setup(null);
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledExactlyOnceWith({ binding, projectId: null, relativePath: "folder", token: "before", confirmed: true, requestId: expect.any(String) }));
  expect(api.confirm).toHaveBeenCalledWith(expect.stringContaining("整个文件夹“folder”及其中所有内容移入系统回收站"), "移入回收站");
  expect(api.prepare).toHaveBeenCalledTimes(2);
  expect(api.confirm.mock.invocationCallOrder[0]).toBeGreaterThan(api.prepare.mock.invocationCallOrder[0]);
  expect(api.trash.mock.invocationCallOrder[0]).toBeGreaterThan(api.prepare.mock.invocationCallOrder[1]);
});
it("does not mutate after cancelling Trash confirmation", async () => {
  api.confirm.mockResolvedValue(false);
  const view = await setup();
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalled());
  await act(async () => {});
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.trash).not.toHaveBeenCalled();
});
it("shows native active-editor refusal without opening or closing an editor", async () => {
  api.prepare.mockRejectedValue({ code: "active_editors", message: "请先关闭目录内打开的文件（含独立窗口）" });
  const view = await setup();
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请先关闭目录内打开的文件（含独立窗口）");
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.trash).not.toHaveBeenCalled();
});
it("keeps the inline name draft after a commit refusal and can cancel without committing", async () => {
  const view = await setup();
  const input = await rename(view.row);
  api.rename.mockRejectedValue(new Error("请先关闭目录内打开的文件"));
  fireEvent.change(input, { target: { value: "keep draft" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent("请先关闭目录内打开的文件");
  expect(input).toHaveValue("keep draft");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(api.rename).toHaveBeenCalledOnce();
});
it.each(["identity", "members", "revision", "token", "path"])("rejects changed %s after delayed confirmation", async change => {
  api.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce({ ...prepared,
    ...(change === "identity" ? { identityToken: "replacement" } : change === "token" ? { token: "metadata-changed" } : change === "path" ? { relativePath: "different" } : { files: [{ fileId: change === "members" ? 9 : 2, revision: 4 }] }),
  });
  const view = await setup();
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件夹或其中的文件已变化");
  expect(api.trash).not.toHaveBeenCalled();
});
it("discards delayed confirmation after the Workspace scope changes", async () => {
  let confirm!: (value: boolean) => void;
  api.confirm.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
  const view = await setup();
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalled());
  view.rerender(view.wrap("/other-workspace"));
  await act(async () => confirm(true));
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.trash).not.toHaveBeenCalled();
});

it("rejects a rename when only the opaque metadata token changed and retains its draft", async () => {
  const view = await setup();
  const input = await rename(view.row);
  fireEvent.change(input, { target: { value: "retain me" } });
  api.prepare.mockResolvedValue({ ...prepared, token: "changed-history-or-working-metadata" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveTextContent("文件夹或其中的文件已变化");
  expect(input).toHaveValue("retain me");
  expect(api.rename).not.toHaveBeenCalled();
});

it("stops before prepare when the scope changes while acquiring the binding", async () => {
  const view = await setup();
  let resolve!: (value: typeof binding) => void;
  api.binding.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(api.binding).toHaveBeenCalled());
  view.rerender(view.wrap("/other-workspace"));
  await act(async () => resolve(binding));
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});

it("stops a rename after scope changes during reprepare", async () => {
  const view = await setup();
  const input = await rename(view.row);
  let resolve!: (value: typeof prepared) => void;
  api.prepare.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2));
  view.rerender(view.wrap("/other-workspace"));
  await act(async () => resolve(prepared));
  expect(api.rename).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("waits for pre-commit reads then refreshes both the tree and flat page", async () => {
  const view = await setup();
  const input = await rename(view.row);
  let finishDirectory!: (value: unknown[]) => void;
  let finishPage!: (value: string) => void;
  api.list.mockReturnValueOnce(new Promise(done => { finishDirectory = done; }));
  act(() => { void view.client.refetchQueries({ queryKey: ["project-directory"] }); });
  const page = vi.fn().mockReturnValueOnce(new Promise(done => { finishPage = done; })).mockResolvedValue("fresh page");
  const observer = new QueryObserver(view.client, { queryKey: ["project-page", 7], queryFn: page });
  const unsubscribe = observer.subscribe(() => {});
  try {
    api.list.mockResolvedValue([{ name: "renamed", relativePath: "renamed", kind: "directory", bytes: 0 }]);
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.rename).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(view.invalidate).not.toHaveBeenCalled();
    await act(async () => { finishDirectory([]); finishPage("stale page"); });
    expect(await screen.findByRole("button", { name: "renamed" })).toBeVisible();
    await waitFor(() => expect(view.client.getQueryData(["project-page", 7])).toBe("fresh page"));
    expect(page).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); }
});

it("reports a failed post-commit refresh instead of silently declaring the navigation current", async () => {
  const view = await setup();
  const input = await rename(view.row);
  api.list.mockRejectedValue(new Error("目录刷新失败"));
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
  await waitFor(() => expect(screen.getAllByRole("alert").some(node => node.textContent?.includes("目录刷新失败"))).toBe(true));
  expect(api.rename).toHaveBeenCalledOnce();
});

it("retires a confirmation when the binding changes at the same Workspace path", async () => {
  let confirm!: (value: boolean) => void;
  api.confirm.mockReturnValue(new Promise(done => { confirm = done; }));
  const view = await setup();
  fireEvent.keyDown(view.row, { key: "ContextMenu" });
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(api.confirm).toHaveBeenCalledOnce());
  api.binding.mockResolvedValue({ ...binding, generation: "reopened" });
  view.rerender(view.wrap("/workspace", "reopened"));
  await act(async () => confirm(true));
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.trash).not.toHaveBeenCalled();
});

it("rejects a stale folder selection before preparing against a reopened binding", async () => {
  const view = await setup();
  view.rerender(view.wrap("/workspace", "g"));
  const row = await screen.findByRole("button", { name: "folder" });
  api.binding.mockResolvedValue({ ...binding, generation: "reopened" });
  fireEvent.contextMenu(row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.trash).not.toHaveBeenCalled();
});

it.each(["rename", "trash"])("does not refetch the removed expanded source after successful %s, and refreshes the tree and flat page", async operation => {
  let committed = false;
  const entry = (path: string, kind = "directory") => ({ name: path.split("/").pop(), relativePath: path, kind, bytes: 0 });
  api.list.mockImplementation(async (_owner, path) => {
    if (path === "") return [entry(committed && operation === "rename" ? "renamed" : "folder"), entry("folder-copy")]
      .filter(value => !(committed && operation === "trash" && value.relativePath === "folder"));
    if (committed && (path === "folder" || path.startsWith("folder/"))) throw new Error(`ENOENT: ${path}`);
    if (path === "folder") return [entry("folder/deep")];
    if (path === "folder/deep") return [entry("folder/deep/file.txt", "file")];
    return [];
  });
  api.rename.mockImplementation(async () => { committed = true; return { relativePath: "renamed", fileIds: [2] }; });
  api.trash.mockImplementation(async () => { committed = true; return { relativePath: null, fileIds: [2] }; });
  const view = await setup();
  fireEvent.click(view.row);
  fireEvent.click(await screen.findByRole("button", { name: "deep" }));
  await screen.findByRole("button", { name: "file.txt" });
  fireEvent.click(screen.getByRole("button", { name: "folder-copy" }));
  const beforeSourceReads = api.list.mock.calls.filter(([, path]) => path === "folder" || path.startsWith("folder/")).length;
  const pageKey = ["project-page", 7];
  const page = new QueryObserver(view.client, { queryKey: pageKey, staleTime: Infinity,
    initialData: ["folder/deep/file.txt"], queryFn: async () => operation === "trash" ? [] : ["renamed/deep/file.txt"] });
  const unsubscribe = page.subscribe(() => {});
  try {
    if (operation === "rename") {
      const input = await rename(view.row);
      fireEvent.change(input, { target: { value: "renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
    } else {
      fireEvent.keyDown(view.row, { key: "F10", shiftKey: true });
      fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
    }
    await waitFor(() => expect(screen.queryByRole("button", { name: "folder" })).toBeNull());
    await waitFor(() => expect(view.client.getQueryData(pageKey)).toEqual(operation === "trash" ? [] : ["renamed/deep/file.txt"]));
    if (operation === "rename") expect(await screen.findByRole("button", { name: "renamed" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.list.mock.calls.filter(([, path]) => path === "folder" || path.startsWith("folder/")).length).toBe(beforeSourceReads);
    expect(api.list.mock.calls.filter(([, path]) => path === "folder-copy")).toHaveLength(2);
    expect(view.client.getQueryState(projectDirectoryQueryKey("/root", 7, "folder/deep", "/workspace", undefined))?.isInvalidated).toBe(true);
  } finally { unsubscribe(); }
});

it("reports an existing sibling's permission error after Trash while skipping the moved source", async () => {
  let committed = false;
  const entry = (path: string) => ({ name: path, relativePath: path, kind: "directory", bytes: 0 });
  api.list.mockImplementation(async (_owner, path) => {
    if (path === "") return committed ? [entry("private")] : [entry("folder"), entry("private")];
    if (committed && path === "folder") throw new Error("ENOENT: folder");
    if (committed && path === "private") throw new Error("EACCES: private");
    return [];
  });
  api.trash.mockImplementation(async () => { committed = true; return { relativePath: null, fileIds: [2] }; });
  const view = await setup();
  fireEvent.click(view.row);
  fireEvent.click(screen.getByRole("button", { name: "private" }));
  await waitFor(() => expect(api.list).toHaveBeenCalledWith(7, "private"));
  fireEvent.contextMenu(view.row);
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移入回收站" }));
  await waitFor(() => expect(screen.getAllByRole("alert").some(node => node.textContent?.includes("EACCES: private"))).toBe(true));
  expect(api.trash).toHaveBeenCalledOnce();
  expect(api.list.mock.calls.filter(([, path]) => path === "folder")).toHaveLength(1);
});
