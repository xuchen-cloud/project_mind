import type { AgentOutputReviewDecision } from "./agent-review-types";
import type { TodoPriority, TodoStatus } from "./types";
import type { RecordCommittedHead } from "./record-document-types";
import type { RecordVersionDifference } from "./record-version-compare";
/** Wire contracts mirrored from src-tauri/src/agent. AI-09 adds schema generation. */
export type AgentScope = { kind: "workspace" } | { kind: "project"; projectId: number };
export interface AgentWorkspaceBinding { workspaceId: string; generation: string }
/** Scoped source extraction progress; job completion is not coverage. */
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
  | "OUTPUT_COMMIT_FAILED" | "INVALID_PATCH" | "AMBIGUOUS_MATCH" | "EDITOR_REVIEW_PENDING" | "EDITOR_BUSY"
  | "UNDO_CONFLICT" | "OBJECT_WITHDRAWN";
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
/** Trusted source resolution; Transcript IDs are resolved to their owning Record. */
export interface AgentSourceNavigation {
  object: AgentObjectRef;
  status: "current" | "changed" | "historical" | "not_found" | "not_ready";
  recordTarget: { scope: AgentScope; recordId: number } | null;
  currentRevision: string | null;
  revisionMatches: boolean | null;
  recordVersion: number | null;
  recordVersionId: string | null;
  /** Numeric revision of the selected head or historical snapshot. */
  headRevision: number | null;
  blockId: string | null;
  blockStatus: "not_requested" | "available" | "missing";
  voiceRecordId: number | null;
  startMs: number | null;
  endMs: number | null;
  timeStatus: "not_requested" | "available" | "missing";
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
export type KnowledgeStorageKind = "topic" | "decision" | "source_summary";
export type KnowledgeReadKind = KnowledgeStorageKind | "overview_item";
export type KnowledgeNodeId = `node:${string}` | `overview:${string}`;
export type KnowledgeView = "outline" | "summary" | "content";
/** Omitted view defaults to summary; omitted sectionIds defaults to []. */
export interface KnowledgeGetInput {
  scope: AgentScope;
  nodeId: KnowledgeNodeId;
  version?: number | null;
  view?: KnowledgeView;
  sectionIds?: string[];
  cursor?: string | null;
  budgetChars?: number | null;
}
export interface KnowledgeReadSection {
  id: string;
  title: string;
  text: string | null;
  textOffset: number;
  complete: boolean;
}
export interface KnowledgeRelatedCard {
  nodeId: KnowledgeNodeId;
  revision: number;
  kind: KnowledgeReadKind;
  title: string;
  oneLine: string;
  relation: "related" | "supports" | "contradicts";
  reason: string;
}
export interface KnowledgeGetPage {
  scope: AgentScope;
  nodeId: KnowledgeNodeId;
  kind: KnowledgeReadKind;
  revision: number;
  title: string;
  view: KnowledgeView;
  summary: string | null;
  summaryOffset: number;
  sections: KnowledgeReadSection[];
  sourceRefs: AgentSourceRef[];
  related: KnowledgeRelatedCard[];
  coverage: AgentSourceCoverage;
  stale: boolean;
  epistemicStatus: AiOverviewItem["epistemicStatus"];
  validState: AiOverviewItem["validState"];
  nextCursor: string | null;
}
export interface KnowledgeSearchInput {
  scope: AgentScope;
  query: string;
  kinds?: KnowledgeStorageKind[];
  cursor?: string | null;
  limit?: number | null;
  budgetChars?: number | null;
}
export interface KnowledgeSearchCard {
  nodeId: KnowledgeNodeId;
  title: string;
  snippet: string;
  kind: KnowledgeReadKind;
  revision: number;
  stale: boolean;
  epistemicStatus: AiOverviewItem["epistemicStatus"];
}
export interface KnowledgeSearchPage {
  scope: AgentScope;
  items: KnowledgeSearchCard[];
  nextCursor: string | null;
  sourceFallbackRequired: boolean;
}
export type AiProjectOverview = AiOverview & { scope: { kind: "project"; projectId: number } };
export type AiWorkspaceOverview = AiOverview & { scope: { kind: "workspace" } };
export type AgentRunState = "preparing" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
/** Rust serde_json::Value fields retain their source-specific JSON shape. */
export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };
export interface AgentBlockInput {
  type: string;
  attrs?: { [key: string]: AgentJsonValue };
  content?: AgentBlockInput[];
  text?: string;
  marks?: Array<{ type: string; attrs?: { [key: string]: AgentJsonValue } }>;
}
export type AgentBlockEdit =
  | { op: "replace"; blockId: string; expectedBlockHash: string; block: AgentBlockInput }
  | { op: "delete"; blockId: string; expectedBlockHash: string }
  | { op: "insert_after"; anchorBlockId: string; blocks: AgentBlockInput[] }
  | { op: "append"; parentBlockId: string | null; position?: "start" | "end"; blocks: AgentBlockInput[] }
  | { op: "append_inline"; blockId: string; expectedBlockHash: string; text: string };
