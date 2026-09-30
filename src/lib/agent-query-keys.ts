import type { AgentScope, AgentWorkspaceBinding } from "./agent-types";

export function agentScopeKey(scope: AgentScope): string {
  return scope.kind === "project" ? `project:${scope.projectId}` : "workspace";
}
const bindingKey = (binding: AgentWorkspaceBinding) =>
  ["agent", binding.workspaceId, binding.generation] as const;

/** All agent data is invalidated by the existing Workspace cache cleanup. */
export const agentQueryKeys = {
  all: ["agent"] as const,
  status: ["agent", "status"] as const,
  scope: (binding: AgentWorkspaceBinding, scope: AgentScope) =>
    [...bindingKey(binding), agentScopeKey(scope)] as const,
  context: (binding: AgentWorkspaceBinding, scope: AgentScope, query: string, budgetChars = 2000) =>
    [...bindingKey(binding), agentScopeKey(scope), "context", query, budgetChars] as const,
  settings: (binding: AgentWorkspaceBinding, scope: AgentScope) =>
    [...bindingKey(binding), agentScopeKey(scope), "settings"] as const,
  instructions: (binding: AgentWorkspaceBinding, scope: AgentScope) =>
    [...bindingKey(binding), agentScopeKey(scope), "instructions"] as const,
  sessions: (binding: AgentWorkspaceBinding, scope: AgentScope) =>
    [...bindingKey(binding), agentScopeKey(scope), "sessions"] as const,
};
