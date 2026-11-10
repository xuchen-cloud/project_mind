# File flow native integration

Issue #304. Integration base: native PR #310 / develop54e9315. This document records wiring and verified boundaries; frontend and remaining native review fixes are still in progress.

## Registered GUI adapters

- `record_owner_move`: input+ApiResponse; worker owns the actual native service and window/source permission checks.
- `file_editor_register/unregister/flush_reply`, `file_editors_flush/release`: input+ApiResponse and real native window identity. They operate on one File ObjectRef, including all its registered instances, never other content or whole owners.
- `file_owner_move_baseline`, `file_owner_move`, `file_drop_prepare`, `file_drop_commit`: direct typed fileCommand DTOs. The current Host provides a separate runtime connection and existing lifecycle fence. Blocking native tasks own their save guards through storage completion, so cancelling the awaiting IPC cannot release a moving object early.
- `file_version_metadata_update`: input+ApiResponse; real native window permission comes from the actual owner resolved by native storage. Content sessions/bytes are unchanged by version label/importance updates.

The File coordinator reserves its object before requesting saves, rejects new registrations while frozen, validates every reply's binding/window/editor/flush identity and requires all target instances to save. Prepared operations expire after60 seconds; active native operations are protected by RAII. Drop update prepare returns to Prepared with a fresh nonce/timer, so an earlier timer cannot release the later commit boundary.

Successful guard consumption records a native-only, generation-bound confirmation proof for its original source/request/window. It permits that window to confirm an already-committed move after ownership changes. Without proof, the wrapper verifies the actual canonical owner against the real native caller. Native replay still checks exact original payload/current owner/allowlist; no fresh mutation is permitted without a prepared seal.

Only actual commits emit owner-moved or file-replaced. Readonly receipt replay emits neither, protecting later newly-opened editors and their unsaved input. Failed/cancelled/expired preparations release only their target. Replacement keeps the Tab and reloads its working session; movement closes only original-source instances. Frontend instance/operation matching and response fallback are undergoing final review separately.

## Unified schema41

Upgrade paths38/39/40 and initial creation install owner/drop intents, version metadata/protection, Record identity/history context and directory prerequisites, then publish version41 last. Individual contacts/metadata helpers no longer prematurely publish the global schema. Helpers remain retryable after a later extension fails. Current-schema reopen does no DDL/backfill; runtime Host connections only accept the current schema.

Whole-Project rename/delete/retried Trash now check retained foreign-owner Record resources before physical mutation, in addition to SQL protection. Single File directory rename also checks retained foreign File history and Record resources. The files group's separate directory mutation prepare/commit paths still require combined integration hooks.

## Verification snapshot

All commands use the shared build lock with `CARGO_INCREMENTAL=0` and the shared regenerable target cache. The combined native library, including registered command signatures and real worker sources, compiled successfully.

- `file_flow_migration`:2 passed; published history and bytes survive upgrade, runtime sees all extensions, current reopen leaves SQLite schema_version unchanged, and failures after contacts/metadata do not publish41 for prior38/39/40 and can retry.
- `file_editor_coordination::tests`:7 passed; target-only multi-instance saves, failure/timeout/cancel cleanup, spoof rejection, old timer/new nonce, active guard lifetime and original-window completion proof.
- `g15_`:7 passed against the combined schema and metadata command types.
- `g13_resource_subdirectory_and_single_file_guard_retains_foreign_record_assets`:1 passed with real temporary DB/files and canonical worker, including Project root rename/delete admission.

Worker evidence remains in the Record/File implementation documents. Independent native review subsequently identified additional Record reference/Transcript policy issues and File history/hardlink/recovery/cross-volume replacement issues; those are being fixed. This snapshot is not a whole-package pass or publish authorization. No Windows, real second mount, macOS system Trash GUI or integrated cross-window acceptance is claimed here.
