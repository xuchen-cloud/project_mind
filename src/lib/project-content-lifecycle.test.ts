import { registerQuickNoteFlusher } from "./quick-note-transfer";
import { expect, it, vi } from "vitest";
import { prepareProjectContentClose, prepareWorkspaceContentClose, registerProjectContentCloseGuard, registerWorkspaceRecordCloseGuard } from "./project-content-lifecycle";

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

it("waits for the target Project QuickNote and retains the Project on failure without flushing another scope", async () => {
  let fail = true;
  const target = vi.fn(async () => { if (fail) throw new Error("QuickNote disk full"); });
  const other = vi.fn(async () => undefined);
  const content = vi.fn(async () => undefined);
  const stops = [
    registerQuickNoteFlusher("target", target, { workspaceRoot: "/drafts", projectId: 1 }),
    registerQuickNoteFlusher("other", other, { workspaceRoot: "/drafts", projectId: 2 }),
    registerProjectContentCloseGuard({ workspaceRoot: "/drafts", projectId: 1, prepare: content }),
  ];
  try {
    await expect(prepareProjectContentClose("/drafts", 1)).rejects.toThrow("QuickNote disk full");
    expect(content).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    fail = false;
    await prepareProjectContentClose("/drafts", 1);
    expect(content).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  } finally { stops.forEach(stop => stop()); }
});
