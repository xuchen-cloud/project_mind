import { beforeEach, describe, expect, it } from "vitest";
import { blocksDshProjectNavigation, requestDshFileReference, setDshWorkspaceRoot, useDshFileReferences } from "./dsh-host-events";
import { useAgentPanelStore } from "../state/agent-panel-store";
import { useFeedbackStore } from "../state/feedback-store";
beforeEach(() => { useAgentPanelStore.getState().clearWorkspace(); setDshWorkspaceRoot(null); useFeedbackStore.setState({ toasts: [] }); });
describe("DSH host integration boundaries", () => {
  it("blocks leaving an executing project but allows navigation within it", () => {
    for (const path of ["/projects/2", "/projects/10", "/workspace", "/settings"]) expect(blocksDshProjectNavigation(1, path)).toBe(true);
    for (const path of ["/projects/1", "/projects/1/records/7"]) expect(blocksDshProjectNavigation(1, path)).toBe(false);
    expect(blocksDshProjectNavigation(null, "/projects/2")).toBe(false);
  });
  it("opens and queues references with workspace/project ownership, clears on workspace change", () => {
    setDshWorkspaceRoot("/workspace"); requestDshFileReference(7, "src/main.ts");
    expect(useAgentPanelStore.getState().binding).toEqual({ workspaceRoot: "/workspace", scope: { kind: "project", projectId: 7 } });
    expect(useDshFileReferences.getState().pending).toEqual([expect.objectContaining({ workspaceRoot: "/workspace", projectId: 7, path: "src/main.ts" })]);
    setDshWorkspaceRoot("/other"); expect(useDshFileReferences.getState().pending).toEqual([]);
  });
  it("does not queue into another running project's session", () => {
    setDshWorkspaceRoot("/workspace"); useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }); useAgentPanelStore.getState().setRunBusy("/workspace", 1, true);
    requestDshFileReference(2, "file.ts"); expect(useDshFileReferences.getState().pending).toEqual([]);
    expect(useFeedbackStore.getState().toasts[0]?.detail).toContain("停止任务");
  });
  it("reports missing workspace", () => { requestDshFileReference(1, "file.ts"); expect(useFeedbackStore.getState().toasts[0]?.tone).toBe("error"); });
});