export interface AgentRecordPatch { record: AgentObjectRef; baseRevision: number; requestId: string; operations: AgentBlockEdit[] }
export type AgentRecordOutputIntent =
  | { intent: "record_create"; scope: AgentScope; title: string; markdown: string }
  | { intent: "record_patch"; patch: AgentRecordPatch };
export interface AgentTodoNewChild { content: string; progressDate: string; dueDate: string | null }
export type AgentTodoMutation =
  | { change: "content"; content: string }
  | { change: "deadline"; dueDate: string | null }
  | { change: "status"; status: TodoStatus }
  | { change: "priority"; priority: TodoPriority }
  | { change: "tags"; tagIds: number[] }
  | ({ change: "child_create" } & AgentTodoNewChild)
  | ({ change: "child_update"; childId: number; status: TodoStatus } & AgentTodoNewChild)
  | { change: "child_delete"; childId: number };
export type AgentTodoObjectRef = AgentObjectRef & { kind: "todo" };
export type AgentTodoOutputIntent =
  | { intent: "todo_create"; scope: AgentScope; dedupeKey: string; content: string; priority: TodoPriority; dueDate: string | null; tagIds: number[]; children: AgentTodoNewChild[] }
  | { intent: "todo_update"; target: AgentTodoObjectRef; expectedRevision: number; changes: AgentTodoMutation[] };
export type AgentFileObjectRef = AgentObjectRef & { kind: "file" };
export interface AgentFileTextEdit { oldText: string; newText: string; occurrence?: number | null }
export interface AgentFileTextPatch {
  object: AgentFileObjectRef; expectedVersionNumber: number; expectedContentHash: string;
  edits?: AgentFileTextEdit[] | null; appendText?: string | null;
}
export interface AgentFileVersionRestore {
  object: AgentFileObjectRef; versionId: string; expectedVersionNumber: number; expectedContentHash: string;
}
export type AgentFileOutputIntent =
  | { intent: "file_create"; projectId: number; safeName: string; utf8Content: string }
  | { intent: "file_update"; target: AgentFileObjectRef; expectedVersion: number; expectedHash: string; stagedContentId: string }
  | { intent: "file_patch"; patch: AgentFileTextPatch }
  | { intent: "file_restore"; restore: AgentFileVersionRestore };
