import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeProjectFiles } from "./HomeProjectFiles";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";
import { queryKeys } from "../../lib/queryKeys";
import { createUiStoreState, useUiStore } from "../../state/ui-store";

const mutations = vi.hoisted(() => ({
  documentMetaMutation: { mutate: vi.fn(), isPending: false },
  documentAddVersionMutation: { mutate: vi.fn(), isPending: false },
  documentDeleteMutation: { mutate: vi.fn(), isPending: false },
}));
const native = vi.hoisted(() => ({ bindingGet: vi.fn(), register: vi.fn(), projectPageGet: vi.fn() }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: native.bindingGet } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { register: native.register } }));
vi.mock("../../hooks/useWindowFileDrop", () => ({ useWindowFileDrop: () => ({ nativeWindowFileDrop: false }) }));
vi.mock("../../hooks/useDocumentMutations", () => ({ useDocumentMutations: () => mutations }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { projectPageGet: native.projectPageGet, projectTagSettingsGet: async () => ({ tags: [] }) } }));
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: {
  list: vi.fn(),
} }));
const documents: ProjectSidebarDocumentItem[] = [41, 42].map((id, index) => ({
  id, projectId: 7, name: index ? "other.txt" : "result.txt", baseName: index ? "other.txt" : "result.txt", mimeType: "text/plain",
  managedPath: `/project/generated/${index ? "other.txt" : "result.txt"}`, originalPath: "", historyDirPath: "", isStarred: false,
  currentVersionNumber: 1, versionCount: 0, health: "normal", tags: index ? [] : [{ id: 9, label: "交付", colorKey: "blue" }],
}));
beforeEach(() => {
  vi.clearAllMocks();
  native.bindingGet.mockReset();
  native.register.mockReset();
  vi.mocked(projectDirectoryApi.list).mockReset();
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "" ? [{ name: "generated", relativePath: "generated", kind: "directory", bytes: 0 }] : [
    { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 1 },
    { name: "other.txt", relativePath: "generated/other.txt", kind: "file", bytes: 1 },
  ]);
  native.bindingGet.mockResolvedValue({ workspaceId: "workspace", generation: "open-1" });
  native.register.mockResolvedValue({ object: { id: "41" }, state: "ready" });
  native.projectPageGet.mockResolvedValue({ projectDocuments: documents });
  useUiStore.setState(createUiStoreState());
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function flatPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (id = 7, hiding: "hidden" | "inert" | "display" | "visibility" | false = false) => <div hidden={hiding === "hidden"} inert={hiding === "inert"} style={{ display: hiding === "display" ? "none" : undefined, visibility: hiding === "visibility" ? "hidden" : undefined }}>
    <QueryClientProvider client={client}><HomeProjectFiles fileScope={{ projectId: id, rootPath: `/project-${id}`, workspaceRoot: "/workspace", name: `Project ${id}` }} documents={documents} /></QueryClientProvider>
  </div>;
  return { client, wrap };
}

