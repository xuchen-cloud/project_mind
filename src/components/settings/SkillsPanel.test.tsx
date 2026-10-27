import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { SkillsPanel } from "./SkillsPanel";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), import: vi.fn(), pick: vi.fn(), list: vi.fn(), manage: vi.fn(), workspace: vi.fn(), projects: vi.fn(), file: vi.fn(), folder: vi.fn() }));
vi.mock("../../services/skillsApi", () => ({ skillsApi: { list: mocks.list, cancel: mocks.cancel, manage: mocks.manage, import: mocks.import } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { workspaceStatusGet: mocks.workspace, projectsList: mocks.projects } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { openFile: mocks.file, openFolder: mocks.folder, pickFile: mocks.pick } }));

const catalog = { skills: [
  { name: "CLI", description: "使用命令行管理工作区", path: "/builtin/CLI/SKILL.md", source: "bundled", disabled: false, entryPath: "/builtin/CLI", directory: "/builtin/CLI", canDelete: false },
  { name: "Research", description: "研究资料", path: null, source: "project-agents", disabled: false, entryPath: null, directory: null, canDelete: false },
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
  mocks.cancel.mockResolvedValue(null);
  mocks.file.mockResolvedValue(undefined);
  mocks.folder.mockResolvedValue(undefined);
});

