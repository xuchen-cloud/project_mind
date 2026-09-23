/** Wire contracts mirror src-tauri/src/voice/contracts.rs. */
export type VoiceTarget = { scope: "workspace" } | { scope: "project"; projectId: number };
export type SpeechProfile =
  | { kind: "paraformer"; endpoint: string; model: string; credentialProfileId: number | null }
  | { kind: "sense_voice_onnx"; modelPackageId: string };

export interface VoiceAvailability {
  implemented: boolean;
  reason: string;
}
export interface VoiceModelPackageStatus {
  packageId: string;
  ready: boolean;
  detail: string;
}
export interface VoiceProfileTestInput {
  endpoint: string;
  credentialProfileId: number;
}

export interface VoiceSettings {
  speechProfile: SpeechProfile | null;
  textProfileId: number | null;
  translationProfileId: number | null;
  contextEnabled: boolean;
  captionLines: number;
}

export interface VoiceStartInput { target: VoiceTarget; requestId: string }
export interface VoiceSessionInput {
  sessionId: string;
  expectedRevision: number;
  requestId: string;
}
export interface VoiceSessionSnapshot {
  sessionId: string;
  revision: number;
  phase: string;
  activeMs: number;
  pauseReason: string | null;
  projectNoteId: number | null;
  workspaceNoteId: number | null;
}
export type VoiceRecordLookup =
  | { scope: "workspace"; recordId: number }
  | { scope: "project"; projectId: number; recordId: number };
export interface VoicePlaybackChunk {
  source: "microphone" | "system";
  epoch: number;
  startMs: number;
  durationMs: number;
  path: string;
}
export interface VoicePlaybackSnapshot {
  sessionId: string;
  phase: string;
  chunks: VoicePlaybackChunk[];
}
export interface VoiceTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
}
export interface VoiceTranscriptCursor { startMs: number; id: string }
export interface VoiceTranscriptPage {
  segments: VoiceTranscriptSegment[];
  nextCursor: VoiceTranscriptCursor | null;
}
export interface VoiceTranscriptListInput {
  target: VoiceRecordLookup;
  after: VoiceTranscriptCursor | null;
  limit: number;
}
export interface VoiceTranscriptTailInput { sessionId: string; limit: number }

// TODO(VR-03): add persisted coverage ranges, derivative statuses,
// lexicon and minutes revisions once the database contracts are implemented.
// TODO(VR-12): events carry workspace/session/epoch/sequence; detect sequence gaps
// and reload authoritative snapshot. Never transport raw PCM through React state.
