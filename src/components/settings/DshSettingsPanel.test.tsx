import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshSettingsPanel } from "./DshSettingsPanel";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { DSH_BUSY_MESSAGE } from "../../lib/dsh-host-events";
const mocks = vi.hoisted(() => ({ command: vi.fn(), hosts: [] as { projectId: number; mode: string; onError?: (msg: string) => void }[] }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: mocks.command } }));
vi.mock("@project-mind/dsh-ui/adapters", () => ({ DshSettingsHost: (props: typeof mocks.hosts[number]) => { mocks.hosts.push(props); return <div data-testid="settings-host">{props.projectId}:{props.mode}</div>; } }));
function setup(path = "/projects/2") {
  const client = new QueryClient();
  const shell = (open: boolean) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/projects/:projectId" element={<DshSettingsPanel open={open} />} /><Route path="*" element={<DshSettingsPanel open={open} />} />
  </Routes></MemoryRouter></QueryClientProvider>;
  const view = render(shell(true)); return { ...view, update: (open: boolean) => view.rerender(shell(open)) };
}
beforeEach(() => { mocks.command.mockReset().mockResolvedValue(undefined); mocks.hosts = []; useAgentPanelStore.getState().clearWorkspace(); });
describe("React DSH settings", () => {
  it("uses route ownership and reuses the Host for official settings/plugins modes", async () => {
    useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }); const view = setup();
    expect(await screen.findByTestId("settings-host")).toHaveTextContent("2:plugins");
    expect(mocks.command).toHaveBeenCalledWith("dsh_assistant_start", { projectId: 2 });
    fireEvent.click(screen.getByRole("button", { name: "设置", exact: true })); expect(screen.getByTestId("settings-host")).toHaveTextContent("2:settings"); expect(mocks.command).toHaveBeenCalledTimes(1);
    const old = mocks.hosts.at(-1)!; view.update(false); expect(screen.queryByTestId("settings-host")).toBeNull(); act(() => old.onError?.("stale closed error")); expect(screen.queryByRole("alert")).toBeNull(); view.unmount(); act(() => old.onError?.("stale"));
  });
  it("has no workspace runtime or independent model configuration", () => {
    useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }); setup("/workspace");
    expect(screen.getByText("请先进入项目，再打开 DSH 助手设置")).toBeVisible(); expect(mocks.command).not.toHaveBeenCalled();
  });
  it("shows native locked errors and retries", async () => {
    mocks.command.mockRejectedValueOnce(new Error("主模型已锁定")); setup(); expect(await screen.findByRole("alert")).toHaveTextContent("已锁定");
    fireEvent.click(screen.getByRole("button", { name: "重试" })); await screen.findByTestId("settings-host"); expect(mocks.command).toHaveBeenCalledTimes(2);
  });
  it("does not mount a late startup after close", async () => {
    let resolve!: () => void; mocks.command.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const view = setup(); await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(1)); view.update(false);
    await act(async () => resolve()); expect(screen.queryByTestId("settings-host")).toBeNull();
  });
  it("does not replace a running project's runtime", () => {
    useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }); useAgentPanelStore.getState().setRunBusy("/workspace", 1, true); setup();
    expect(screen.getByRole("status")).toHaveTextContent(DSH_BUSY_MESSAGE); expect(mocks.command).not.toHaveBeenCalled();
  });
});