describe("SkillsPanel", () => {
  it("imports a chosen archive in the selected scope and refreshes the visible catalog", async () => {
    mocks.pick.mockResolvedValue("/downloads/research.zip");
    mocks.import.mockResolvedValue({ ...catalog, skills: [...catalog.skills, { ...catalog.skills[1], name: "Imported", description: "Imported instructions" }] });
    mount("/projects/7");
    await userEvent.click(await screen.findByRole("button", { name: "导入 Skill" }));
    expect(mocks.import).toHaveBeenCalledWith(7, "/downloads/research.zip");
    expect(await screen.findByText("Imported instructions")).toBeInTheDocument();
  });
  it("cancels import without invoking native mutation and reports import failures", async () => {
    mocks.pick.mockResolvedValueOnce(null).mockResolvedValueOnce("/bad.zip");
    mocks.import.mockRejectedValue(new Error("SKILL.md 无效"));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "导入 Skill" }));
    expect(mocks.import).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "导入 Skill" }));
    expect(await screen.findByText("SKILL.md 无效")).toBeInTheDocument();
    expect(screen.getByText("CLI")).toBeInTheDocument();
  });
  it("disables and re-enables builtins, keeping them visible without a delete action", async () => {
    const disabled = { ...catalog, skills: [{ ...catalog.skills[0], disabled: true, entryPath: "/builtin/.disabled/CLI", directory: "/builtin/.disabled/CLI" }] };
    mocks.manage.mockResolvedValueOnce(disabled).mockResolvedValueOnce(catalog);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "禁用 CLI" }));
    expect(mocks.manage).toHaveBeenLastCalledWith(null, "/builtin/CLI", "disable");
    expect(await screen.findByText("已禁用")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 CLI" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "启用 CLI" }));
    expect(mocks.manage).toHaveBeenLastCalledWith(null, "/builtin/.disabled/CLI", "enable");
    await waitFor(() => expect(screen.queryByText("已禁用")).not.toBeInTheDocument());
  });
  it("requires explicit confirmation before deleting an external skill and preserves it on failure", async () => {
    const external = { ...catalog.skills[0], name: "Notes", source: "user-agents", canDelete: true, entryPath: "/skills/Notes" };
    mocks.list.mockResolvedValue({ ...catalog, skills: [external] });
    mocks.manage.mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce({ ...catalog, skills: [] });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "删除 Notes" }));
    expect(mocks.manage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.manage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "删除 Notes" }));
    const dialog = screen.getByRole("dialog", { name: "删除 Notes？" });
    expect(dialog).toHaveTextContent("无法在应用中撤销");
    await userEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    expect(mocks.manage).toHaveBeenLastCalledWith(null, "/skills/Notes", "delete");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("permission denied");
    await userEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("未发现 Skills。")).toBeInTheDocument();
  });
  it("shows management errors without changing state and blocks duplicate operations while pending", async () => {
    const pending = deferred<typeof catalog>();
    mocks.manage.mockReturnValueOnce(pending.promise);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "禁用 CLI" }));
    expect(screen.getByRole("button", { name: "禁用 CLI" })).toBeDisabled();
    await act(async () => pending.reject(new Error("target exists")));
    expect(await screen.findByRole("alert")).toHaveTextContent("target exists");
    expect(screen.getByRole("button", { name: "禁用 CLI" })).toBeEnabled();
    expect(screen.queryByText("已禁用")).not.toBeInTheDocument();
  });
  it("discards a management result after switching discovery scope", async () => {
    const pending = deferred<typeof catalog>();
    mocks.manage.mockReturnValueOnce(pending.promise);
    mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "禁用 CLI" }));
    mocks.list.mockResolvedValue({ ...catalog, skills: [{ ...catalog.skills[0], name: "Project skill" }] });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
    expect(await screen.findByText("Project skill")).toBeInTheDocument();
    await act(async () => pending.resolve({ ...catalog, skills: [] }));
    expect(screen.getByText("Project skill")).toBeInTheDocument();
    expect(screen.queryByText("未发现 Skills。")).not.toBeInTheDocument();
  });
  it("pins bundled skills in their original order and labels them beside their names", async () => {
    const skill = (name: string, source: string) => ({ ...catalog.skills[0], name, source, description: "", path: `/${name}/SKILL.md` });
    const skills = [skill("User A", "user-agents"), skill("CLI", "bundled"), skill("Project", "project-dsh"), skill("Built-in B", "bundled"), skill("User B", "user-agents")];
    mocks.list.mockResolvedValue({ ...catalog, skills });
    mount();
    const list = await screen.findByRole("region", { name: "Skills 列表" });
    expect(within(list).getAllByRole("heading").map(heading => heading.textContent)).toEqual(["CLI", "Built-in B", "User A", "Project", "User B"]);
    for (const name of ["CLI", "Built-in B"]) {
      const heading = within(list).getByRole("heading", { name });
      expect(within(heading.parentElement!).getByText("内置")).toBeInTheDocument();
    }
    expect(skills[0].name).toBe("User A");
    await userEvent.click(within(list).getByRole("button", { name: "打开 CLI" }));
    expect(mocks.file).toHaveBeenCalledWith("/CLI/SKILL.md");
  });
  it("shows the full catalog and opens builtin files and directories without a project or model", async () => {
    mount();
    expect(await screen.findByText("CLI")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("使用命令行管理工作区")).toBeInTheDocument();
    expect(screen.getByText("内置")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(null, expect.objectContaining({ requestId: expect.any(String) }));
    await userEvent.click(screen.getByRole("button", { name: "打开 CLI" }));
    expect(mocks.file).toHaveBeenCalledWith("/builtin/CLI/SKILL.md");
    await userEvent.click(screen.getByRole("button", { name: "打开 CLI 目录" }));
    expect(mocks.folder).toHaveBeenCalledWith("/builtin/CLI");
    expect(screen.queryByRole("button", { name: "打开 Research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 Research 目录" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开目录 /skills" }));
    expect(mocks.folder).toHaveBeenCalledWith("/skills");
  });
  it("opens the containing directory for Windows skill paths", async () => {
    mocks.list.mockResolvedValue({ ...catalog, skills: [{ ...catalog.skills[0], path: "C:\\skills\\CLI\\SKILL.md", directory: "C:\\skills\\CLI" }] });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "打开 CLI 目录" }));
    expect(mocks.folder).toHaveBeenCalledWith("C:\\skills\\CLI");
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
    expect(mocks.list).toHaveBeenCalledWith(7, expect.objectContaining({ requestId: expect.any(String) }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "");
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(null, expect.objectContaining({ requestId: expect.any(String) })));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(7, expect.objectContaining({ requestId: expect.any(String) })));
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
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(7, expect.objectContaining({ requestId: expect.any(String) })));
    const calls = mocks.list.mock.calls.length;
    act(() => { client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace" } }, { updatedAt: Date.now() + 1000 }); });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list).toHaveBeenLastCalledWith(7, expect.objectContaining({ requestId: expect.any(String) }));
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
    mocks.list.mockResolvedValue({ ...catalog, skills: ["bundled", "project-dsh", "user-agents", "company"].map(source => ({ ...catalog.skills[1], name: source, source, path: null, description: "" })) });
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


it("cancels an unfinished discovery on scope change and forces each explicit refresh", async () => {
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  const pending = deferred<typeof catalog>(); mocks.list.mockReturnValueOnce(pending.promise);
  const view = mount();
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  const options = mocks.list.mock.calls[0][1];
  expect(options.requestId).toEqual(expect.any(String));
  await screen.findByRole("option", { name: "Native Project" });
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
  expect(mocks.cancel).toHaveBeenCalledWith(options.requestId);
  await screen.findByText("CLI");
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(mocks.list).toHaveBeenLastCalledWith(7, expect.objectContaining({ refresh: true }));
  view.unmount();
});


it("keeps the same-scope catalog and file actions visible during refresh and after failure", async () => {
  const { client } = mount();
  await screen.findByText("CLI");
  const pending = deferred<typeof catalog>();
  mocks.list.mockReturnValueOnce(pending.promise);
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(screen.getByText("CLI")).toBeVisible();
  expect(screen.getByText("正在刷新 Skills…")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "打开 CLI" }));
  expect(mocks.file).toHaveBeenCalledWith("/builtin/CLI/SKILL.md");
  await act(async () => pending.reject(new Error("refresh failed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("refresh failed");
  expect(screen.getByText("CLI")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "打开 CLI 目录" }));
  expect(mocks.folder).toHaveBeenCalledWith("/builtin/CLI");
  mocks.workspace.mockRejectedValueOnce(new Error("status failed"));
  await act(async () => { await client.refetchQueries({ queryKey: queryKeys.workspaceStatus }); });
  expect(screen.getByText("CLI")).toBeVisible();
  expect(await screen.findByText("status failed")).toBeVisible();
});

it("hides old scope data immediately while the new catalog is pending", async () => {
  mocks.workspace.mockResolvedValue({ currentWorkspace: { rootPath: "/workspace" } });
  mount();
  await screen.findByText("CLI");
  const pending = deferred<typeof catalog>();
  mocks.list.mockReturnValueOnce(pending.promise);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "发现范围" }), "7");
  expect(screen.queryByText("CLI")).toBeNull();
  expect(screen.getByText("正在发现 Skills…")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "发现范围" })).toBeEnabled();
  await act(async () => pending.resolve({ ...catalog, skills: [{ ...catalog.skills[0], name: "Project skill" }] }));
  expect(await screen.findByText("Project skill")).toBeVisible();
});


