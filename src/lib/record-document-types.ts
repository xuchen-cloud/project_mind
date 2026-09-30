import type { JSONContent } from "@tiptap/core";
import type { AgentScope } from "./agent-types";
import type { NoteRecord, WorkspaceRecord } from "./types";

/** Wire contracts for the shared Record service. Local asset URLs live only in
 * editor.record; head and version projections always retain portable paths. */
export interface RecordTarget { scope: AgentScope; recordId: number }
export interface RecordDocumentProjection {
  schemaVersion: number;
  document: JSONContent;
  html: string;
  markdown: string;
  text: string;
  codeLanguage: string | null;
  bodyHash: string;
}
export interface RecordDocumentHead {
  target: RecordTarget;
  headRevision: number;
  projection: RecordDocumentProjection;
  editSessionId: string | null;
  checkpointDueAt: string | null;
}
export interface RecordMetadata {
  title: string | null;
  tagIds: number[];
  revision: string;
  updatedAt: string;
}
export interface RecordMetadataUpdate {
  target: RecordTarget;
  expectedRevision: string;
  title: string | null;
  tagIds: number[];
}
export interface RecordEditorState {
  head: RecordDocumentHead;
  metadata: RecordMetadata;
  record: NoteRecord | WorkspaceRecord;
}
export interface RecordBodySaveInput {
  target: RecordTarget;
  baseRevision: number;
  document: JSONContent;
  codeLanguage: string | null;
  origin: "manual" | "editor_ai";
  editSessionId: string | null;
  metadata?: RecordMetadataUpdate;
}
export interface RecordCommitResult {
  head: RecordDocumentHead;
  noChange: boolean;
  beforeVersion: string;
  afterVersion: string | null;
  metadata?: RecordMetadata;
}
export interface RecordEditorSaveResult { commit: RecordCommitResult; editor: RecordEditorState }
export interface RecordQuickNoteTransferInput {
  scope: AgentScope;
  recordId: number | null;
  baseRevision: number | null;
  metadataRevision: string | null;
  expectedMarkdown: string;
  title: string | null;
  tagIds: number[];
}
export type RecordCheckpointReason = "due" | "leave_editor" | "open_history" | "shutdown" | "recovery";
export interface RecordCheckpointInput { target: RecordTarget; baseRevision: number; reason: RecordCheckpointReason }
export interface RecordCheckpointResult { head: RecordDocumentHead; versionId: string | null; checkpointed: boolean }
export type RecordVersionOrigin = "baseline" | "manual" | "agent" | "editor_ai" | "quick_note" | "restore" | "import";
export interface RecordVersionSummary {
  id: string;
  versionNumber: number;
  headRevision: number;
  titleSnapshot: string | null;
  bodyHash: string;
  origin: RecordVersionOrigin;
  createdAt: string;
}
export interface RecordVersion extends Omit<RecordVersionSummary, "bodyHash"> {
  projection: RecordDocumentProjection;
  actor: unknown;
  operationId: string;
  restoredFromVersionId: string | null;
}
export interface RecordVersionPreview { version: RecordVersion; html: string }
export interface RecordRestoreInput { target: RecordTarget; baseRevision: number; versionId: string }
export interface RecordVersionPage { versions: RecordVersionSummary[]; nextBefore: number | null }
export interface RecordVersionCapacity { versionCount: number; snapshotBytes: number; retainedAssetCount: number }
