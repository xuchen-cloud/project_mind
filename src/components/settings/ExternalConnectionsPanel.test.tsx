import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { queryKeys } from "../../lib/queryKeys";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { projectMindApi } from "../../services/projectMindApi";
import { ExternalConnectionsPanel } from "./ExternalConnectionsPanel";

vi.mock("../../services/externalConnectionsApi", () => ({ externalConnectionsApi: { status: vi.fn(), enable: vi.fn(), installCli: vi.fn(), uninstallCli: vi.fn(), create: vi.fn(), objects: vi.fn(), revoke: vi.fn() } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { workspaceStatusGet: vi.fn(), projectsList: vi.fn() } }));

const binding = { workspaceId: "w1", generation: "g1" };
const grant = { id: "grant-1", clientLabel: "Terminal", workspaceId: "w1", workspaceContent: false, allProjects: false, projectIds: [1], objects: null, operations: ["project.list", "context.get"], enabled: true, createdAt: "now", revokedAt: null };
const cliInstallation = { sourcePath: "/opt/mind cli", commandPath: "/home/user/.local/bin/mind", profilePath: "/home/user/.profile", installed: false, pathConfigured: false, needsUpdate: false, conflict: null, manualInstruction: null };
const baseStatus = { enabled: false, running: false, binding, cliPath: "/opt/mind cli", cliInstallation, cliShell: "posix" as const, workspacePath: "/workspace/one", connections: [] };
const project = { id: 1, name: "Active", isArchived: false };
const archived = { id: 2, name: "Archived", isArchived: true };
const recordObject = { workspaceId: "w1", scope: { kind: "project" as const, projectId: 1 }, kind: "record" as const, id: "rec-1" };
const fileObject = { workspaceId: "w1", scope: { kind: "project" as const, projectId: 1 }, kind: "file" as const, id: "file-1" };

function setup(path: string | null = "/workspace/one") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: path ? { rootPath: path } : null });
  const view = render(<QueryClientProvider client={client}><ExternalConnectionsPanel open /></QueryClientProvider>);
  return { client, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalConnectionsApi.status).mockResolvedValue(baseStatus);
  vi.mocked(externalConnectionsApi.enable).mockResolvedValue({ ...baseStatus, enabled: true, running: true });
  vi.mocked(externalConnectionsApi.installCli).mockResolvedValue({ ...baseStatus, cliInstallation: { ...cliInstallation, installed: true, pathConfigured: true } });
  vi.mocked(externalConnectionsApi.uninstallCli).mockResolvedValue(baseStatus);
  vi.mocked(externalConnectionsApi.create).mockResolvedValue(grant);
  vi.mocked(externalConnectionsApi.objects).mockResolvedValue({ items: [{ object: recordObject, title: "First record" }], nextCursor: null });
  vi.mocked(externalConnectionsApi.revoke).mockResolvedValue({ ...grant, revokedAt: "later", enabled: false });
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([project, archived] as never);
});

it("creates a selected-object grant with no session or range-level write permissions", async () => {
  const user = userEvent.setup();
  vi.mocked(externalConnectionsApi.objects)
    .mockResolvedValueOnce({ items: [{ object: recordObject, title: "First record" }], nextCursor: "page-2" })
    .mockResolvedValueOnce({ items: [{ object: fileObject, title: "Second file" }], nextCursor: null });
  setup();
  await screen.findByText("服务未运行");
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Object client");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("允许读取会话依据"));
  await user.click(screen.getByText("自定义写入权限（可选）"));
  await user.click(screen.getByLabelText("创建 Record、待办和文件"));
  await user.click(screen.getByLabelText("修改 Record 正文块"));
  await user.click(screen.getByLabelText("修改待办（包括子行动）"));
  await user.click(screen.getByLabelText("仅访问指定记录/文件"));
  expect(screen.getByLabelText("允许读取会话依据")).toBeDisabled();
  expect(screen.getByLabelText("允许读取会话依据")).not.toBeChecked();
  expect(screen.queryByLabelText("创建 Record、待办和文件")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("修改待办（包括子行动）")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建连接" })).toBeDisabled();
  await user.click(await screen.findByLabelText("First record（记录）"));
  expect(screen.getByRole("button", { name: "创建连接" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "加载更多" }));
  await user.click(await screen.findByLabelText("Second file（文件）"));
  expect(within(screen.getByRole("region", { name: "可选记录和文件" })).getByLabelText("First record（记录）")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Object client", projectIds: [1], workspaceContent: false, allProjects: false,
    sessionRead: false, writeOperations: ["record.patch"], objects: [recordObject, fileObject],
  }));
  expect(externalConnectionsApi.objects).toHaveBeenLastCalledWith(binding, { scope: { kind: "project", projectId: 1 }, query: "", cursor: "page-2" });
});

