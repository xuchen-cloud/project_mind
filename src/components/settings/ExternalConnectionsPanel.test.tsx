import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import { queryKeys } from "../../lib/queryKeys";
import { externalConnectionsApi } from "../../services/externalConnectionsApi";
import { projectMindApi } from "../../services/projectMindApi";
import { ExternalConnectionsPanel } from "./ExternalConnectionsPanel";

vi.mock("../../services/externalConnectionsApi", () => ({ externalConnectionsApi: { status: vi.fn(), enable: vi.fn(), create: vi.fn(), revoke: vi.fn() } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { workspaceStatusGet: vi.fn(), projectsList: vi.fn() } }));

const binding = { workspaceId: "w1", generation: "g1" };
const grant = { id: "grant-1", clientLabel: "Terminal", workspaceId: "w1", workspaceContent: false, projectIds: [1], operations: ["project.list", "context.get"], enabled: true, createdAt: "now", revokedAt: null };
const baseStatus = { enabled: false, running: false, binding, cliPath: "/opt/mind cli", cliShell: "posix" as const, workspacePath: "/workspace/one", connections: [] };
const project = { id: 1, name: "Active", isArchived: false };
const archived = { id: 2, name: "Archived", isArchived: true };

function setup(path: string | null = "/workspace/one") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: path ? { rootPath: path } : null });
  const view = render(<QueryClientProvider client={client}><ExternalConnectionsPanel open /></QueryClientProvider>);
  return { client, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(externalConnectionsApi.status).mockResolvedValue(baseStatus);
  vi.mocked(externalConnectionsApi.enable).mockResolvedValue({ ...baseStatus, enabled: true, running: true });
  vi.mocked(externalConnectionsApi.create).mockResolvedValue(grant);
  vi.mocked(externalConnectionsApi.revoke).mockResolvedValue({ ...grant, revokedAt: "later", enabled: false });
  vi.mocked(projectMindApi.projectsList).mockResolvedValue([project, archived] as never);
});

it("loads on opening, creates an explicitly scoped read connection, toggles and revokes", async () => {
  const user = userEvent.setup();
  const { rerender, client } = setup();
  await screen.findByText("服务未运行");
  expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  expect(externalConnectionsApi.status).toHaveBeenCalledTimes(1);
  await user.type(screen.getByPlaceholderText("例如：终端助手"), "Terminal");
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, { clientLabel: "Terminal", projectIds: [1], workspaceContent: false, sessionRead: false }));
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
});

it("allows the local switch without an open Workspace but disables creation", async () => {
  vi.mocked(externalConnectionsApi.status).mockResolvedValue({ ...baseStatus, binding: null, workspacePath: null, cliPath: null });
  setup(null);
  expect(await screen.findByText("打开 Workspace 后才能创建连接。")).toBeInTheDocument();
  expect(screen.getByText("CLI 未安装")).toBeInTheDocument();
  expect(projectMindApi.projectsList).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "创建连接" })).not.toBeInTheDocument();
});

it("permits an explicitly selected Workspace scope and displays revoke errors", async () => {
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
  expect(screen.getByRole("button", { name: "创建连接" })).toBeDisabled();
  await user.click(screen.getByLabelText("另外允许读取 Workspace 内容"));
  await user.click(screen.getByRole("button", { name: "创建连接" }));
  await waitFor(() => expect(externalConnectionsApi.create).toHaveBeenCalledWith(binding, { clientLabel: "Workspace reader", projectIds: [], workspaceContent: true, sessionRead: false }));
  await user.click(screen.getByRole("button", { name: "撤销" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("revoke failed");
  expect(await screen.findByText("已撤销")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
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
  expect(screen.getByText("Active")).toBeInTheDocument();
  expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
});
