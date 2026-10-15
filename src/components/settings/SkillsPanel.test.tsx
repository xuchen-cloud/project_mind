import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { SkillsPanel } from "./SkillsPanel";

const mocks = vi.hoisted(() => ({ list: vi.fn(), workspace: vi.fn(), projects: vi.fn(), file: vi.fn(), folder: vi.fn() }));
vi.mock("../../services/skillsApi", () => ({ skillsApi: { list: mocks.list } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { workspaceStatusGet: mocks.workspace, projectsList: mocks.projects } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { openFile: mocks.file, openFolder: mocks.folder } }));

const catalog = { skills: [
  { name: "CLI", description: "使用命令行管理工作区", path: "/builtin/CLI/SKILL.md", source: "bundled" },
  { name: "Research", description: "研究资料", path: null, source: "project-agents" },
], directories: ["/skills"], complete: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(path = "/projects") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/projects" element={<SkillsPanel open />} />
    <Route path="/projects/:projectId" element={<SkillsPanel open />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue({ currentWorkspace: null });
  mocks.projects.mockResolvedValue([{ id: 7, name: "Native Project" }]);
  mocks.list.mockResolvedValue(catalog);
  mocks.file.mockResolvedValue(undefined);
  mocks.folder.mockResolvedValue(undefined);
});

describe("SkillsPanel", () => {
  it("shows the full catalog and opens builtin files and directories without a project or model", async () => {
    mount();
    expect(await screen.findByText("CLI")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("使用命令行管理工作区")).toBeInTheDocument();
    expect(screen.getByText("内置")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(null);
    await userEvent.click(screen.getByRole("button", { name: "打开 CLI" }));
    expect(mocks.file).toHaveBeenCalledWith("/builtin/CLI/SKILL.md");
    expect(screen.queryByRole("button", { name: "打开 Research" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开目录 /skills" }));
    expect(mocks.folder).toHaveBeenCalledWith("/skills");
  });
  it("shows loading, failure, retry, incomplete discovery and refresh", async () => {
    const pending = deferred<typeof catalog>();
    mocks.list.mockReturnValueOnce(pending.promise);
    mount();
    expect(await screen.findByText("正在发现 Skills…")).toBeInTheDocument();
    await act(async () => pending.reject(new Error("discovery failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("discovery failed");
    mocks.list.mockResolvedValue({ ...catalog, complete: false });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/发现尚未完成/)).toBeInTheDocument();
    expect(screen.getByText("CLI")).toBeInTheDocument();
    mocks.list.mockResolvedValue(catalog);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.queryByText(/发现尚未完成/)).not.toBeInTheDocument());
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });
  it("defaults to the route project and switches discovery to the selected native project", async () => {
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
    mount("/projects/7");
    await screen.findByText("CLI");
    expect(mocks.list).toHaveBeenCalledWith(7);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "");
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(null));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(7));
  });
  it("discards old catalog and open errors after workspace changes", async () => {
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/old" } });
    const opening = deferred<void>();
    mocks.file.mockReturnValueOnce(opening.promise);
    const { client } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "打开 CLI" }));
    const oldCatalog = deferred<typeof catalog>();
    mocks.list.mockReturnValueOnce(oldCatalog.promise);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    mocks.list.mockResolvedValue({ skills: [{ ...catalog.skills[0], name: "New skill" }], directories: [], complete: true });
    act(() => { client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/new" } }); });
    expect(await screen.findByText("New skill")).toBeInTheDocument();
    await act(async () => { oldCatalog.resolve(catalog); opening.reject(new Error("old open error")); });
    expect(screen.queryByText("CLI")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("refreshes after the workspace status changes even when the root is unchanged", async () => {
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
    const { client } = mount();
    await screen.findByText("CLI");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(7));
    const calls = mocks.list.mock.calls.length;
    act(() => { client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace" } }, { updatedAt: Date.now() + 1000 }); });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list).toHaveBeenLastCalledWith(7);
    expect(screen.getByRole("combobox", { name: "发现范围" })).toHaveValue("7");
  });
  it("ignores stale discovery and opening failures when switching projects", async () => {
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
    const opening = deferred<void>();
    mocks.folder.mockReturnValueOnce(opening.promise);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "打开目录 /skills" }));
    const old = deferred<typeof catalog>();
    mocks.list.mockReturnValueOnce(old.promise);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    mocks.list.mockResolvedValue({ ...catalog, skills: [{ ...catalog.skills[0], name: "Project skill" }] });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
    expect(await screen.findByText("Project skill")).toBeInTheDocument();
    await act(async () => { old.resolve(catalog); opening.reject(new Error("outdated open")); });
    expect(screen.queryByText("CLI")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows friendly DSH source labels while preserving custom source names", async () => {
    mocks.list.mockResolvedValue({ ...catalog, skills: ["bundled", "project-dsh", "user-agents", "company"].map(source => ({ name: source, source, path: null, description: "" })) });
    mount();
    expect(await screen.findByText("内置")).toBeInTheDocument();
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("用户")).toBeInTheDocument();
    expect(screen.getAllByText("company")).toHaveLength(2);
  });
  it("reports opening failure and allows trying the same file again", async () => {
    mocks.file.mockRejectedValueOnce(new Error("cannot open"));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "打开 CLI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot open");
    await userEvent.click(screen.getByRole("button", { name: "打开 CLI" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mocks.file).toHaveBeenCalledTimes(2);
  });
});
