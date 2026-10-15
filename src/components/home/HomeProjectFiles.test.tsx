import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeProjectFiles } from "./HomeProjectFiles";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
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
  vi.mocked(projectDirectoryApi.list).mockImplementation(async (_id, path) => path === "" ? [{ name: "generated", relativePath: "generated", kind: "directory", bytes: 0 }] : [
    { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 1 },
    { name: "other.txt", relativePath: "generated/other.txt", kind: "file", bytes: 1 },
  ]);
  native.bindingGet.mockResolvedValue({ workspaceId: "workspace", generation: "open-1" });
  native.register.mockResolvedValue({ object: { id: "41" }, state: "ready" });
  native.projectPageGet.mockResolvedValue({ projectDocuments: documents });
  useUiStore.setState(createUiStoreState());
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
