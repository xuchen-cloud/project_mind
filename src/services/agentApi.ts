import { desktopApi } from "./desktopApi";
import type {
  AgentContextEntry, AgentContextInput, AgentError, AgentResponse,
  AgentStatus, AgentWorkspaceBinding, AgentScope, AgentScopeSettings, AgentSettingsUpdate,
  AgentContextInstruction, AgentInstructionUpsert, AgentInstructionDelete, AgentChangePage,
  SourceMaintenanceProgress, OverviewReadInput, OverviewReadPage,
} from "../lib/agent-types";

export class AgentApiError extends Error {
  readonly code: AgentError["code"];
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(error: AgentError) {
    super(error.message);
    this.name = "AgentApiError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

export async function callAgentCommand<T>(command: string, requestId: string, args: Record<string, unknown>): Promise<T> {
  const response = await desktopApi.command<AgentResponse<T>>(command, args);
  if (response.apiVersion !== 1 || response.requestId !== requestId) {
    throw new AgentApiError({ code: "RUNTIME_INCOMPATIBLE", message: "Agent response identity does not match the request", retryable: false });
  }
  if (!response.ok) throw new AgentApiError(response.error);
  return response.data;
}

/** Explicit binding prevents an old panel from silently switching to a new Workspace. */
export const agentApi = {
  /** Metadata control only, guarded by explicit development flags in both hosts. */
  sourceMaintenance(binding: AgentWorkspaceBinding, scope: AgentScope, action: "activate" | "cancel" | "resume" | null = null, requestId = crypto.randomUUID()): Promise<SourceMaintenanceProgress | null> {
    return callAgentCommand("agent_source_maintenance", requestId, { input: { binding, scope, action, requestId } });
  },
  statusGet(requestId = crypto.randomUUID()): Promise<AgentStatus> {
    return callAgentCommand("agent_status_get", requestId, { requestId });
  },
  // Call after a user question, never as an eager empty-conversation preload.
  contextGet(binding: AgentWorkspaceBinding, context: AgentContextInput, requestId = crypto.randomUUID()): Promise<AgentContextEntry> {
    return callAgentCommand("agent_context_get", requestId, { input: { binding, requestId, context } });
  },
  overviewGet(binding: AgentWorkspaceBinding, data: OverviewReadInput, requestId = crypto.randomUUID()): Promise<OverviewReadPage> {
    return callAgentCommand("agent_overview_get", requestId, { input: { binding, requestId, data } });
  },
  settingsGet(binding: AgentWorkspaceBinding, scope: AgentScope, requestId = crypto.randomUUID()): Promise<AgentScopeSettings> {
    return callAgentCommand("agent_settings_get", requestId, { input: { binding, requestId, data: scope } });
  },
  settingsUpdate(binding: AgentWorkspaceBinding, data: AgentSettingsUpdate, requestId = crypto.randomUUID()): Promise<AgentScopeSettings> {
    return callAgentCommand("agent_settings_update", requestId, { input: { binding, requestId, data } });
  },
  instructionsList(binding: AgentWorkspaceBinding, scope: AgentScope, afterId: string | null = null, limit = 50, requestId = crypto.randomUUID()): Promise<AgentContextInstruction[]> {
    return callAgentCommand("agent_instructions_list", requestId, { input: { binding, requestId, data: { scope, afterId, limit } } });
  },
  instructionUpsert(binding: AgentWorkspaceBinding, data: AgentInstructionUpsert, requestId = crypto.randomUUID()): Promise<AgentContextInstruction> {
    return callAgentCommand("agent_instruction_upsert", requestId, { input: { binding, requestId, data } });
  },
  instructionDelete(binding: AgentWorkspaceBinding, data: AgentInstructionDelete, requestId = crypto.randomUUID()): Promise<boolean> {
    return callAgentCommand("agent_instruction_delete", requestId, { input: { binding, requestId, data } });
  },
  changesList(binding: AgentWorkspaceBinding, scope: AgentScope, afterSeq: number, limit = 200, requestId = crypto.randomUUID()): Promise<AgentChangePage> {
    return callAgentCommand("agent_changes_list", requestId, { input: { binding, requestId, data: { scope, afterSeq, limit } } });
  },
  businessChangesList(binding: AgentWorkspaceBinding, afterSeq: number, limit = 200, requestId = crypto.randomUUID()): Promise<AgentChangePage> {
    return callAgentCommand("agent_business_changes_list", requestId, { input: { binding, requestId, data: { afterSeq, limit } } });
  },
};
