//! Recognition adapters — VR-08, VR-09, VR-10.
// TODO: FSMN-VAD ONNX state per stream/epoch, pre-roll, endpoint padding, max length,
// overlap deduplication and final flush. Five-minute silence uses BOTH healthy VADs.
// TODO: SenseVoice model manifest/download/import/checksum/atomic activation, native
// ONNX worker, tokenizer, preprocessing and ITN. No Python needed by end users.
// Local adapter produces final segments only. Do not silently upload on failure.
// TODO: Paraformer WS handshake, provider finals, heartbeat and bounded reconnect.
// Preserve continuous cloud audio; client VAD must not repeatedly close the stream.
// TODO: persistent coverage ranges for late backfill; segment key + epoch dedupe;
// expose capability flags for partials/language/hotwords/backfill explicitly.

#[derive(Debug)]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub language: Option<String>,
}
