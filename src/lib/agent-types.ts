/** Wire contracts mirrored from src-tauri/src/agent. AI-09 adds schema generation. */
export type AgentScope = { kind: "workspace" } | { kind: "project"; projectId: number };
export interface AgentWorkspaceBinding { workspaceId: string; generation: string }
/** Internal development extraction progress; job completion is not coverage. */
export interface SourceMaintenanceProgress {
  scope: AgentScope;
  batchId: string;
  chargedChars: number;
  chargedChunks: number;
  attemptedJobs: number;
  cancelled: boolean;
  budgetExhausted: boolean;
  foregroundBusy: boolean;
  pendingJobs: number;
  failedJobs: number;
  partialSources: number;
  backfillComplete: boolean;
}
export type AgentErrorCode =
  | "INVALID_ARGUMENT" | "NOT_FOUND" | "SCOPE_DENIED" | "WORKSPACE_NOT_OPEN"
  | "WORKSPACE_CHANGED" | "REVISION_CONFLICT" | "SOURCE_NOT_READY" | "SOURCE_CHANGED" | "FILE_CHANGED_UNREGISTERED" | "STAGED_CONTENT_EXPIRED"
  | "RUN_BUSY" | "RUNTIME_UNAVAILABLE" | "RUNTIME_INCOMPATIBLE" | "INVALID_RUN_TRANSITION"
  | "BUDGET_EXCEEDED" | "IDEMPOTENCY_CONFLICT" | "IO_FAILED" | "CANCELLED"
  | "PROFILE_UNAVAILABLE" | "SECRETS_LOCKED" | "TOOL_CALL_UNSUPPORTED" | "RATE_LIMITED"
  | "OUTPUT_COMMIT_FAILED" | "INVALID_PATCH" | "AMBIGUOUS_MATCH" | "EDITOR_REVIEW_PENDING" | "EDITOR_BUSY";
export interface AgentError { code: AgentErrorCode; message: string; retryable: boolean; details?: unknown }
export type AgentResponse<T> =
  | { apiVersion: 1; requestId: string; ok: true; data: T }
  | { apiVersion: 1; requestId: string; ok: false; error: AgentError };
export interface AgentCapability {
  method: string; permission: string; readOnly: boolean; implemented: boolean; delivery: string;
}
export interface AgentStatus {
  binding: AgentWorkspaceBinding | null;
  runtimeAvailable: boolean;
  bridgeAvailable: boolean;
  capabilities: AgentCapability[];
}
export interface AgentContextInput {
  scope: AgentScope;
  query?: string;
  budgetChars?: number;
}
export interface AgentContextEntry {
  identity: { scope: AgentScope; name: string; archived: boolean };
  status: "not_built" | "partial" | "ready" | "stale";
  overviewUpdatedAt: string | null;
  positioning: string | null;
  coverage: AgentSourceCoverage | null;
  nodes: Array<{ nodeId: string; title: string; oneLine: string }>;
  hasMore: boolean;
  availableReads: string[];
}
export interface AgentObjectRef {
  workspaceId: string;
  scope: AgentScope;
  kind: "project" | "quick_note" | "record" | "todo" | "file" | "transcript" | "session_summary" | "session_message";
  id: string;
}
export interface AgentSourceRef {
  object: AgentObjectRef;
  revision: string;
  fileVersion: number | null;
  recordVersion: number | null;
  blockId: string | null;
  locator:
    | { kind: "paragraph"; start: number; end: number }
    | { kind: "page"; page: number; start: number; end: number }
    | { kind: "time"; startMs: number; endMs: number }
    | { kind: "messages"; sessionId: string; branchId: string; startMessageId: string; endMessageId: string }
    | null;
  title: string;
  excerpt: string;
}
export interface AiOverviewItem {
  id: string;
  section: "profile" | "progress" | "knowledgeMap" | "actions" | "openQuestions";
  text: string;
  epistemicStatus: "recorded" | "user_confirmed" | "inferred" | "unknown";
  sourceRefs: AgentSourceRef[];
  dependencyItemIds: string[];
  validState: "current" | "stale" | "disputed" | "unsupported";
  updatedAt: string;
}
/** Omitted selections default to empty arrays, yielding a body-free directory. */
export interface OverviewReadInput {
  scope: AgentScope;
  version?: number | null;
  sections?: AiOverviewItem["section"][];
  itemIds?: string[];
  cursor?: string | null;
  budgetChars?: number | null;
}
export interface OverviewDirectoryEntry {
  section: AiOverviewItem["section"];
  count: number;
}
export interface OverviewReadItem {
  item: AiOverviewItem;
  textOffset: number;
  complete: boolean;
}
export interface OverviewReadPage {
  scope: AgentScope;
  revision: number | null;
  sections: OverviewDirectoryEntry[];
  items: OverviewReadItem[];
  stale: boolean;
  pendingCount: number;
  needsRebuild: boolean;
  coverage: AgentSourceCoverage | null;
  asOfSeq: number;
  correctionRevision: number;
  nextCursor: string | null;
}
/** Separate from ProjectRecord.quickNote* and the ProjectOverviewPage component. */
export interface AgentSourceCoverage {
  processed: number; partial: number; excluded: number; unsupported: number; pending: number;
}
export interface AiOverview {
  scope: AgentScope;
  revision: number;
  schemaVersion: number;
  items: AiOverviewItem[];
  asOfSeq: number;
  sourceManifestHash: string;
  builtAt: string;
  coverage: AgentSourceCoverage;
  pendingCount: number;
  modelProfileId: string;
}
export type AiProjectOverview = AiOverview & { scope: { kind: "project"; projectId: number } };
export type AiWorkspaceOverview = AiOverview & { scope: { kind: "workspace" } };
export type AgentRunState = "preparing" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentRunEventKind =
  | { type: "run.started" | "run.completed" | "run.cancelled" }
  | { type: "text.delta"; data: { text: string } }
  | { type: "tool.started"; data: { callId: string; method: string } }
  | { type: "tool.completed"; data: { callId: string } }
  | { type: "message.completed"; data: { messageId: string } }
  | { type: "run.failed"; data: { error: AgentError } };
export interface AgentRunEvent {
  binding: AgentWorkspaceBinding; sessionId: string; runId: string; seq: number; event: AgentRunEventKind;
}

export interface AgentScopeSettings {
  scope: AgentScope;
  enabled: boolean;
  goalRecordId: number | null;
  pinnedRefs: AgentObjectRef[];
  summaryPolicy: "on_success" | "manual";
  overviewIntervalHours: 24 | 48;
  overviewLocalTime: string;
  overviewTimezone: string;
  executionMode: "collaborate" | "review" | "read_only";
  revision: number;
}
export interface AgentSettingsUpdate { settings: AgentScopeSettings; expectedRevision: number }
export interface AgentContextInstruction {
  id: string; scope: AgentScope; text: string; enabled: boolean; revision: number; createdAt: string; updatedAt: string;
}
export interface AgentInstructionUpsert {
  scope: AgentScope; id: string | null; text: string; enabled: boolean; expectedRevision: number;
}
export interface AgentInstructionDelete { scope: AgentScope; id: string; expectedRevision: number }
export interface AgentChangeEntry {
  seq: number; objectKey: string; scope: AgentScope; operation: string; revision: string; createdAt: string;
}
export interface AgentChangePage { entries: AgentChangeEntry[]; cursor: number; hasMore: boolean; resetRequired: boolean }
