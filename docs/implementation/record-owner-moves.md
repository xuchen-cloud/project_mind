# G13 Record owner moves

## Work package

- Issue: #304; base native commit `0642da9`.
- Dependencies: shared Workspace fence/owner leases; Record canonical persistence, editor coordinator and atomic operation receipts. Frontend barrier integration belongs to integration/records.
- Delivery: native single Record moves Workspace → Project, Project → Workspace, Project → Project within the bound physical Workspace.
- Non-goals: File movement, drop cleanup, G15, frontend, publishing, cross Workspace or batch movement.
- Acceptance: colliding numeric IDs remain distinct; immutable versions/assets survive; old references resolve then authorize actual owner; scope-valid current references, Tag mapping, terminal Voice session, CAS/replay and transaction rollback.
- Verification: targeted Rust tests with real temporary SQLite/files/leases under the shared build lock. No GUI.

## Stable identity and location contract

A Record receives a random 128-bit lowercase hex logical identity on its first move. `record_logical_identities` stores its current canonical locator. `record_location_aliases` permanently maps each visited `(scope, numeric ID)` to that identity. These are routing facts, never capabilities. Destination inserts allocate fresh AUTOINCREMENT IDs, including Project → Project. Never reuse a removed row's ID or interpret a Project `note:<id>` as a Workspace ID. Alias resolution is one hop via the logical identity, so repeated moves do not form chains.

Canonical `record_document_heads.record_key` and its version foreign keys are location indexes, not logical identity. Their relocation is atomic with row allocation, aliases, Voice linkage, Tag links, access policy, reference edges, receipt and source/target logs. Version UUID/number, snapshots, body hash, actor, operation, creation time and asset refs remain byte-for-byte unchanged. `record_version_owner_context` records the original canonical location for every immutable version; migration backfills it and an insert trigger captures future versions. Updating a version's location index does not rewrite its original context. Existing Workspace-relative resources stay at their original paths; movement performs no asset rename or copy.

The native resolver returns `{logicalId, target}` for historical or current locators, then source reads authorize **the returned actual object**, including object allowlists, archive, withdrawal and exclusion. An old owner grant is insufficient. Historical reference nodes/snapshots are not rewritten. Legacy `note` / `workspace_record` tokens resolve through aliases with their original table namespace.

## Move API

`record_owner_move`: frozen Workspace binding/request ID, source `RecordTarget`, destination `Scope`, expected canonical `headRevision`, `bodyHash`, and metadata revision. Returns logical ID, source/new target, operation/request receipt and authoritative revision/hash. Caller needs `record.move` for both actual source and destination, and allowed actual source object. Destination must exist and be unarchived. Replays are caller/request/payload/binding bound and return the original receipt, after current-owner authorization.

Only this Record’s registered editors are flushed before acquiring the submission lock; pending AI review or busy editor aborts. No editor wait occurs under owner leases, Workspace fence or SQL. Native CAS checks the authoritative post-barrier baseline. Locks: sorted owner leases → no File lease (no File bytes mutate) → Workspace fence → immediate SQLite transaction. No global recovery inside fence.

Target Tag label matching follows SQLite NOCASE; an existing same-label/different-color target definition is an explicit conflict. Source definitions remain. Current body references are checked in the destination scope without retained-reference exemptions. Errors include the offending references; no silent pruning. Tag mentions are remapped in the current canonical tree as an ordinary new version; immutable snapshots remain unchanged.

## Integration boundaries

Root wiring changes: `db.rs` migration/module registration, `lib.rs` command/module registration, central source and reference resolvers. These may conflict with records/files shared root changes; preserve both groups' additions. No schema number is assigned here; integration owns the unified next migration (base is 40).

This document describes the intended contract. Test results and residual gaps below determine delivery; it is not evidence of completion.

## Confirmed integration wire contract (2026-11-10)

Command name: `record_owner_move` (native implementation only; integration owns invoke-handler registration and the global migration number).

Input camelCase: `{binding, requestId, data: {source: {scope, recordId}, destination: Scope, headRevision, bodyHash, metadataRevision}}`.
Output camelCase: `{logicalId, source: RecordTarget, target: RecordTarget, operationId, headRevision, bodyHash, metadataRevision}` in the existing `ApiResponse` envelope. `target` is the new location. Stable identity is retained across repeated moves, even through colliding table IDs.

Success publishes the existing `mind:changed` notification backed by source/target `agent_change_log` rows, plus the existing `record:head-changed` hints. Frontend closes only the moved object's old-location tab after success. Failure leaves tabs open. Only this Record's cross-window registered editors are coordinated; never save or close other content pages, Project or Workspace. Native has no frontend lifecycle dependency.

Integration calls `Database::ensure_record_owner_moves_schema` in its unified next-version migration and registers `record_owner_moves::record_owner_move`. Module declarations are necessary compile wiring, not registration or schema-number ownership. Tests explicitly apply this schema extension to real temporary databases.

Current Tag mentions will be remapped using a preflight ID plan and canonical utility conversion outside storage locks. Commit revalidates the plan, creates/maps target Tag definitions, and appends a normal canonical version. Every old version/context remains unchanged. Concurrent Tag plan changes cause explicit revision conflict; no unbounded retries or partial Tag creation.

## Editor cleanup

Existing registrations keep their original target after success. `record_editor_unregister` matches frozen binding/window/editor ID/original target; it does not authorize content, resolve aliases, or save. A duplicate cleanup is a no-op. New registration using a historical alias is rejected with the actual locator. Old-target writes authorize actual owner first, then fail with `SourceChanged`; no old editor draft is redirected to the new owner. UI must stop saving the old page after successful move and unmount only that tab.