it("starts discovery for a visible flat panel while its managed list and actions remain usable", async () => {
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  const { wrap } = flatPanel();
  render(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
  expect(screen.getByRole("region", { name: "项目文件列表" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("正在发现文件");
  fireEvent.contextMenu(screen.getByRole("button", { name: /^result.txt/ }));
  expect(await screen.findByRole("menu", { name: "文件操作" })).toBeVisible();
  expect(native.projectPageGet).not.toHaveBeenCalled();
  await act(async () => pending.resolve([]));
});

it.each(["hidden", "inert", "display", "visibility"] as const)("does not activate a flat panel under a %s ancestor until shown", async hiding => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const { wrap } = flatPanel();
  const view = render(wrap(7, hiding));
  await act(async () => {});
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  expect(native.bindingGet).not.toHaveBeenCalled();
  view.rerender(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
});

it("does not carry a visible scope's demand into a newly hidden project", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const { wrap } = flatPanel();
  const view = render(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
  const bindings = native.bindingGet.mock.calls.length;
  view.rerender(wrap(8, "hidden"));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
  expect(native.bindingGet).toHaveBeenCalledTimes(bindings);
  view.rerender(wrap(8));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(projectDirectoryApi.list).toHaveBeenLastCalledWith(8, "");
});

it("does not activate while the document is hidden", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { wrap } = flatPanel();
  try {
    render(wrap());
    await act(async () => {});
    expect(projectDirectoryApi.list).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
  } finally { visibility.mockRestore(); }
});

it("shows discovery failure locally, keeps managed files usable and retries only on request", async () => {
  vi.mocked(projectDirectoryApi.list).mockRejectedValueOnce(new Error("目录暂时不可访问"));
  const { wrap } = flatPanel();
  render(wrap());
  expect(await screen.findByRole("alert")).toHaveTextContent("目录暂时不可访问");
  expect(screen.getByRole("button", { name: /^result.txt/ })).toBeVisible();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重试发现文件" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2);
});

it("reports Workspace identity errors before discovery and retries without blocking the managed list", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  native.bindingGet.mockRejectedValueOnce(new Error("工作区暂时不可用"));
  const { wrap } = flatPanel();
  render(wrap());
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区暂时不可用");
  expect(screen.getByRole("button", { name: /^result.txt/ })).toBeVisible();
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试发现文件" }));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
});

it("does not continue discovery if the panel is hidden while binding is pending", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const pending = deferred<{ workspaceId: string; generation: string }>();
  native.bindingGet.mockReturnValueOnce(pending.promise);
  const { wrap } = flatPanel();
  const view = render(wrap());
  await waitFor(() => expect(native.bindingGet).toHaveBeenCalledOnce());
  view.rerender(wrap(7, "hidden"));
  await act(async () => pending.resolve({ workspaceId: "workspace", generation: "open-1" }));
  expect(projectDirectoryApi.list).not.toHaveBeenCalled();
  view.rerender(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
});

it("reconciles visible A-B-A through the native listing cache while preserving the managed list", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const { wrap, client } = flatPanel();
  const view = render(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1));
  const key = [...queryKeys.projectDirectory("/project-7", 7, "", 0), "/workspace", "workspace", "open-1"];
  await waitFor(() => expect(client.getQueryData(key)).toBeDefined());
  view.rerender(wrap(8));
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  expect(client.getQueryData(key)).toBeDefined();
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  view.rerender(wrap());
  expect(screen.getByRole("button", { name: /^result.txt/ })).toBeVisible();
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(3));
  await act(async () => pending.resolve([]));
  expect(projectDirectoryApi.list.mock.calls).toEqual([[7, ""], [8, ""], [7, ""]]);
});

it("refreshes root changes made while flat when switching to tree without unmounting HomeFiles", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (items = documents) => <QueryClientProvider client={client}><HomeProjectFiles fileScope={{ projectId: 7, rootPath: "/project-7", workspaceRoot: "/workspace", name: "Project" }} documents={items} /></QueryClientProvider>;
  const view = render(wrap());
  const panel = view.container.querySelector(".home-rail__files");
  const key = [...queryKeys.projectDirectory("/project-7", 7, "", 0), "/workspace"];
  await waitFor(() => expect(client.getQueryData(key)).toBeDefined());
  const oldRoot = client.getQueryData<ProjectDirectoryEntry[]>(key)!;
  const added: ProjectDirectoryEntry = { name: "added.txt", kind: "file", relativePath: "added.txt", bytes: 3 };
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  // A native dirty event has retired the native cache while the flat panel has
  // only received updated registered File metadata, not a directory hint.
  view.rerender(wrap([...documents, { ...documents[0], id: 43, name: "added.txt", baseName: "added.txt", managedPath: "/project-7/added.txt" }]));
  expect(screen.getByRole("button", { name: /^added.txt/ })).toBeVisible();
  expect(client.getQueryData(key)).toEqual(oldRoot);
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  expect(view.container.querySelector(".home-rail__files")).toBe(panel);
  expect(screen.getByRole("button", { name: "generated" })).toBeVisible();
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(2));
  await act(async () => pending.resolve([...oldRoot, added]));
  expect(await screen.findByRole("button", { name: "added.txt", exact: true })).toBeVisible();
});

it("shares the initial root request when flat and tree observe it before it completes", async () => {
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  const { wrap } = flatPanel();
  render(wrap());
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledExactlyOnceWith(7, ""));
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve([{ name: "initial-root.txt", kind: "file", relativePath: "initial-root.txt", bytes: 1 }]));
  expect(await screen.findByRole("button", { name: "initial-root.txt", exact: true })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(1);
});

