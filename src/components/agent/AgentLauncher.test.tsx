import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const panel = vi.hoisted(() => vi.fn());
vi.mock("./AgentPanel", () => ({ AgentPanel: (props: { open: boolean }) => { panel(props); return props.open ? <div>助手面板</div> : null; } }));
import { AgentLauncher } from "./AgentLauncher";
const scope = { kind: "project", projectId: 1 } as const;
beforeEach(() => panel.mockClear());
describe("assistant entry", () => {
  it("does not mount or preload the panel until opened and retains it for a background run", async () => {
    render(<AgentLauncher scope={scope} workspaceRoot="/workspace" />);
    expect(panel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    expect(screen.getByText("助手面板")).toBeInTheDocument();
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ scope, workspaceRoot: "/workspace", open: true }));
  });
  it("hides an open panel when its resident Project page becomes inactive", async () => {
    const view = render(<AgentLauncher scope={scope} workspaceRoot="/workspace" visible />);
    await userEvent.click(screen.getByRole("button", { name: "助手" }));
    view.rerender(<AgentLauncher scope={scope} workspaceRoot="/workspace" visible={false} />);
    expect(screen.queryByText("助手面板")).not.toBeInTheDocument();
    expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
  });
});