Shared frozen DTO and cleanup rules are also appended to `/Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/fileflows-native-contract.md` (other workers' sections unchanged).

## Internal move seal (frozen)

Public `record_editors_flush` remains `input.data: RecordTarget`, with no seal and no new release command. Only `record_owner_move` acquires a target-local seal before its internal flush. New registrations for that binding/target fail with typed `EditorBusy`. Internal flush requests add optional `ownerMoveRequestId` equal to the move request ID. After saving, each addressed UI stays frozen until a terminal event. Native retains the seal and submission guard through CAS/commit; a flush-induced baseline change fails CAS rather than refreshing the caller’s baseline.

After commit and lock/seal release native emits `content:owner-moved {binding, operationId: requestId, source: ObjectRef, target: ObjectRef, oldSessionsClosed: false}`. Failure/cancellation after seal acquisition releases it through RAII and emits only `content:owner-move-released {binding, operationId: requestId, source: ObjectRef}`. These lifecycle event operation IDs correlate the flush freeze; the result’s `operationId` is the durable receipt ID. An early failure before acquiring the seal has no frozen editors and emits no release event. Receipt replay does not flush or emit another lifecycle event.

UI must handle both terminal event and command response; Tauri event delivery is not durable. A successful old-page cleanup uses the original registration target and performs no save. No File APIs or other-object registrations are changed.

## Resource ownership / integration risks

The current implementation keeps exact Workspace-relative asset paths rather than copying resource directories. Each moved Record stores per-path original scope provenance; later saves may retain only those paths, not arbitrary source-owner files. Source Project root rename/deletion is rejected while a moved-out Record still retains resources from it. Integration must preserve these database triggers or supply an equivalent relocation/rewrite strategy before permitting that cleanup. This is a deliberate visible restriction, not silent resource loss.

Resolver接线范围：canonical Record read/editor/version commands、source reader/fixed-version navigation（含 GUI trusted adapter）、legacy internal-reference navigation、operation history/undo 与 creation withdrawal/restore。Historical snapshots and receipt JSON remain immutable; runtime targets are resolved before actual-owner authorization. Old-target writes are rejected instead of being redirected. Legacy row mutation commands must continue rejecting old/deleted rows; their owner-specific return DTO cannot represent a cross-owner redirect.

Migration/handler registration and native delta `04506b4` integration remain the integration session’s responsibility. This worktree applies only two prerequisite compile fixes separately (`a1ea818`, `8e4a6f9`); avoid duplicating those when applying to the already updated native base. No frontend, GUI, Windows or full-app acceptance is asserted by this native package.

## Verification / review evidence (2026-11-10)

- Real behavioral red: `/tmp/g13-red-2.log`, `cargo test --manifest-path src-tauri/Cargo.toml --lib g13_old_locator_read_uses_actual_owner_grant --quiet -- --test-threads=1`: 1 failed with old-owner ScopeDenied before resolver implementation. The earlier `/tmp/g13-red.log` was a baseline compile failure, not behavioral evidence.
- Initial green attempt `/tmp/g13-green-1.log`: two u64/SQLite compile errors; fixed with bounded i64 storage conversion. PID78612 exited normally; no process terminated.
- `/tmp/g13-green-2.log`: `cargo test --manifest-path src-tauri/Cargo.toml --lib g13_ --quiet -- --test-threads=1 --include-ignored`: 11 passed, 2 failed. Failures were test-fixture errors: body hash used instead of original SourceRef fingerprint; missing voice_audio_chunks.created_at.
- `/tmp/g13-green-3.log`: reran only `g13_move_old_reads_actual_owner_and_stale_editor_writes_reject` and `g13_voice_active_rejects_finished_session_tracks_and_transcript_survive`, each with `cargo test --manifest-path src-tauri/Cargo.toml --lib CASE --quiet -- --test-threads=1`: 1 passed each. The navigation test also proves the returned ObjectRef carries the actual new owner/ID.
- Combined final affected evidence: all 13 G13 tests passed, including three pinned canonical-worker cases, real SQLite transaction failure, actual owner-lease/fence ordering, repeated-move prior-operation undo, terminal Voice linkage/audio/transcript, exact retained resources, Tag rewriting and cross-window seal/cleanup/cancellation/CAS behavior. The other 11 remain valid after fixture/navigation-only followup; no full-suite repeat.
- Every cargo command above ran beneath `python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py env CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target ...`. The worker setup CoW-copied only local darwin-arm64 runtime and bundled dist; no main node_modules symlink.
- Self Standards/Spec inspection: actual-owner grants verified at source/editor/history/undo seams; sorted owner leases precede fence/SQL; no UI await/global recovery inside storage locks; target seal release precedes lifecycle events; immutable snapshots/receipt JSON preserved. Inspection corrected unordered registration-stamp comparisons and GUI navigation’s old-scope grant/returned object. No independent subagent review claimed (no recursive delegation).
- `git diff --check`: passed. Runtime platform tested: macOS arm64. No Windows/Linux, GUI freeze implementation, invoke-handler registration, migration-number integration or integrated app acceptance run here.

Historical restore/undo still applies ordinary current-scope reference rules: an old immutable version with a now-out-of-scope original Tag mention is readable under actual-owner authorization, but restoring that version may fail typed ScopeDenied. This package remaps current mentions during movement; it does not rewrite immutable history or silently grant access through its original owner. Integration/records must explicitly decide any future restore-time Tag remapping. A prior operation without such invalid references is genuinely undoable after repeated migration (tested).
