import { expect, it, vi } from "vitest";
import { prepareWorkspaceContentClose, registerProjectContentCloseGuard, registerWorkspaceRecordCloseGuard } from "./project-content-lifecycle";

it("prepares each editor once when an awaited save re-registers its guard", async () => {
  const prepare = vi.fn(async () => { stop(); stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare }); });
  let stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare });
  try {
    await prepareWorkspaceContentClose("/workspace");
    expect(prepare).toHaveBeenCalledOnce();
  } finally { stop(); }
});

it('prepares the Workspace layout and Project layouts without crossing Workspace roots', async () => {
  const workspace = vi.fn(async () => {}), project = vi.fn(async () => {}), foreign = vi.fn(async () => {});
  const stops = [registerProjectContentCloseGuard({ workspaceRoot: '/current', projectId: null, prepare: workspace }),
    registerProjectContentCloseGuard({ workspaceRoot: '/current', projectId: 1, prepare: project }),
    registerProjectContentCloseGuard({ workspaceRoot: '/other', projectId: null, prepare: foreign })];
  try { await prepareWorkspaceContentClose('/current');expect(workspace).toHaveBeenCalledOnce();expect(project).toHaveBeenCalledOnce();expect(foreign).not.toHaveBeenCalled(); }
  finally { stops.forEach(stop => stop()); }
});
