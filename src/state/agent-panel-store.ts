import { create } from "zustand";
import type { AgentObjectRef, AgentScope, AgentWorkspaceBinding } from "../lib/agent-types";
import { showDshBusyFeedback } from "../lib/dsh-host-events";

export interface AgentPanelBinding { workspaceRoot: string; scope: AgentScope }
export interface AgentDiscussionTarget { binding: AgentWorkspaceBinding; object: AgentObjectRef; label: string }
export function sameAgentScope(a: AgentScope, b: AgentScope) {
  return a.kind === b.kind && (a.kind === "workspace" || (b.kind === "project" && a.projectId === b.projectId));
}
/** The panel may discuss a target in its own scope; Workspace can also discuss a project's object. */
export function canDiscussObject(panelScope: AgentScope, objectScope: AgentScope) {
  return panelScope.kind === "workspace" || sameAgentScope(panelScope, objectScope);
}
export function dshProjectRunKey(workspaceRoot: string, projectId: number) { return JSON.stringify([workspaceRoot, projectId]); }
interface AgentPanelState {
  workspaceRoot: string | null;
  runsByProject: Record<string, AgentPanelBinding>;
  bindWorkspace: (workspaceRoot: string | null) => void;
  binding: AgentPanelBinding | null;
  open: boolean;
  expanded: boolean;
  discussionTarget: AgentDiscussionTarget | null;
  runningBinding: AgentPanelBinding | null;
  setRunBusy: (workspaceRoot: string, projectId: number, busy: boolean) => void;
  setDiscussionTarget: (binding: AgentWorkspaceBinding, object: AgentObjectRef, label: string) => boolean;
  clearDiscussionTarget: () => void;
  openPanel: (workspaceRoot: string, scope: AgentScope) => void;
  closePanel: () => void;
  toggleExpanded: () => void;
  clearWorkspace: () => void;
}

// Window-local UI seats and independently subscribed Project runtime facts.
export const useAgentPanelStore = create<AgentPanelState>((set, get) => ({
  workspaceRoot: null, runsByProject: {},
  binding: null, open: false, expanded: true, discussionTarget: null, runningBinding: null,
  bindWorkspace: workspaceRoot => {
    if (get().workspaceRoot === workspaceRoot) return;
    set({ workspaceRoot, runsByProject: {}, runningBinding: null, binding: null, open: false, discussionTarget: null });
  },
  setRunBusy: (workspaceRoot, projectId, busy) => {
    if (get().workspaceRoot !== workspaceRoot) return;
    set(state => {
      const runsByProject = { ...state.runsByProject };
      const key = dshProjectRunKey(workspaceRoot, projectId);
      if (busy) runsByProject[key] = { workspaceRoot, scope: { kind: "project", projectId } };
      else delete runsByProject[key];
      return { runsByProject, runningBinding: Object.values(runsByProject)[0] ?? null };
    });
  },
  setDiscussionTarget: (binding, object, label) => {
    const panel = get().binding;
    if (!panel || !["record", "todo", "file"].includes(object.kind)
      || binding.workspaceId !== object.workspaceId || !canDiscussObject(panel.scope, object.scope)) return false;
    set({ discussionTarget: { binding: { ...binding }, object: { ...object, scope: { ...object.scope } }, label } });
    return true;
  },
  clearDiscussionTarget: () => set({ discussionTarget: null }),
  openPanel: (workspaceRoot, scope) => {
    const running = get().runningBinding;
    if (running && (running.workspaceRoot !== workspaceRoot)) {
      showDshBusyFeedback();
      return;
    }
    set(state => {
    const previous = state.binding;
    const same = previous?.workspaceRoot === workspaceRoot && previous.scope.kind === scope.kind
      && (scope.kind === "workspace" || (previous.scope.kind === "project" && previous.scope.projectId === scope.projectId));
    return { workspaceRoot, binding: same ? previous : { workspaceRoot, scope }, open: true, expanded: same ? state.expanded : true,
      discussionTarget: same ? state.discussionTarget : null };
    });
  },
  closePanel: () => set({ open: false }),
  toggleExpanded: () => set(state => ({ expanded: !state.expanded })),
  clearWorkspace: () => set({ workspaceRoot: null, runsByProject: {}, binding: null, open: false, expanded: true, discussionTarget: null, runningBinding: null }),
}));
