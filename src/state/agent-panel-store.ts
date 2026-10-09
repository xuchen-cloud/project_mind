import { create } from "zustand";
import type { AgentObjectRef, AgentScope, AgentWorkspaceBinding } from "../lib/agent-types";

export interface AgentPanelBinding { workspaceRoot: string; scope: AgentScope }
export interface AgentDiscussionTarget { binding: AgentWorkspaceBinding; object: AgentObjectRef; label: string }
export function sameAgentScope(a: AgentScope, b: AgentScope) {
  return a.kind === b.kind && (a.kind === "workspace" || (b.kind === "project" && a.projectId === b.projectId));
}
/** The panel may discuss a target in its own scope; Workspace can also discuss a project's object. */
export function canDiscussObject(panelScope: AgentScope, objectScope: AgentScope) {
  return panelScope.kind === "workspace" || sameAgentScope(panelScope, objectScope);
}
interface AgentPanelState {
  binding: AgentPanelBinding | null;
  open: boolean;
  expanded: boolean;
  discussionTarget: AgentDiscussionTarget | null;
  setDiscussionTarget: (binding: AgentWorkspaceBinding, object: AgentObjectRef, label: string) => boolean;
  clearDiscussionTarget: () => void;
  openPanel: (workspaceRoot: string, scope: AgentScope) => void;
  closePanel: () => void;
  toggleExpanded: () => void;
  clearWorkspace: () => void;
}

// Window-local UI state. The database owns sessions; closing this shell keeps its
// mounted conversation intact. Route changes never change the explicit binding.
export const useAgentPanelStore = create<AgentPanelState>((set, get) => ({
  binding: null, open: false, expanded: false, discussionTarget: null,
  setDiscussionTarget: (binding, object, label) => {
    const panel = get().binding;
    if (!panel || !["record", "todo", "file"].includes(object.kind)
      || binding.workspaceId !== object.workspaceId || !canDiscussObject(panel.scope, object.scope)) return false;
    set({ discussionTarget: { binding: { ...binding }, object: { ...object, scope: { ...object.scope } }, label } });
    return true;
  },
  clearDiscussionTarget: () => set({ discussionTarget: null }),
  openPanel: (workspaceRoot, scope) => set(state => {
    const previous = state.binding;
    const same = previous?.workspaceRoot === workspaceRoot && previous.scope.kind === scope.kind
      && (scope.kind === "workspace" || (previous.scope.kind === "project" && previous.scope.projectId === scope.projectId));
    return { binding: same ? previous : { workspaceRoot, scope }, open: true, expanded: same && state.expanded,
      discussionTarget: same ? state.discussionTarget : null };
  }),
  closePanel: () => set({ open: false }),
  toggleExpanded: () => set(state => ({ expanded: !state.expanded })),
  clearWorkspace: () => set({ binding: null, open: false, expanded: false, discussionTarget: null }),
}));
