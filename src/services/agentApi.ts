import type { AgentOutputReviewInput, AgentOutputReviewResult } from "../lib/agent-review-types";
import { desktopApi } from "./desktopApi";
import type {
  AgentContextEntry, AgentContextInput, AgentError, AgentResponse,
  AgentStatus, AgentWorkspaceBinding, AgentScope, AgentScopeSettings, AgentSettingsUpdate,
  AgentContextInstruction, AgentInstructionUpsert, AgentInstructionDelete, AgentChangePage,
  SourceMaintenanceProgress, OverviewReadInput, OverviewReadPage,
  KnowledgeGetInput, KnowledgeGetPage, KnowledgeSearchInput, KnowledgeSearchPage,
  AgentSessionCreateInput, AgentSessionsListInput, AgentSessionGetInput,
  AgentSessionArchiveInput, AgentSessionDeleteInput, AgentSessionMetadata, AgentSessionPage, AgentSessionSnapshot,
  AgentRunStartInput, AgentRunCancelInput, AgentRunGetInput, AgentRunEventsListInput,
  AgentStoredRun, AgentRunEvent, AgentRunEventPage, AgentProfileProbeInput, AgentProfileProbeResult,
  AgentSourceRef, AgentSourceNavigation,
  AgentOutputListInput, AgentOutputGetInput, AgentOutputUpdateInput, AgentOutputCommitInput, AgentOutputPage, AgentRuntimeOutput, AgentOutputResult,
  AgentOutputPreviewInput, AgentRecordOutputPreview,
  AgentOperationListInput, AgentOperationGetInput, AgentOperationUndoInput, AgentOperationUndoBatchInput, AgentOperationRestoreCreatedInput,
  AgentOperationPage, AgentOperationEntry, AgentOperationUndoResult, AgentOperationUndoBatchResult, AgentRecordWithdrawalResult,
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
  /** Controls scoped source extraction without treating completion as coverage. */
  sourceMaintenance(binding: AgentWorkspaceBinding, scope: AgentScope, action: "activate" | "cancel" | "resume" | null = null, requestId: string = crypto.randomUUID()): Promise<SourceMaintenanceProgress | null> {
    return callAgentCommand("agent_source_maintenance", requestId, { input: { binding, scope, action, requestId } });
  },
  statusGet(requestId: string = crypto.randomUUID()): Promise<AgentStatus> {
    return callAgentCommand("agent_status_get", requestId, { requestId });
  },
  sessionCreate(binding: AgentWorkspaceBinding, data: AgentSessionCreateInput, requestId: string = crypto.randomUUID()): Promise<AgentSessionMetadata> {
    return callAgentCommand("agent_session_create", requestId, { input: { binding, requestId, data } });
  },
  sessionsList(binding: AgentWorkspaceBinding, data: AgentSessionsListInput, requestId: string = crypto.randomUUID()): Promise<AgentSessionPage> {
    return callAgentCommand("agent_sessions_list", requestId, { input: { binding, requestId, data } });
  },
  sessionGet(binding: AgentWorkspaceBinding, data: AgentSessionGetInput, requestId: string = crypto.randomUUID()): Promise<AgentSessionSnapshot> {
    return callAgentCommand("agent_session_get", requestId, { input: { binding, requestId, data } });
  },
  sessionArchive(binding: AgentWorkspaceBinding, data: AgentSessionArchiveInput, requestId: string = crypto.randomUUID()): Promise<AgentSessionMetadata> {
    return callAgentCommand("agent_session_archive", requestId, { input: { binding, requestId, data } });
  },
  sessionDelete(binding: AgentWorkspaceBinding, data: AgentSessionDeleteInput, requestId: string = crypto.randomUUID()): Promise<boolean> {
    return callAgentCommand("agent_session_delete", requestId, { input: { binding, requestId, data } });
  },
  runStart(binding: AgentWorkspaceBinding, data: AgentRunStartInput, requestId: string = crypto.randomUUID()): Promise<AgentStoredRun> {
    return callAgentCommand("agent_run_start", requestId, { input: { binding, requestId, data } });
  },
  runCancel(binding: AgentWorkspaceBinding, data: AgentRunCancelInput, requestId: string = crypto.randomUUID()): Promise<AgentStoredRun> {
    return callAgentCommand("agent_run_cancel", requestId, { input: { binding, requestId, data } });
  },
  runGet(binding: AgentWorkspaceBinding, data: AgentRunGetInput, requestId: string = crypto.randomUUID()): Promise<AgentStoredRun> {
    return callAgentCommand("agent_run_get", requestId, { input: { binding, requestId, data } });
  },
  runEventsList(binding: AgentWorkspaceBinding, data: AgentRunEventsListInput, requestId: string = crypto.randomUUID()): Promise<AgentRunEventPage> {
    return callAgentCommand("agent_run_events_list", requestId, { input: { binding, requestId, data } });
  },
  profileProbe(binding: AgentWorkspaceBinding, data: AgentProfileProbeInput = {}, requestId: string = crypto.randomUUID()): Promise<AgentProfileProbeResult> {
    return callAgentCommand("agent_profile_probe", requestId, { input: { binding, requestId, data } });
  },
  onRunEvent(handler: (event: AgentRunEvent) => void): Promise<() => void> {
    return desktopApi.listenEvent<AgentRunEvent>("agent-run-event", handler);
  },
  sourceResolve(binding: AgentWorkspaceBinding, data: AgentSourceRef, requestId: string = crypto.randomUUID()): Promise<AgentSourceNavigation> {
    return callAgentCommand("agent_source_resolve", requestId, { input: { binding, requestId, data } });
  },
  outputReview(binding: AgentWorkspaceBinding, data: AgentOutputReviewInput, requestId: string = crypto.randomUUID()): Promise<AgentOutputReviewResult> {
    return callAgentCommand("agent_output_review", requestId, { input: { binding, requestId, data } });
  },
  outputList(binding: AgentWorkspaceBinding, data: AgentOutputListInput, requestId: string = crypto.randomUUID()): Promise<AgentOutputPage> {
    return callAgentCommand("agent_output_list", requestId, { input: { binding, requestId, data } });
  },
  outputGet(binding: AgentWorkspaceBinding, data: AgentOutputGetInput, requestId: string = crypto.randomUUID()): Promise<AgentRuntimeOutput> {
    return callAgentCommand("agent_output_get", requestId, { input: { binding, requestId, data } });
  },
  outputUpdate(binding: AgentWorkspaceBinding, data: AgentOutputUpdateInput, requestId: string = crypto.randomUUID()): Promise<AgentRuntimeOutput> {
    return callAgentCommand("agent_output_update", requestId, { input: { binding, requestId, data } });
  },
  outputCommit(binding: AgentWorkspaceBinding, data: AgentOutputCommitInput, requestId: string = crypto.randomUUID()): Promise<AgentOutputResult> {
    return callAgentCommand("agent_output_commit", requestId, { input: { binding, requestId, data } });
  },
  outputDismiss(binding: AgentWorkspaceBinding, data: AgentOutputCommitInput, requestId: string = crypto.randomUUID()): Promise<AgentRuntimeOutput> {
    return callAgentCommand("agent_output_dismiss", requestId, { input: { binding, requestId, data } });
  },
  outputPreview(binding: AgentWorkspaceBinding, data: AgentOutputPreviewInput, requestId: string = crypto.randomUUID()): Promise<AgentRecordOutputPreview> {
    return callAgentCommand("agent_output_preview", requestId, { input: { binding, requestId, data } });
  },
  operationList(binding: AgentWorkspaceBinding, data: AgentOperationListInput, requestId: string = crypto.randomUUID()): Promise<AgentOperationPage> {
    return callAgentCommand("agent_operation_list", requestId, { input: { binding, requestId, data } });
  },
  operationGet(binding: AgentWorkspaceBinding, data: AgentOperationGetInput, requestId: string = crypto.randomUUID()): Promise<AgentOperationEntry> {
    return callAgentCommand("agent_operation_get", requestId, { input: { binding, requestId, data } });
  },
  operationUndo(binding: AgentWorkspaceBinding, data: AgentOperationUndoInput, requestId: string = crypto.randomUUID()): Promise<AgentOperationUndoResult> {
    return callAgentCommand("agent_operation_undo", requestId, { input: { binding, requestId, data } });
  },
  operationUndoBatch(binding: AgentWorkspaceBinding, data: AgentOperationUndoBatchInput, requestId: string = crypto.randomUUID()): Promise<AgentOperationUndoBatchResult> {
    return callAgentCommand("agent_operation_undo_batch", requestId, { input: { binding, requestId, data } });
  },
  operationRestoreCreated(binding: AgentWorkspaceBinding, data: AgentOperationRestoreCreatedInput, requestId: string = crypto.randomUUID()): Promise<AgentRecordWithdrawalResult> {
    return callAgentCommand("agent_operation_restore_created", requestId, { input: { binding, requestId, data } });
  },
  // Read after a user question or explicit knowledge-menu opening.
  contextGet(binding: AgentWorkspaceBinding, context: AgentContextInput, requestId: string = crypto.randomUUID()): Promise<AgentContextEntry> {
    return callAgentCommand("agent_context_get", requestId, { input: { binding, requestId, context } });
  },
  overviewGet(binding: AgentWorkspaceBinding, data: OverviewReadInput, requestId: string = crypto.randomUUID()): Promise<OverviewReadPage> {
    return callAgentCommand("agent_overview_get", requestId, { input: { binding, requestId, data } });
  },
  knowledgeGet(binding: AgentWorkspaceBinding, data: KnowledgeGetInput, requestId: string = crypto.randomUUID()): Promise<KnowledgeGetPage> {
    return callAgentCommand("agent_knowledge_get", requestId, { input: { binding, requestId, data } });
  },
  knowledgeSearch(binding: AgentWorkspaceBinding, data: KnowledgeSearchInput, requestId: string = crypto.randomUUID()): Promise<KnowledgeSearchPage> {
    return callAgentCommand("agent_knowledge_search", requestId, { input: { binding, requestId, data } });
  },
  settingsGet(binding: AgentWorkspaceBinding, scope: AgentScope, requestId: string = crypto.randomUUID()): Promise<AgentScopeSettings> {
    return callAgentCommand("agent_settings_get", requestId, { input: { binding, requestId, data: scope } });
  },
  settingsUpdate(binding: AgentWorkspaceBinding, data: AgentSettingsUpdate, requestId: string = crypto.randomUUID()): Promise<AgentScopeSettings> {
    return callAgentCommand("agent_settings_update", requestId, { input: { binding, requestId, data } });
  },
  instructionsList(binding: AgentWorkspaceBinding, scope: AgentScope, afterId: string | null = null, limit = 50, requestId: string = crypto.randomUUID()): Promise<AgentContextInstruction[]> {
    return callAgentCommand("agent_instructions_list", requestId, { input: { binding, requestId, data: { scope, afterId, limit } } });
  },
  instructionUpsert(binding: AgentWorkspaceBinding, data: AgentInstructionUpsert, requestId: string = crypto.randomUUID()): Promise<AgentContextInstruction> {
    return callAgentCommand("agent_instruction_upsert", requestId, { input: { binding, requestId, data } });
  },
  instructionDelete(binding: AgentWorkspaceBinding, data: AgentInstructionDelete, requestId: string = crypto.randomUUID()): Promise<boolean> {
    return callAgentCommand("agent_instruction_delete", requestId, { input: { binding, requestId, data } });
  },
  changesList(binding: AgentWorkspaceBinding, scope: AgentScope, afterSeq: number, limit = 200, requestId: string = crypto.randomUUID()): Promise<AgentChangePage> {
    return callAgentCommand("agent_changes_list", requestId, { input: { binding, requestId, data: { scope, afterSeq, limit } } });
  },
  businessChangesList(binding: AgentWorkspaceBinding, afterSeq: number, limit = 200, requestId: string = crypto.randomUUID()): Promise<AgentChangePage> {
    return callAgentCommand("agent_business_changes_list", requestId, { input: { binding, requestId, data: { afterSeq, limit } } });
  },
};