it("joins both remount reconciliations for a completed cached root on A-B-A", async () => {
  const { wrap, client } = flatPanel();
  const view = render(wrap());
  const key = (id: number) => [...queryKeys.projectDirectory(`/project-${id}`, id, "", 0), "/workspace"];
  await waitFor(() => expect(client.getQueryData(key(7))).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  await screen.findByRole("button", { name: "generated" });
  await act(async () => {});
  view.rerender(wrap(8));
  await waitFor(() => expect(client.getQueryState(key(8))?.fetchStatus).toBe("idle"));
  await act(async () => {});
  const reads = vi.mocked(projectDirectoryApi.list).mock.calls.length;
  const pending = deferred<ProjectDirectoryEntry[]>();
  vi.mocked(projectDirectoryApi.list).mockReturnValueOnce(pending.promise);
  view.rerender(wrap(7));
  expect(screen.getByRole("button", { name: "generated" })).toBeVisible();
  await waitFor(() => expect(projectDirectoryApi.list).toHaveBeenCalledTimes(reads + 1));
  await act(async () => {});
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(reads + 1);
  await act(async () => pending.resolve([{ name: "refreshed.txt", kind: "file", relativePath: "refreshed.txt", bytes: 1 }]));
  expect(await screen.findByRole("button", { name: "refreshed.txt", exact: true })).toBeVisible();
  expect(projectDirectoryApi.list).toHaveBeenCalledTimes(reads + 1);
});

async function unmanagedTree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace" } });
  const view = render(<QueryClientProvider client={client}><HomeProjectFiles project={{ id: 7, name: "Project", rootPath: "/project" }} documents={[]} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  return view;
}
it("keeps focus across flat/tree presentation, hides tag chips, and retains flat tag filters", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const component = (id: number | null, path: string | null, tagId: number | null = null) => <QueryClientProvider client={client}>
    <HomeProjectFiles project={{ id: 7, name: "Project", rootPath: "/project" }} documents={documents}
      activeFileId={id} activeRelativePath={path} filter={{ query: "", tagId }} />
  </QueryClientProvider>;
  const view = render(component(41, "generated/result.txt"));
  const flat = screen.getByRole("region", { name: "项目文件列表" });
  expect(within(flat).getByRole("button", { name: /^result.txt/ })).toHaveClass("is-active");
  expect(within(flat).queryByText("交付", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  expect(await screen.findByRole("button", { name: "result.txt", exact: true })).toHaveClass("is-active");
  expect(within(screen.getByRole("region", { name: "项目目录内容" })).queryByText("交付", { exact: true })).toBeNull();
  view.rerender(component(42, "generated/other.txt"));
  expect(screen.getByRole("button", { name: "result.txt", exact: true })).not.toHaveClass("is-active");
  expect(screen.getByRole("button", { name: "other.txt", exact: true })).toHaveClass("is-active");
  fireEvent.click(screen.getByRole("button", { name: "平铺展示" }));
  expect(screen.getByRole("button", { name: "other.txt", exact: true })).toHaveClass("is-active");
  view.rerender(component(null, null, 9));
  expect(screen.queryByRole("button", { name: "other.txt", exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: /^result.txt/ })).not.toHaveClass("is-active");
  expect(within(screen.getByRole("region", { name: "项目文件列表" })).queryByText("交付", { exact: true })).toBeNull();
});

it.each(["/project", "C:\\project"])("offers the same file menu and tree rename for project path %s", async rootPath => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><HomeProjectFiles project={{ id: 7, name: "Project", rootPath }} documents={documents.map(item => ({ ...item, managedPath: `${rootPath}${rootPath.includes("\\") ? "\\" : "/"}generated${rootPath.includes("\\") ? "\\" : "/"}${item.name}` }))} /></QueryClientProvider>);
  fireEvent.contextMenu(screen.getByRole("button", { name: /^result.txt/ }));
  const flatMenu = await screen.findByRole("menu", { name: "文件操作" });
  const actions = within(flatMenu).getAllByRole("menuitem").map(item => item.textContent);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt", exact: true }), { clientX: 400, clientY: 250 });
  const treeMenu = await screen.findByRole("menu", { name: "文件操作" });
  expect(within(treeMenu).getAllByRole("menuitem").map(item => item.textContent)).toEqual(actions);
  expect(await within(treeMenu).findByText("交付", { exact: true })).toBeInTheDocument();
  fireEvent.click(within(treeMenu).getByRole("menuitem", { name: "标星", exact: true }));
  expect(mutations.documentMetaMutation.mutate).toHaveBeenCalledWith({ documentId: 41, isStarred: true });
  fireEvent.contextMenu(screen.getByRole("button", { name: "result.txt", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "移除标签 交付" }));
  expect(mutations.documentMetaMutation.mutate).toHaveBeenCalledWith({ documentId: 41, tagIds: [] }, { onError: expect.any(Function) });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.keyDown(screen.getByRole("button", { name: "result.txt", exact: true }), { key: "F10", shiftKey: true });
  fireEvent.click(within(await screen.findByRole("menu", { name: "文件操作" })).getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "重命名 result.txt" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "renamed.txt" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mutations.documentMetaMutation.mutate).toHaveBeenCalledWith({ documentId: 41, baseName: "renamed.txt" }, { onSuccess: expect.any(Function) }));
  expect(screen.queryByRole("textbox", { name: "重命名 result.txt" })).toBeNull();
});

