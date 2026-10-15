import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ panel: vi.fn(), panelLoaded: vi.fn(), projectsList: vi.fn(async () => [{ id: 1, name: "资料项目" }]), projectPageGet: vi.fn() }));
vi.mock("./DshAssistantPanel", () => { mocked.panelLoaded(); return { DshAssistantPanel: (props: { open: boolean; expanded: boolean; onClose: () => void; onToggleExpanded: () => void }) => {
  mocked.panel(props);
  return <section hidden={!props.open}>DSH 助手面板<input aria-label="草稿" /><button onClick={props.onClose}>关闭</button><button onClick={props.onToggleExpanded}>{props.expanded ? "收起" : "展开"}</button></section>;
} }; });
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { projectsList: mocked.projectsList, projectPageGet: mocked.projectPageGet } }));
import { AgentLauncher } from "./AgentLauncher";
import { AgentWorkspacePanel } from "./AgentWorkspacePanel";
import { useAgentPanelStore } from "../../state/agent-panel-store";
const scope = { kind: "project", projectId: 1 } as const;
beforeEach(() => { vi.clearAllMocks(); useAgentPanelStore.getState().clearWorkspace(); });
describe("assistant workspace entry", () => {
  it("opens the bound shell lazily, keeps it across Record navigation and close, and clears on workspace switch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shell = (root: string, overview: boolean, currentProjectId = 1) => <QueryClientProvider client={client}>
      <main>{overview ? <AgentLauncher scope={{ kind: "project", projectId: currentProjectId }} workspaceRoot={root} visible /> : <div>Record 页面</div>}</main>
      <AgentWorkspacePanel workspaceRoot={root} currentProjectId={currentProjectId} />
    </QueryClientProvider>;
    const view = render(shell("/workspace", true));
    expect(mocked.panel).not.toHaveBeenCalled();
    expect(mocked.panelLoaded).not.toHaveBeenCalled();
    expect(mocked.projectsList).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    await waitFor(() => expect(mocked.panel).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceRoot: "/workspace", projectId: 1, open: true, expanded: true })));
    expect(mocked.panel.mock.lastCall?.[0]).not.toHaveProperty("scope");
    expect(mocked.panel.mock.lastCall?.[0]).not.toHaveProperty("scopeName");
    expect(mocked.panelLoaded).toHaveBeenCalledOnce();
    expect(mocked.projectPageGet).not.toHaveBeenCalled();
    expect(mocked.projectsList).not.toHaveBeenCalled();
    const field = await screen.findByRole("textbox", { name: "草稿" });
    await userEvent.type(field, "已有草稿");
    view.rerender(shell("/workspace", false));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(field);
    expect(useAgentPanelStore.getState().binding?.scope).toEqual(scope);
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(useAgentPanelStore.getState().expanded).toBe(false);
    expect(screen.getByText("Record 页面")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("textbox", { name: "草稿" })).not.toBeInTheDocument();
    view.rerender(shell("/workspace", true));
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(field);
    expect(field).toHaveValue("已有草稿");
    expect(useAgentPanelStore.getState().expanded).toBe(false);
    view.rerender(shell("/workspace", true, 2));
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 });
    expect(screen.getByRole("textbox", { name: "草稿" })).not.toBe(field);
    expect(screen.getByRole("textbox", { name: "草稿" })).toHaveValue("");
    expect(useAgentPanelStore.getState().expanded).toBe(true);
    expect(mocked.panelLoaded).toHaveBeenCalledOnce();
    expect(mocked.projectsList).not.toHaveBeenCalled();
    act(() => useAgentPanelStore.getState().setDiscussionTarget(
      { workspaceId: "workspace", generation: "generation" },
      { workspaceId: "workspace", scope: { kind: "project", projectId: 2 }, kind: "record", id: "42" }, "旧工作区记录",
    ));
    view.rerender(shell("/another-workspace", true));
    expect(useAgentPanelStore.getState().binding).toBeNull();
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    expect(screen.queryByText("DSH 助手面板")).not.toBeInTheDocument();
    expect(field.isConnected).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "草稿" })).not.toBe(field));
    expect(screen.getByRole("textbox", { name: "草稿" })).toHaveValue("");
    expect(mocked.panel).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceRoot: "/another-workspace", open: true, expanded: true }));
  });
  it("does not close or rebind when its resident launcher becomes inactive", async () => {
    const view = render(<AgentLauncher scope={scope} workspaceRoot="/workspace" visible />);
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    view.rerender(<AgentLauncher scope={{ kind: "project", projectId: 2 }} workspaceRoot="/workspace" visible={false} />);
    expect(screen.getByRole("button", { name: "助手" })).toBeDisabled();
    expect(useAgentPanelStore.getState()).toMatchObject({ open: true, binding: { workspaceRoot: "/workspace", scope } });
    view.rerender(<AgentLauncher scope={{ kind: "project", projectId: 2 }} workspaceRoot="/workspace" visible />);
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 });
  });
  it("keeps the original binding when the same scope is reopened", () => {
    act(() => useAgentPanelStore.getState().openPanel("/workspace", scope));
    const binding = useAgentPanelStore.getState().binding;
    act(() => { useAgentPanelStore.getState().closePanel(); useAgentPanelStore.getState().openPanel("/workspace", { ...scope }); });
    expect(useAgentPanelStore.getState().binding).toBe(binding);
  });
  it("opens the Workspace entry without a project", async () => {
    render(<AgentLauncher scope={{ kind: "workspace" }} workspaceRoot="/workspace" visible />);
    const button = screen.getByRole("button", { name: "助手" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "workspace" });
  });
  it("follows Workspace and Project navigation, clears the old target, and follows navigation only while open", async () => {
    const client = new QueryClient();
    const shell = (currentProjectId: number | null) => <QueryClientProvider client={client}>
      <AgentWorkspacePanel workspaceRoot="/workspace" currentProjectId={currentProjectId} />
    </QueryClientProvider>;
    act(() => useAgentPanelStore.getState().openPanel("/workspace", scope));
    const view = render(shell(1)); await screen.findByRole("textbox", { name: "草稿" });
    act(() => useAgentPanelStore.getState().setDiscussionTarget(
      { workspaceId: "workspace", generation: "generation" },
      { workspaceId: "workspace", scope, kind: "record", id: "42" }, "旧项目记录"));
    view.rerender(shell(null));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBeVisible();
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "workspace" });
    expect(mocked.panel).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, projectId: null }));
    view.rerender(shell(2));
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 });
    act(() => useAgentPanelStore.getState().closePanel());
    view.rerender(shell(3));
    expect(useAgentPanelStore.getState().binding?.scope).toEqual({ kind: "project", projectId: 2 });
    expect(mocked.panel).toHaveBeenLastCalledWith(expect.objectContaining({ open: false, projectId: 2 }));
  });
});
