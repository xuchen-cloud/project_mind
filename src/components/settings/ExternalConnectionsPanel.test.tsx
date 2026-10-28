import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
  vi.mocked(externalConnectionsApi.revoke).mockResolvedValue({ ...grant, revokedAt: "later", enabled: false });
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([project, archived] as never);
});

it("defaults to Workspace collaboration and creates a scope grant without history or object selectors", async () => {
  const user = userEvent.setup();
  setup();
  await screen.findByText("服务未运行");
  expect(screen.getByLabelText("Workspace（包含所有未归档 Project）")).toBeChecked();
  expect(screen.getByLabelText("协作（推荐）")).toBeChecked();
  expect(screen.getByText(/恢复记录和文件历史版本，并撤销此连接自己的更改/)).toBeInTheDocument();
  expect(screen.queryByLabelText("允许读取会话依据")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("仅访问指定记录/文件")).not.toBeInTheDocument();
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Terminal");
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Terminal", projectIds: [], workspaceContent: true, allProjects: true,
    writeOperations: ["content.create", "record.patch", "record.restore", "todo.update", "file.update", "file.restore", "operation.undo"],
  }));
});

it("supports one Project with read-only or collaboration permissions", async () => {
  const user = userEvent.setup();
  setup();
  await screen.findByText("服务未运行");
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Project client");
  await user.click(screen.getByLabelText("单个 Project"));
  await user.click(screen.getByLabelText("只读"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "Project client", projectIds: [1], workspaceContent: false, allProjects: false,
    writeOperations: [],
  }));
  await user.click(screen.getByLabelText("协作（推荐）"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenLastCalledWith(binding, {
    clientLabel: "Project client", projectIds: [1], workspaceContent: false, allProjects: false,
    writeOperations: ["content.create", "record.patch", "record.restore", "todo.update", "file.update", "file.restore", "operation.undo"],
  }));
});

it("marks legacy object grants unusable and requires new scope authorization", async () => {
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, connections: [{ ...grant, objects: [recordObject] }] });
  setup();
  expect(await screen.findByText(/旧对象范围连接已停用/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "复制 CLI 命令" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "复制 MCP 配置" })).not.toBeInTheDocument();
  expect(screen.getByText("查看指定对象")).toBeInTheDocument();
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

it("escapes typographic apostrophes in copied PowerShell paths without changing MCP paths", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const cliPath = String.raw`C:\Apps\Mind’s CLI\mind.exe`;
  const workspacePath = String.raw`\\?\UNC\server\‘共享’\‚工作‛ $HOME`;
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({
    ...baseStatus, cliShell: "powershell", cliPath, workspacePath, connections: [grant],
  });
  setup();
  await user.click(await screen.findByRole("button", { name: "复制 CLI 命令" }));
  expect(writeText).toHaveBeenCalledWith(String.raw`& 'C:\Apps\Mind’’s CLI\mind.exe' doctor --workspace '\\?\UNC\server\‘‘共享’’\‚‚工作‛‛ $HOME' --connection 'grant-1' --json`);
  await user.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
  expect(JSON.parse(writeText.mock.lastCall![0]).mcpServers.projectmind).toEqual({
    command: cliPath, args: ["mcp", "serve", "--workspace", workspacePath, "--connection", grant.id],
  });
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

it("excludes scheduled task management from a read-only Workspace connection", async () => {
  const user = userEvent.setup();
  setup();
  await screen.findByText("服务未运行");
  const schedules = screen.getByLabelText("管理定时任务（可让 AI 操作整个工作区）");
  await user.click(schedules);
  expect(schedules).toBeChecked();
  await user.click(screen.getByLabelText("只读"));
  expect(schedules).toBeDisabled();
  expect(schedules).not.toBeChecked();
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "只读助手");
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, {
    clientLabel: "只读助手", projectIds: [], workspaceContent: true, allProjects: true, writeOperations: [],
  }));
  await user.click(screen.getByLabelText("协作（推荐）"));
  expect(schedules).toBeEnabled();
  expect(schedules).toBeChecked();
  await user.click(schedules);
  expect(schedules).not.toBeChecked();
  await user.click(schedules);
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(vi.mocked(externalConnectionsApi.create).mock.lastCall?.[1].writeOperations).toContain("schedule.manage"));
});