it("removes selected objects when their scope or preset is cleared", async () => {
  const user = userEvent.setup();
  setup();
  await screen.findByText("服务未运行");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("仅访问指定记录/文件"));
  await user.click(await screen.findByLabelText("First record（记录）"));
  expect(screen.getByText("已选 1/50 个记录/文件")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Active"));
  expect(screen.getByText("已选 0/50 个记录/文件")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Active"));
  await user.click(await screen.findByLabelText("First record（记录）"));
  await user.click(screen.getByLabelText("只读"));
  await user.click(screen.getByLabelText("自定义"));
  expect(screen.getByLabelText("仅访问指定记录/文件")).not.toBeChecked();
});

it("loads the new scope's first page after removing a paginated Project scope", async () => {
  const user = userEvent.setup();
  const second = { ...project, id: 3, name: "Second" };
  const secondObject = { ...recordObject, scope: { kind: "project" as const, projectId: 3 }, id: "rec-3" };
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([project, second] as never);
  vi.mocked(externalConnectionsApi.objects).mockImplementation(async (_binding, data) => {
    if (data.scope.kind === "project" && data.scope.projectId === 3) {
      expect(data.cursor).toBeNull();
      return { items: [{ object: secondObject, title: "Same title" }], nextCursor: null };
    }
    return data.cursor
      ? { items: [{ object: fileObject, title: "Page two" }], nextCursor: null }
      : { items: [{ object: recordObject, title: "Same title" }], nextCursor: "next-page" };
  });
  setup();
  await screen.findByText("服务未运行");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("Second"));
  await user.click(screen.getByLabelText("仅访问指定记录/文件"));
  await user.click(await screen.findByLabelText("Same title（记录）"));
  expect(screen.getByText("Same title（记录 · Active）")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByLabelText("Page two（文件）")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Active"));
  await waitFor(() => expect(externalConnectionsApi.objects).toHaveBeenLastCalledWith(binding, {
    scope: { kind: "project", projectId: 3 }, query: "", cursor: null,
  }));
  expect(screen.queryByText("Page two（文件）")).not.toBeInTheDocument();
  expect(await screen.findByLabelText("Same title（记录）")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Same title（记录）"));
  expect(screen.getByText("Same title（记录 · Second）")).toBeInTheDocument();
});

it("shows stored object grants without treating them as full-scope grants", async () => {
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, connections: [{ ...grant, objects: [recordObject], operations: ["record.patch", "context.read"] }] });
  setup();
  expect(await screen.findByText(/指定 1 个记录\/文件；可读取和修改/)).toBeInTheDocument();
  expect(screen.queryByText(/Project：Active；/)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByText("查看指定对象"));
  expect(screen.getByText(/rec-1 · Active/)).toBeInTheDocument();
});

it("ignores late object search results after the query changes", async () => {
  const user = userEvent.setup();
  let resolveOld!: (page: { items: { object: typeof recordObject; title: string }[]; nextCursor: null }) => void;
  vi.mocked(externalConnectionsApi.objects)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ items: [{ object: fileObject, title: "Current file" }], nextCursor: null });
  setup();
  await screen.findByText("服务未运行");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("仅访问指定记录/文件"));
  await waitFor(() => expect(externalConnectionsApi.objects).toHaveBeenCalledTimes(1));
  await user.type(screen.getByPlaceholderText("输入标题"), "new");
  expect(await screen.findByLabelText("Current file（文件）")).toBeInTheDocument();
  await act(async () => resolveOld({ items: [{ object: recordObject, title: "Old record" }], nextCursor: null }));
  expect(screen.queryByText("Old record（记录）")).not.toBeInTheDocument();
});