it("does not let a pending refresh overwrite a Skill mutation", async () => {
  mount();
  await screen.findByText("CLI");
  const pending = deferred<typeof catalog>();
  mocks.list.mockReturnValueOnce(pending.promise);
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  const refreshedRequest = mocks.list.mock.calls.at(-1)![1].requestId;
  mocks.manage.mockResolvedValue({ ...catalog, skills: [{ ...catalog.skills[0], disabled: true }] });
  await userEvent.click(screen.getByRole("button", { name: "禁用 CLI" }));
  expect(await screen.findByText("已禁用")).toBeVisible();
  expect(mocks.cancel).toHaveBeenCalledWith(refreshedRequest);
  await act(async () => pending.resolve(catalog));
  expect(screen.getByRole("button", { name: "启用 CLI" })).toBeEnabled();
});


it("replaces an initial pending discovery on explicit refresh and ignores its late result", async () => {
  const pending = deferred<typeof catalog>();
  mocks.list.mockReturnValueOnce(pending.promise);
  mount();
  await screen.findByText("正在发现 Skills…");
  const requestId = mocks.list.mock.calls[0][1].requestId;
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("CLI")).toBeVisible();
  expect(mocks.cancel).toHaveBeenCalledWith(requestId);
  expect(mocks.list).toHaveBeenLastCalledWith(null, expect.objectContaining({ refresh: true }));
  await act(async () => pending.resolve({ ...catalog, skills: [] }));
  expect(screen.getByText("CLI")).toBeVisible();
});
