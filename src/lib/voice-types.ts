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
  livePreviewEnabled: boolean;
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
  interimText: string | null;
  recognitionError?: string | null;
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
  recognitionError?: string | null;
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
export interface VoiceMinutesSnapshot {
  preview?: string;
  sessionId: string;
  version: number;
  title: string;
  content: string;
  generatedAt: string | null;
  status: string;
  error: string | null;
}
export interface VoiceMinutesGenerateInput { target: VoiceRecordLookup; requestId: string }
export interface VoiceSpeaker { id: number; name: string; contactId: number | null; association: "confirmed" | "automatic" | null; voiceprintReady: boolean }
export interface VoiceSpeakerTurn { startMs: number; endMs: number; speakerId: number }
export interface VoiceDiarizationSnapshot {
  sessionId: string;
  revision: number;
  status: "not_started" | "pending" | "running" | "ready" | "failed";
  error: string | null;
  speakers: VoiceSpeaker[];
  turns: VoiceSpeakerTurn[];
}
export interface VoiceSpeakerRenameInput { target: VoiceRecordLookup; speakerId: number; name: string; expectedRevision: number }
export interface VoiceSpeakerLinkContactInput { target: VoiceRecordLookup; speakerId: number; contactId: number | null; expectedRevision: number }

// The UI polls authoritative snapshots and discards stale request results.
// Raw PCM stays in the native capture runtime. Lexicon and other deferred
// derivatives follow docs/requirements/voice-record-decisions.md.

export interface VoiceRecoveryGap {
  id: number;
  sessionId: string;
  epoch: number;
  startMs: number;
  endMs: number | null;
  cursorMs: number;
  status: "waiting" | "pending" | "running" | "ready" | "failed";
  error: string | null;
}
