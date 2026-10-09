import { beforeEach, describe, expect, it } from "vitest";
import { useAgentPanelStore } from "./agent-panel-store";
import type { AgentObjectRef } from "../lib/agent-types";

const binding = { workspaceId: "workspace", generation: "generation" };
const scope = { kind: "project", projectId: 1 } as const;
const object: AgentObjectRef = { workspaceId: binding.workspaceId, scope, kind: "record", id: "1" };
beforeEach(() => useAgentPanelStore.getState().clearWorkspace());

describe("explicit assistant discussion target", () => {
  it("retains selection on close and same-scope reopen, and clears it on scope or workspace change", () => {
    const state = useAgentPanelStore.getState();
    state.openPanel("/workspace", scope);
    expect(state.setDiscussionTarget(binding, object, "已有记录")).toBe(true);
    expect(useAgentPanelStore.getState().discussionTarget).toEqual({ binding, object, label: "已有记录" });
    state.closePanel(); state.openPanel("/workspace", { ...scope });
    expect(useAgentPanelStore.getState().discussionTarget?.object).toEqual(object);
    state.openPanel("/workspace", { kind: "project", projectId: 2 });
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    state.openPanel("/workspace", scope); state.setDiscussionTarget(binding, object, "已有记录");
    state.openPanel("/other-workspace", scope);
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    state.setDiscussionTarget(binding, object, "已有记录"); state.clearWorkspace();
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
  });
  it("refuses cross-scope, cross-workspace, and unsupported targets without rebinding the panel", () => {
    const state = useAgentPanelStore.getState();
    expect(state.setDiscussionTarget(binding, object, "记录")).toBe(false);
    state.openPanel("/workspace", scope);
    for (const forged of [
      { ...object, scope: { kind: "project", projectId: 2 } as const },
      { ...object, workspaceId: "other" },
      { ...object, kind: "quick_note" as const },
    ]) expect(state.setDiscussionTarget(binding, forged, "记录")).toBe(false);
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    expect(useAgentPanelStore.getState().binding).toEqual({ workspaceRoot: "/workspace", scope });
    state.setDiscussionTarget(binding, object, "记录"); state.clearDiscussionTarget();
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
  });
  it("lets a Workspace panel discuss project objects from its binding while Project panels stay local", () => {
    const state = useAgentPanelStore.getState();
    state.openPanel("/workspace", { kind: "workspace" });
    for (const kind of ["record", "todo", "file"] as const) {
      expect(state.setDiscussionTarget(binding, { ...object, kind, scope: { kind: "project", projectId: 2 } }, kind)).toBe(true);
    }
    expect(state.setDiscussionTarget(binding, { ...object, workspaceId: "other" }, "别的工作区")).toBe(false);
    state.openPanel("/workspace", scope);
    expect(useAgentPanelStore.getState().discussionTarget).toBeNull();
    expect(state.setDiscussionTarget(binding, { ...object, scope: { kind: "workspace" } }, "直属记录")).toBe(false);
    expect(state.setDiscussionTarget(binding, { ...object, scope: { kind: "project", projectId: 2 } }, "别的项目")).toBe(false);
  });
});