it("clears selected objects when the Workspace binding changes", async () => {
  const user = userEvent.setup();
  vi.mocked(externalConnectionsApi.status)
    .mockResolvedValueOnce(baseStatus)
    .mockResolvedValueOnce({ ...baseStatus, binding: { workspaceId: "w2", generation: "g2" }, workspacePath: "/workspace/two" });
  const { client } = setup();
  await screen.findByText("服务未运行");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("仅访问指定记录/文件"));
  await user.click(await screen.findByLabelText("First record（记录）"));
  expect(screen.getByText("已选 1/50 个记录/文件")).toBeInTheDocument();
  act(() => client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace/two" } }));
  await waitFor(() => expect(screen.getByLabelText("Workspace 协作（推荐）")).toBeChecked());
  await user.click(screen.getByLabelText("自定义"));
  expect(screen.getByLabelText("仅访问指定记录/文件")).not.toBeChecked();
});

it("defaults to whole Workspace collaboration while leaving an existing read-only grant unchanged", async () => {
  const user = userEvent.setup();
  const { rerender, client } = setup();
  await screen.findByText("服务未运行");
  expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  expect(externalConnectionsApi.status).toHaveBeenCalledTimes(1);
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Terminal");
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  expect(screen.getByLabelText("Workspace 协作（推荐）")).toBeChecked();
  expect(screen.getByText(/新建 Project 自动纳入/)).toBeInTheDocument();
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, { clientLabel: "Terminal", projectIds: [], workspaceContent: true, allProjects: true, sessionRead: false, writeOperations: ["content.create", "record.patch", "todo.update", "file.update", "operation.undo"], objects: null }));
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, connections: [grant] });
  await user.click(screen.getByRole("button", { name: "启用本机连接" }));
  await screen.findByText("Terminal", { selector: "strong" });
  expect(screen.getByText(/Project：Active；只读/)).toBeInTheDocument();
  expect(screen.queryByText(/context\.get/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(externalConnectionsApi.revoke).toHaveBeenCalledWith(binding, "grant-1"));
  expect(externalConnectionsApi.enable).toHaveBeenCalledWith(true);
  rerender(<QueryClientProvider client={client}><ExternalConnectionsPanel open={false} /></QueryClientProvider>);
});

it("limits single Project collaboration to one Project and shows a whole Workspace grant honestly", async () => {
  const user = userEvent.setup();
  const wholeGrant = { ...grant, id: "whole", allProjects: true, workspaceContent: true, projectIds: [], clientLabel: "Whole" };
  const projectsGrant = { ...wholeGrant, id: "projects", clientLabel: "Projects", workspaceContent: false };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce({ ...baseStatus, connections: [wholeGrant, projectsGrant] }).mockResolvedValue({ ...baseStatus, connections: [wholeGrant, projectsGrant] });
  setup();
  await screen.findByText("Whole", { selector: "strong" });
  expect(screen.getByText(/整个 Workspace（含新增 Project）；只读/)).toBeInTheDocument();
  expect(screen.getByText(/所有未归档 Project（含新增 Project）；只读/)).toBeInTheDocument();
  expect(screen.queryByText(/Project：无/)).not.toBeInTheDocument();
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "One project");
  await user.click(screen.getByLabelText("单 Project 协作"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "One project", projectIds: [1], workspaceContent: false, allProjects: false,
    sessionRead: false, writeOperations: ["content.create", "record.patch", "todo.update", "file.update", "operation.undo"], objects: null,
  }));
});