export type AgentOutputIntent = AgentRecordOutputIntent | AgentTodoOutputIntent | AgentFileOutputIntent;
export interface AgentStageRecordInput { intent: AgentRecordOutputIntent; sources: AgentSourceRef[] }
export interface AgentStageOutputInput { intent: AgentRecordOutputIntent | AgentTodoOutputIntent | AgentFileOutputIntent; sources: AgentSourceRef[] }
/** Candidates stay separate from business content until native commit. */
export interface AgentFileCommittedVersion { documentId: number; versionNumber: number; contentHash: string; noChange: boolean }
export interface AgentRuntimeOutput {
  id: string; runId: string; ordinal: number; revision: number;
  intent: AgentOutputIntent; sources: AgentSourceRef[];
  state: "staged" | "committing" | "committed" | "failed";
  object: AgentObjectRef | null; mode: "collaborate" | "review" | "read_only";
  errorCode: AgentError["code"] | null; sourceChanged: boolean[]; dismissed: boolean; fileReceipt?: AgentFileCommittedVersion; reviewDecision?: AgentOutputReviewDecision;
}
export interface AgentOutputPage { outputs: AgentRuntimeOutput[]; nextCursor: string | null }
export interface AgentOutputListInput { runId: string; cursor?: string | null; limit?: number }
export interface AgentOutputGetInput { outputId: string }
export interface AgentOutputUpdateInput { outputId: string; expectedRevision: number; candidate: AgentStageOutputInput }
export interface AgentOutputCommitInput { outputId: string; expectedRevision: number }
export interface AgentOutputPreviewInput { outputId: string; expectedRevision: number }
/** Read-only comparison against the verified current canonical patch baseline. */
export interface AgentRecordOutputPreview { outputId: string; revision: number; baseRevision: number; difference: RecordVersionDifference }
export interface AgentOutputResult { output: AgentRuntimeOutput; receipt: AgentJsonValue; operation: AgentOperationEntry | null }
export type AgentRecordOutputResult = AgentOutputResult;
export interface AgentOperationEntry {
  operationId: string; runId: string | null; requestId: string; kind: string; object: AgentObjectRef;
  beforeRevision: number | null; afterRevision: number | null;
  beforeSnapshotRef: string | null; afterSnapshotRef: string | null;
  undoState: "unavailable" | "available" | "undone"; undoOperationId: string | null; createdAt: string;
  recovery: { withdrawn: boolean; withdrawalRevision: number | null; restoreAvailable: boolean } | null;
}
export interface AgentOperationPage { operations: AgentOperationEntry[]; nextCursor: string | null }
export interface AgentOperationListInput { runId: string; cursor?: string | null; limit?: number }
export interface AgentOperationGetInput { operationId: string }
export interface AgentOperationUndoInput { operationId: string; expectedHeadRevision: number }
export interface AgentOperationUndoBatchInput { runId: string; operationIds: string[] }
export interface AgentOperationRestoreCreatedInput { creationOperationId: string; expectedWithdrawalRevision: number }
export interface AgentRecordUndoResult {
  operationId: string; originalOperationId: string; object: AgentObjectRef;
  head: RecordCommittedHead;
  beforeVersion: string; afterVersion: string;
}
export interface AgentRecordWithdrawalResult {
  operationId: string; creationOperationId: string; object: AgentObjectRef; withdrawn: boolean; revision: number;
}
export interface AgentTodoUndoResult {
  operationId: string; originalOperationId: string; object: AgentObjectRef;
  beforeRevision: number; afterRevision: number;
  beforeSnapshotRef: string; afterSnapshotRef: string; bodyHash: string;
}
export interface AgentFileUndoResult {
  operationId: string; originalOperationId: string; object: AgentFileObjectRef;
  beforeVersionNumber: number; afterVersionNumber: number;
  beforeVersionId: string; afterVersionId: string; contentHash: string;
}
export type AgentOperationUndoResult = AgentRecordUndoResult | AgentTodoUndoResult | AgentFileUndoResult | AgentRecordWithdrawalResult;
export interface AgentOperationUndoBatchResult {
  runId: string;
  results: Array<{ object: AgentObjectRef; operationIds: string[]; outcome:
    | { status: "succeeded"; result: AgentOperationUndoResult }
    | { status: "failed"; error: AgentError } }>;
  excludedNoChangeIds: string[];
}
export type AgentSessionState = "active" | "archived" | "read_only";
export interface AgentSessionMetadata {
  id: string;
  scope: AgentScope;
  title: string;
  runtimeId: string;
  profileOverrideId: number | null;
  state: AgentSessionState;
  createdAt: string;
  updatedAt: string;
}
export interface AgentSessionCursor { updatedAt: string; id: string }
export interface AgentSessionPage { sessions: AgentSessionMetadata[]; nextCursor: AgentSessionCursor | null }
export interface AgentSessionCheckpoint {
  schemaVersion: number;
  checksum: string;
  bytes: number;
  leafId: string | null;
  offset: number;
  entryCount: number;
  messageCount: number;
}
export type AgentMessageRole = "user" | "assistant" | "tool";
export interface AgentConversationMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  runtimeEntryId: string;
  role: AgentMessageRole;
  content: AgentJsonValue;
  ordinal: number;
  createdAt: string;
  parentId?: string;
  stopReason?: string;
  usage?: AgentJsonValue;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}
export interface AgentSessionSnapshot {
  session: AgentSessionMetadata;
  checkpoint: AgentSessionCheckpoint | null;
  messages: AgentConversationMessage[];
  nextOrdinal: number | null;
  latestRun: AgentStoredRun | null;
}
export interface AgentStoredRun {
  id: string;
  sessionId: string;
  clientRequestId: string;
  state: AgentRunState;
  contextManifest: AgentJsonValue;
  startedAt: string;
  finishedAt: string | null;
  usage: AgentJsonValue;
  errorCode: string | null;
}
export interface AgentSessionCreateInput {
  scope: AgentScope;
  title: string;
  /** Omission selects the bundled Pi runtime. */
  runtimeId?: "builtin-pi";
  profileOverrideId?: number | null;
}
export interface AgentSessionsListInput { scope: AgentScope; cursor?: AgentSessionCursor | null; limit?: number }
export interface AgentSessionGetInput { sessionId: string; afterOrdinal?: number | null; limit?: number }
export interface AgentSessionArchiveInput { sessionId: string; archived: boolean }
export interface AgentSessionDeleteInput { sessionId: string }
export interface AgentRunStartInput { sessionId: string; clientRequestId: string; prompt: string; discussionTarget?: AgentObjectRef | null }
export interface AgentRunCancelInput { runId: string }
export interface AgentRunGetInput { runId: string }
export interface AgentRunEventsListInput { runId: string; afterSeq?: number; limit?: number }
export interface AgentProfileProbeInput { profileOverrideId?: number | null }
export interface AgentProfileProbeResult { verified: boolean }
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
export interface AgentRunEventPage {
  events: AgentRunEvent[];
  nextSeq: number | null;
  /** Reconcile persisted messages when events before this sequence were evicted. */
  firstAvailableSeq: number | null;
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
