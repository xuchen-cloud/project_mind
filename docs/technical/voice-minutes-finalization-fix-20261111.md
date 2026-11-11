# Voice Record minutes finalization fix

## Scope

User-reported follow-up, 2026-11-11 (no new Issue created): after ending a Recording Session, wait for all saved-audio recovery to finish, generate one final Meeting Minutes Snapshot, avoid false editor conflicts from title-only updates, and omit absent decisions/action items/open questions.

Baseline: `origin/develop` at `5e86b7722dcb89095e62a015fef1402c19f0a480`. Work is isolated from the older, dirty main checkout. No merge, push, app launch, or changes to personal recordings. Local commit authorized by the user after verification.

Non-goals: changing original Transcript, hiding real concurrent body/title/tag edits, changing model selection, or redoing prior review packages.

## Changes

- `voice_end` and replay completion share a single `final` idempotency key. Final enqueue requires ended lifecycle, finalized capture epochs and no unfinished recovery intervals (failed intervals are not treated as complete).
- Replay batches no longer each schedule a new snapshot; a final silent batch still schedules the completed transcript. Pending periodic snapshots are superseded, and stopped-session periodic results are not published.
- Minutes prompt and renderer omit empty/`未提及` optional sections, including streaming placeholders; actual facts and required summary validation remain.
- Metadata-only updates are separated from body replacement. Local body drafts can remain intact while the generated title updates; genuine edited metadata and external body changes retain conflict protection.

## Verification

- Minutes formatter: 3 tests passed against extracted actual Rust functions using existing compiled dependency artifacts.
- SQLite checks against the actual queue/readiness/supersession SQL passed.
- Changed Rust queue/command/worker source parsed successfully with rustfmt.
- Frontend: 154 tests passed across canonical editor hook, Project/Workspace editor pages and save coordinator. Full TypeScript check passed after reusing the same-baseline WP00 package dependencies and generated Office resources.
- Cargo `--lib minutes`: 19 passed; Cargo `--lib db::voice_recovery`: 10 passed, 1 ignored (private WAV/model fixture test).
- Initial compilation was blocked by full Mac storage. After the user authorized old build cleanup, only idle reproducible build caches were removed; source worktrees, commits, uncommitted work and evidence were retained. Cargo checks above then completed successfully.
- Additional complete `voice::` module run: 117 passed, 13 ignored (existing private-audio/model/platform-dependent tests).
- Real-audio validation remains blocked: `PROJECT_MIND_TEST_MIC_WAV`, `PROJECT_MIND_TEST_SYSTEM_WAV`, and `PROJECT_MIND_TEST_MODEL_DIR` are unset; no suitable replay fixtures were found in the existing project, application cache or temporary test locations inspected. A real microphone/model/UI end-to-end run needs suitable local audio/model fixtures or a dedicated live-recording test session.
- No real microphone/model end-to-end run, release build, or deployment has been performed. Do not describe this patch as installed or fully live-accepted.
