import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ panel: vi.fn(), panelLoaded: vi.fn(), projectsList: vi.fn(async () => [{ id: 1, name: "资料项目" }]), projectPageGet: vi.fn() }));
vi.mock("./AgentPanel", () => { mocked.panelLoaded(); return { AgentPanel: (props: { open: boolean; onClose: () => void; onToggleExpanded: () => void }) => {
  mocked.panel(props);
  return <section hidden={!props.open}>助手面板<input aria-label="草稿" /><button onClick={props.onClose}>关闭</button><button onClick={props.onToggleExpanded}>展开</button></section>;
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
    const shell = (root: string, overview: boolean) => <QueryClientProvider client={client}>
      <main>{overview ? <AgentLauncher scope={scope} workspaceRoot={root} visible /> : <div>Record 页面</div>}</main>
      <AgentWorkspacePanel workspaceRoot={root} />
    </QueryClientProvider>;
    const view = render(shell("/workspace", true));
    expect(mocked.panel).not.toHaveBeenCalled();
    expect(mocked.panelLoaded).not.toHaveBeenCalled();
    expect(mocked.projectsList).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    await waitFor(() => expect(mocked.panel).toHaveBeenLastCalledWith(expect.objectContaining({ scope, workspaceRoot: "/workspace", open: true, scopeName: "资料项目" })));
    expect(mocked.panelLoaded).toHaveBeenCalledOnce();
    expect(mocked.projectPageGet).not.toHaveBeenCalled();
    expect(mocked.projectsList).toHaveBeenCalledWith({ includeArchived: true });
    const field = screen.getByRole("textbox", { name: "草稿" });
    await userEvent.type(field, "已有草稿");
    view.rerender(shell("/workspace", false));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(field);
    expect(useAgentPanelStore.getState().binding?.scope).toEqual(scope);
    await userEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(useAgentPanelStore.getState().expanded).toBe(true);
    expect(screen.getByText("Record 页面")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("textbox", { name: "草稿" })).not.toBeInTheDocument();
    view.rerender(shell("/workspace", true));
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(field);
    expect(field).toHaveValue("已有草稿");
    useAgentPanelStore.getState().setDiscussionTarget(
      { workspaceId: "workspace", generation: "generation" },
      { workspaceId: "workspace", scope, kind: "record", id: "42" }, "旧工作区记录",
    );
    view.rerender(shell("/another-workspace", true));
    expect(useAgentPanelStore.getState().binding).toBeNull();
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    expect(screen.queryByText("助手面板")).not.toBeInTheDocument();
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
});