it("submits custom write permissions and displays the grant's actual rights", async () => {
  const user = userEvent.setup();
  const second = { ...project, id: 3, name: "Second" };
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([project, second, archived] as never);
  const writeGrant = { ...grant, operations: ["project.list", "context.read", "operation.read", "content.create", "record.patch", "record.restore", "todo.update", "file.update", "file.restore", "operation.undo", "operation.restore_created"] };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce(baseStatus).mockResolvedValue({ ...baseStatus, connections: [writeGrant] });
  setup();
  await screen.findByText("服务未运行");
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Writer");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("Second"));
  await user.click(screen.getByText("自定义写入权限（可选）"));
  await user.click(screen.getByLabelText("创建 Record、待办和文件"));
  await user.click(screen.getByLabelText("修改 Record 正文块"));
  await user.click(screen.getByLabelText("恢复 Record 历史版本"));
  await user.click(screen.getByLabelText("修改待办（包括子行动）"));
  await user.click(screen.getByLabelText("修改文件内容"));
  await user.click(screen.getByLabelText("恢复文件历史版本"));
  await user.click(screen.getByLabelText("撤销此连接自己的更改"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Writer", projectIds: [1, 3], workspaceContent: false, allProjects: false, sessionRead: false,
    writeOperations: ["content.create", "record.patch", "record.restore", "todo.update", "file.update", "file.restore", "operation.undo"], objects: null,
  }));
  expect(await screen.findAllByText(/可读取和修改：创建 Record、待办和文件、修改 Record 正文块、恢复 Record 历史版本、修改待办（包括子行动）、修改文件内容、恢复文件历史版本、撤销此连接自己的更改/)).toHaveLength(2);
  expect(screen.queryByText(/operation\.read/)).not.toBeInTheDocument();
  expect(screen.queryByText(/其他写入权限|restore_created/)).not.toBeInTheDocument();
});

it("copies a PowerShell command with quoted Windows paths", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({
    ...baseStatus,
    cliShell: "powershell",
    cliPath: "C:\\Program Files\\Mind's CLI\\mind.exe",
    workspacePath: "C:\\Users\\O'Neil\\My Work",
    connections: [{ ...grant, id: "grant'1" }],
  });
  setup();
  await user.click(await screen.findByRole("button", { name: "复制 CLI 命令" }));
  expect(writeText).toHaveBeenCalledWith("& 'C:\\Program Files\\Mind''s CLI\\mind.exe' doctor --workspace 'C:\\Users\\O''Neil\\My Work' --connection 'grant''1' --json");
  await user.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
  expect(JSON.parse(writeText.mock.lastCall![0])).toEqual({ mcpServers: { projectmind: {
    command: "C:\\Program Files\\Mind's CLI\\mind.exe",
    args: ["mcp", "serve", "--workspace", "C:\\Users\\O'Neil\\My Work", "--connection", "grant'1"],
  } } });
  expect(writeText.mock.lastCall![0]).not.toContain("token");
});

it("allows the local switch without an open Workspace but disables creation", async () => {
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, binding: null, workspacePath: null, cliPath: null });
  setup(null);
  expect(await screen.findByText("打开 Workspace 后才能创建连接。")).toBeInTheDocument();
  expect(screen.getByText("未安装")).toBeInTheDocument();
  expect(projectMindApi.projectsList).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "创建连接" })).not.toBeInTheDocument();
});

it("installs the local command without an open Workspace and shows the changed PATH status", async () => {
  const user = userEvent.setup();
  const installed = { ...baseStatus, binding: null, workspacePath: null, cliInstallation: { ...cliInstallation, installed: true, pathConfigured: true } };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce({ ...baseStatus, binding: null, workspacePath: null }).mockResolvedValue(installed);
  setup(null);
  expect(await screen.findByText("PATH 配置位置：/home/user/.profile")).toBeInTheDocument();
  expect(screen.getByText(/点击安装会写入上述命令位置并修改所示 PATH 配置/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "安装终端命令" }));
  await waitFor(() => expect(externalConnectionsApi.installCli).toHaveBeenCalledOnce());
  expect(await screen.findByText("已安装，PATH 已配置")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "卸载终端命令" })).toBeEnabled();
  expect(projectMindApi.projectsList).not.toHaveBeenCalled();
});

it("keeps local CLI controls available if the Project list fails", async () => {
  vi.mocked(projectMindApi.projectsList).mockRejectedValue(new Error("Project list unavailable"));
  setup();
  expect(await screen.findByRole("alert")).toHaveTextContent("Project list unavailable");
  expect(screen.getByRole("button", { name: "安装终端命令" })).toBeEnabled();
});

