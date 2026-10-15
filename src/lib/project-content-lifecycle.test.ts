import { expect, it, vi } from "vitest";
import { prepareWorkspaceContentClose, registerWorkspaceRecordCloseGuard } from "./project-content-lifecycle";

it("prepares each editor once when an awaited save re-registers its guard", async () => {
  const prepare = vi.fn(async () => { stop(); stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare }); });
  let stop = registerWorkspaceRecordCloseGuard({ workspaceRoot: "/workspace", recordId: 7, prepare });
  try {
    await prepareWorkspaceContentClose("/workspace");
    expect(prepare).toHaveBeenCalledOnce();
  } finally { stop(); }
});
