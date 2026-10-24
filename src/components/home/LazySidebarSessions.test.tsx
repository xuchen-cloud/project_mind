import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LazySidebarSessions } from "./LazySidebarSessions";
import { getContentLayout } from "../../lib/project-content-layout";
import { useProjectContentStore } from "../../state/project-content-store";
import { useAgentPanelStore } from "../../state/agent-panel-store";

const mocks = vi.hoisted(() => {
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  return { loaded, release, moduleRequested: vi.fn(), start: vi.fn(), sessions: vi.fn(), selectSession: vi.fn() };
});
vi.mock("./ProjectSidebarSessions", async importOriginal => {
  mocks.moduleRequested();
  await mocks.loaded;
  return await importOriginal();
});
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: mocks }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(async () => ({ workspaceId: "fixture-workspace", generation: "open-1" })) } }));

it("defers session code until visible, then replaces loading feedback with real Workspace conversations", async () => {
  mocks.start.mockResolvedValue(undefined);
  mocks.sessions.mockResolvedValue([{ id: "saved", title: "工作区讨论", running: false }]);
  mocks.selectSession.mockResolvedValue("saved");
  useProjectContentStore.setState({ layouts: {} });
  useAgentPanelStore.getState().clearWorkspace();
  useAgentPanelStore.getState().bindWorkspace("/workspace");
  const props = { workspaceRoot: "/workspace", projectId: null, query: "", enabled: false };
  const view = render(<LazySidebarSessions {...props} />);
  expect(mocks.moduleRequested).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
  view.rerender(<LazySidebarSessions {...props} enabled />);
  expect(screen.getByRole("status", { name: "正在加载会话列表" })).toBeInTheDocument();
  await act(async () => mocks.release());
  const session = await screen.findByRole("button", { name: "工作区讨论" });
  expect(screen.queryByRole("status", { name: "正在加载会话列表" })).toBeNull();
  expect(mocks.sessions).toHaveBeenCalledWith(null);
  fireEvent.click(session);
  await waitFor(() => expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: "fixture-workspace", projectId: null }).tabs[0]?.object.id).toBe("saved"));
  expect(useAgentPanelStore.getState().open).toBe(false);
});