it("allows uninstall when the source disappeared and reports manual PATH work", async () => {
  const user = userEvent.setup();
  const installed = { ...baseStatus, cliPath: null, cliInstallation: { ...cliInstallation, sourcePath: null, installed: true, profilePath: null, manualInstruction: "将目录加入 PATH", pathConfigured: false } };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce(installed).mockResolvedValue(baseStatus);
  setup();
  expect(await screen.findByText("已安装，PATH 待配置")).toBeInTheDocument();
  expect(screen.getByText("手动配置：将目录加入 PATH")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "卸载终端命令" }));
  await waitFor(() => expect(externalConnectionsApi.uninstallCli).toHaveBeenCalledOnce());
  expect(await screen.findByText("未安装")).toBeInTheDocument();
});

it("disables installation for a missing source or an ownership conflict", async () => {
  const conflict = { ...baseStatus, cliInstallation: { ...cliInstallation, conflict: "命令位置由其他程序管理" } };
  vi.mocked(externalConnectionsApi.status).mockResolvedValue(conflict);
  const view = setup();
  expect(await screen.findByRole("alert")).toHaveTextContent("命令位置由其他程序管理");
  expect(screen.getByRole("button", { name: "安装终端命令" })).toBeDisabled();
  view.unmount();
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, cliInstallation: { ...cliInstallation, sourcePath: null } });
  setup();
  expect(await screen.findByRole("button", { name: "安装终端命令" })).toBeDisabled();
});

