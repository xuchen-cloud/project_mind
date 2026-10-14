import { desktopApi } from "./desktopApi";
import type {
  VoiceRecoveryGap, VoiceAvailability, VoiceSettings, VoiceStartInput,
  VoiceSessionInput, VoiceSessionSnapshot,
  VoicePlaybackSnapshot, VoiceRecordLookup,
  VoiceTranscriptListInput, VoiceTranscriptPage,
  VoiceModelPackageStatus,
  VoiceProfileTestInput,
  VoiceTranscriptSegment, VoiceTranscriptTailInput,
  VoiceMinutesSnapshot, VoiceMinutesGenerateInput,
} from "../lib/voice-types";

/** Workspace-scoped Voice Record commands backed by the process-wide capture runtime. */
export const voiceApi = {
  availabilityGet: () => desktopApi.command<VoiceAvailability>("voice_availability_get"),
  modelStatusGet: () => desktopApi.command<VoiceModelPackageStatus>("voice_model_status_get"),
  modelImport: (sourceDirectory: string) => desktopApi.command<VoiceModelPackageStatus>("voice_model_import", { sourceDirectory }),
  profileTest: (input: VoiceProfileTestInput) => desktopApi.command<void>("voice_profile_test", { input }),
  settingsGet: () => desktopApi.command<VoiceSettings>("voice_settings_get"),
  settingsUpsert: (input: VoiceSettings) => desktopApi.command<void>("voice_settings_upsert", { input }),
  start: (input: VoiceStartInput) => desktopApi.command<VoiceSessionSnapshot>("voice_start", { input }),
  pause: (input: VoiceSessionInput) => desktopApi.command<VoiceSessionSnapshot>("voice_pause", { input }),
  resume: (input: VoiceSessionInput) => desktopApi.command<VoiceSessionSnapshot>("voice_resume", { input }),
  end: (input: VoiceSessionInput) => desktopApi.command<VoiceSessionSnapshot>("voice_end", { input }),
  snapshotGet: () => desktopApi.command<VoiceSessionSnapshot | null>("voice_snapshot_get"),
  playbackGet: (input: VoiceRecordLookup) => desktopApi.command<VoicePlaybackSnapshot | null>("voice_playback_get", { input }),
  recoveryGet: (input: VoiceRecordLookup) => desktopApi.command<VoiceRecoveryGap[]>("voice_recovery_get", { input }),
  recoveryRetry: (input: VoiceRecordLookup) => desktopApi.command<void>("voice_recovery_retry", { input }),
  transcriptList: (input: VoiceTranscriptListInput) => desktopApi.command<VoiceTranscriptPage | null>("voice_transcript_list", { input }),
  transcriptTail: (input: VoiceTranscriptTailInput) => desktopApi.command<VoiceTranscriptSegment[]>("voice_transcript_tail", { input }),
  minutesGet: (input: VoiceRecordLookup) => desktopApi.command<VoiceMinutesSnapshot | null>("voice_minutes_get", { input }),
  minutesGenerate: (input: VoiceMinutesGenerateInput) => desktopApi.command<VoiceMinutesSnapshot | null>("voice_minutes_generate", { input }),
};
