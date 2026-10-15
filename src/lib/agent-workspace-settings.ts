import type { AgentScopeSettings, AgentWorkspaceBinding } from "./agent-types";

export const WORKSPACE_AGENT_SCOPE = { kind: "workspace" } as const;
const changedEvent = "project-mind:agent-workspace-settings-changed";

export function publishAgentSettings(binding: AgentWorkspaceBinding, settings: AgentScopeSettings) {
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: { binding, settings } }));
}

export function subscribeAgentSettings(onChanged: (binding: AgentWorkspaceBinding, settings: AgentScopeSettings) => void) {
  const listener = (event: Event) => {
    const { binding, settings } = (event as CustomEvent<{ binding: AgentWorkspaceBinding; settings: AgentScopeSettings }>).detail;
    onChanged(binding, settings);
  };
  window.addEventListener(changedEvent, listener);
  return () => window.removeEventListener(changedEvent, listener);
}