it("shows an install failure while refreshing the resulting local state", async () => {
  const user = userEvent.setup();
  const installed = { ...baseStatus, cliInstallation: { ...cliInstallation, installed: true, pathConfigured: true } };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce(baseStatus).mockResolvedValue(installed);
  vi.mocked(externalConnectionsApi.installCli).mockRejectedValue(new Error("PATH update failed"));
  setup();
  await user.click(await screen.findByRole("button", { name: "安装终端命令" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("PATH update failed");
  expect(screen.getByText("已安装，PATH 已配置")).toBeInTheDocument();
});

it("drops an old install response after the Workspace changes", async () => {
  const user = userEvent.setup();
  let resolveInstall!: (status: typeof baseStatus) => void;
  vi.mocked(externalConnectionsApi.installCli).mockImplementation(() => new Promise((resolve) => { resolveInstall = resolve; }));
  const next = { ...baseStatus, binding: { workspaceId: "w2", generation: "g2" }, workspacePath: "/workspace/two", cliInstallation: { ...cliInstallation, sourcePath: "/new/mind" } };
  vi.mocked(externalConnectionsApi.status).mockResolvedValueOnce(baseStatus).mockResolvedValue(next);
  const { client } = setup();
  await user.click(await screen.findByRole("button", { name: "安装终端命令" }));
  act(() => client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace/two" } }));
  expect(await screen.findByText("应用内 CLI：/new/mind")).toBeInTheDocument();
  await act(async () => resolveInstall({ ...baseStatus, cliInstallation: { ...cliInstallation, installed: true, pathConfigured: true } }));
  expect(screen.getByText("未安装")).toBeInTheDocument();
  expect(screen.getByText("应用内 CLI：/new/mind")).toBeInTheDocument();
});

it("permits whole Workspace collaboration without Projects and displays revoke errors", async () => {
  const user = userEvent.setup();
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([]);
  vi.mocked(externalConnectionsApi.status)
    .mockResolvedValueOnce({ ...baseStatus, connections: [grant] })
    .mockResolvedValueOnce({ ...baseStatus, connections: [grant] })
    .mockResolvedValueOnce({ ...baseStatus, connections: [{ ...grant, enabled: false, revokedAt: "later" }] });
  vi.mocked(externalConnectionsApi.revoke).mockRejectedValue(new Error("revoke failed"));
  setup();
  await screen.findByText("Terminal", { selector: "strong" });
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Workspace reader");
  expect(screen.getByRole("button", { name: "创建连接" })).toBeEnabled();
  expect(screen.getByLabelText("单 Project 协作")).toBeDisabled();
  expect(screen.getByLabelText("Workspace 协作（推荐）")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, { clientLabel: "Workspace reader", projectIds: [], workspaceContent: true, allProjects: true, sessionRead: false, writeOperations: ["content.create", "record.patch", "todo.update", "file.update", "operation.undo"], objects: null }));
  await user.click(screen.getByRole("button", { name: "撤销" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("revoke failed");
  expect(await screen.findByText("已撤销")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "复制 CLI 命令" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "复制 MCP 配置" })).not.toBeInTheDocument();
});

it("lets custom scope authorize only Workspace when there are no active Projects", async () => {
  const user = userEvent.setup();
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([archived] as never);
  setup();
  await screen.findByText("服务未运行");
  expect(screen.getByLabelText("单 Project 协作")).toBeDisabled();
  await user.click(screen.getByLabelText("自定义"));
  expect(screen.queryByRole("region", { name: "授权的 Project" })).not.toBeInTheDocument();
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Workspace custom");
  await user.click(screen.getByLabelText("另外授权 Workspace 内容"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Workspace custom", projectIds: [], workspaceContent: true, allProjects: false, sessionRead: false, writeOperations: [], objects: null,
  }));
});

it("makes the read-only preset cover the whole Workspace without write permissions", async () => {
  const user = userEvent.setup();
  setup();
  await screen.findByText("服务未运行");
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Reader");
  await user.click(screen.getByLabelText("只读"));
  expect(screen.queryByRole("region", { name: "授权的 Project" })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("允许读取会话依据"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Reader", projectIds: [], workspaceContent: true, allProjects: true, sessionRead: true, writeOperations: [], objects: null,
  }));
});

it("clears custom scope and write choices on preset and Workspace changes", async () => {
  const user = userEvent.setup();
  const second = { ...project, id: 3, name: "New" };
  vi.mocked(externalConnectionsApi.status)
    .mockResolvedValueOnce(baseStatus)
    .mockResolvedValueOnce({ ...baseStatus, binding: { workspaceId: "w2", generation: "g2" }, workspacePath: "/workspace/two" });
  vi.mocked(projectMindApi.projectsList)
    .mockResolvedValueOnce([project] as never)
    .mockResolvedValueOnce([second] as never);
  const { client } = setup();
  await screen.findByText("服务未运行");
  await user.click(screen.getByLabelText("自定义"));
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("另外授权 Workspace 内容"));
  await user.click(screen.getByLabelText("允许读取会话依据"));
  await user.click(screen.getByText("自定义写入权限（可选）"));
  await user.click(screen.getByLabelText("创建 Record、待办和文件"));
  await user.click(screen.getByLabelText("只读"));
  expect(screen.queryByLabelText("另外授权 Workspace 内容")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("自定义"));
  expect(screen.getByLabelText("另外授权 Workspace 内容")).not.toBeChecked();
  expect(screen.getByLabelText("Active")).not.toBeChecked();
  expect(screen.getByLabelText("创建 Record、待办和文件")).not.toBeChecked();
  await user.click(screen.getByLabelText("Active"));
  await user.click(screen.getByLabelText("另外授权 Workspace 内容"));
  await user.click(screen.getByLabelText("创建 Record、待办和文件"));
  act(() => client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace/two" } }));
  await waitFor(() => expect(externalConnectionsApi.status).toHaveBeenCalledTimes(2));
  await waitFor(() => {
    expect(screen.getByLabelText("Workspace 协作（推荐）")).toBeChecked();
    expect(screen.getByLabelText("允许读取会话依据")).not.toBeChecked();
  });
  await user.click(screen.getByLabelText("单 Project 协作"));
  expect(screen.getByRole("option", { name: "New" })).toBeInTheDocument();
  await user.click(screen.getByLabelText("自定义"));
  expect(screen.getByLabelText("New")).not.toBeChecked();
  expect(screen.getByLabelText("另外授权 Workspace 内容")).not.toBeChecked();
  await user.click(screen.getByText("自定义写入权限（可选）"));
  expect(screen.getByLabelText("创建 Record、待办和文件")).not.toBeChecked();
});

it("drops an old Workspace result after the current Workspace changes", async () => {
  let resolveOld!: (value: typeof baseStatus) => void;
  vi.mocked(externalConnectionsApi.status)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ ...baseStatus, binding: { workspaceId: "w2", generation: "g2" }, workspacePath: "/workspace/two" });
  const { client } = setup();
  await waitFor(() => expect(externalConnectionsApi.status).toHaveBeenCalledTimes(1));
  act(() => client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace/two" } }));
  await screen.findByText("服务未运行");
  await act(async () => resolveOld({ ...baseStatus, connections: [grant] }));
  expect(screen.getByLabelText("Workspace 协作（推荐）")).toBeChecked();
  expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
});
