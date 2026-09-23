//! Text processing boundary — VR-14, VR-15, VR-16.
// TODO: reuse AI Profiles/provider calls, persist outbox before queueing, separate
// live text priority from minutes/title. Real cancellation must stop HTTP requests.
// TODO: immutable final Transcript -> conservative polish -> Chinese translation.
// Translation enable time is a source-audio boundary; never back-translate history.
// On errors display source text; only process new segments after recovery.
// TODO: scoped Committed Content -> bounded lexicon -> immutable session snapshot.
// Inject lexicon into ASR only if adapter supports it; treat model input as data.
// TODO: minutes every 15 active minutes, manual trigger does not reset cadence;
// finish generates final minutes. Late gap fills require revised coverage/rebuild.
// Replace minutes atomically, never the user's editable body. Copy is a user edit.
// TODO: title ends with fixed start datetime; manual ownership prevents late overwrite.
