//! Wire contracts. Keep src/lib/voice-types.ts in sync when these evolve.
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAvailability {
    pub implemented: bool,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceError {
    pub code: &'static str,
    pub operation: &'static str,
    pub message: String,
}

pub type VoiceResult<T> = Result<T, VoiceError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum RecordTarget {
    Workspace,
    Project {
        #[serde(rename = "projectId")]
        project_id: i64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub target: RecordTarget,
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub session_id: String,
    pub expected_revision: u64,
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum VoiceRecordLookup {
    Workspace {
        #[serde(rename = "recordId")]
        record_id: i64,
    },
    Project {
        #[serde(rename = "projectId")]
        project_id: i64,
        #[serde(rename = "recordId")]
        record_id: i64,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePlaybackChunk {
    pub source: String,
    pub epoch: u64,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePlaybackSnapshot {
    pub session_id: String,
    pub phase: String,
    pub chunks: Vec<VoicePlaybackChunk>,
    pub recognition_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptCursor {
    pub start_ms: u64,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptListInput {
    pub target: VoiceRecordLookup,
    pub after: Option<VoiceTranscriptCursor>,
    pub limit: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfileTestInput {
    pub endpoint: String,
    pub credential_profile_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptTailInput {
    pub session_id: String,
    pub limit: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMinutesGenerateInput {
    pub target: VoiceRecordLookup,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptPage {
    pub segments: Vec<VoiceTranscriptSegment>,
    pub next_cursor: Option<VoiceTranscriptCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeaker {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub contact_id: Option<i64>,
    #[serde(default)]
    pub association: Option<String>,
    #[serde(default)]
    pub voiceprint_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeakerTurn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDiarizationSnapshot {
    pub session_id: String,
    pub revision: u64,
    pub status: String,
    pub error: Option<String>,
    pub speakers: Vec<VoiceSpeaker>,
    pub turns: Vec<VoiceSpeakerTurn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeakerRenameInput {
    pub target: VoiceRecordLookup,
    pub speaker_id: u32,
    pub name: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeakerLinkContactInput {
    pub target: VoiceRecordLookup,
    pub speaker_id: u32,
    pub contact_id: Option<i64>,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceMinutesSnapshot {
    pub session_id: String,
    pub version: u64,
    pub title: String,
    pub content: String,
    pub generated_at: Option<String>,
    pub preview: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpeechProfile {
    Paraformer {
        endpoint: String,
        model: String,
        #[serde(rename = "credentialProfileId")]
        credential_profile_id: Option<i64>,
    },
    SenseVoiceOnnx {
        #[serde(rename = "modelPackageId")]
        model_package_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub speech_profile: Option<SpeechProfile>,
    #[serde(default)]
    pub live_preview_enabled: bool,
    pub text_profile_id: Option<i64>,
    pub translation_profile_id: Option<i64>,
    pub context_enabled: bool,
    pub caption_lines: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionSnapshot {
    pub session_id: String,
    pub revision: u64,
    pub phase: String,
    pub active_ms: u64,
    pub pause_reason: Option<String>,
    pub interim_text: Option<String>,
    pub recognition_error: Option<String>,
    pub project_note_id: Option<i64>,
    pub workspace_note_id: Option<i64>,
}