it("registers physical tree files before showing their managed actions", async () => {
  await unmanagedTree();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt" }));
  const menu = await screen.findByRole("menu", { name: "文件操作" });
  expect(native.register).toHaveBeenCalledWith({ workspaceId: "workspace", generation: "open-1" }, 7, "generated/result.txt");
  expect(native.projectPageGet).toHaveBeenCalledWith({ projectId: 7 });
  expect(await within(menu).findByText("交付", { exact: true })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "重命名 result.txt" });
  fireEvent.change(input, { target: { value: "cancelled.txt" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(mutations.documentMetaMutation.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "result.txt" })).toBeVisible();
});

it("reports native registration failures without offering unsupported actions", async () => {
  native.register.mockRejectedValueOnce(new Error("文件不可用"));
  await unmanagedTree();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件不可用");
  expect(screen.queryByRole("menu", { name: "文件操作" })).toBeNull();
});

it("does not reopen a pending physical file menu after clicking elsewhere", async () => {
  let resolve!: (file: unknown) => void;
  native.register.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await unmanagedTree();
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt" }));
  await waitFor(() => expect(native.register).toHaveBeenCalledOnce());
  fireEvent.pointerDown(screen.getByRole("button", { name: "generated" }));
  await act(async () => { resolve({ object: { id: "41" }, state: "ready" }); });
  expect(screen.queryByRole("menu", { name: "文件操作" })).toBeNull();
});

it("refreshes the physical tree when an inline rename succeeds", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><HomeProjectFiles project={{ id: 7, name: "Project", rootPath: "/project" }} documents={documents} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "result.txt" }));
  fireEvent.click(within(await screen.findByRole("menu", { name: "文件操作" })).getByRole("menuitem", { name: "重命名" }));
  const input = screen.getByRole("textbox", { name: "重命名 result.txt" });
  fireEvent.change(input, { target: { value: "renamed.txt" } });
  mutations.documentMetaMutation.mutate.mockImplementationOnce((_input, options) => {
    vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "" ? [{ name: "generated", relativePath: "generated", kind: "directory", bytes: 0 }] : [{ name: "renamed.txt", relativePath: "generated/renamed.txt", kind: "file", bytes: 1 }]);
    options?.onSuccess();
  });
  fireEvent.blur(input);
  expect(await screen.findByRole("button", { name: "renamed.txt" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "result.txt" })).toBeNull();
});

it.each([7, null])("keeps file pin at the trailing edge in flat and directory views for owner %s", async projectId => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const files = documents.map(item => ({ ...item, projectId, isStarred: item.id === 42 }));
  const component = (items = files) => <QueryClientProvider client={client}><HomeProjectFiles fileScope={{ projectId, rootPath: "/project", workspaceRoot: "/workspace", name: "Files" }} documents={items} /></QueryClientProvider>;
  const view = render(component());
  const flat = screen.getByRole("button", { name: "other.txt", exact: true });
  expect(within(flat).getByLabelText("标星")).toBe(flat.lastElementChild);
  expect(screen.getAllByRole("button").indexOf(flat)).toBeLessThan(screen.getAllByRole("button").indexOf(screen.getByRole("button", { name: /^result.txt/ })));
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  fireEvent.click(await screen.findByRole("button", { name: "generated" }));
  const tree = await screen.findByRole("button", { name: "other.txt", exact: true });
  expect(within(tree).getByLabelText("标星")).toBe(tree.lastElementChild);
  fireEvent.contextMenu(tree);
  fireEvent.click(within(await screen.findByRole("menu", { name: "文件操作" })).getByRole("menuitem", { name: "取消标星", exact: true }));
  expect(mutations.documentMetaMutation.mutate).toHaveBeenCalledWith({ documentId: 42, isStarred: false });
  view.rerender(component(files.map(item => ({ ...item, isStarred: false }))));
  expect(within(tree).queryByLabelText("标星")).toBeNull();
});
