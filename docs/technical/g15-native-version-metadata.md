# G15 native File Version metadata — #304

## Work package

- Baseline/dependency: native contract `0642da98dbace737a7d5013c6e93a06f8786c64b`; its final native verification is owned by integration.
- Authority: G15 in `codex/review-file-flows:docs/requirements/file-flows-spec.md` and GitHub #304.
- Delivery: independent display name, important flag, revision CAS, bound native GUI command, durable receipt and outbox, read projections, persistence protection.
- Non-goals: Record/File movement, source cleanup, UI, automatic retention policies, single-version manual deletion, PR/merge/Issue closure.
- Acceptance: trim/null and Unicode validation; actual File/version ownership and Workspace generation; receipt replay and payload conflict; concurrent stale writes rejected; immutable identity/hash/content preserved; metadata survives reopening/renaming/new versions; whole File deletion remains available.
- Verification seams authorized by the task: real temporary SQLite/files, native services, wire serialization, persistence constraints. No GUI.
- Rust/build commands use the wave build lock, `CARGO_INCREMENTAL=0`, and shared regenerable target. Only targeted affected tests; no repeated full suite.

## Integration boundary

The metadata migration is independent from directory journal schema work. Schema numbering and every initialization/runtime-connection path must be reconciled during integration. Movement must preserve version rows and metadata columns; no movement implementation is included here.

## Selected public native contract (for integration / G13)

- Command: `file_version_metadata_update` (trusted GUI only; integration owns final registration).
- Arguments: `{ input: { binding: WorkspaceBinding, requestId: string, data: { object: ObjectRef(kind=file), versionId: string, expectedMetadataRevision: integer, displayName: string|null, isImportant: boolean } } }`.
- Result: `ApiResponse<{ object, versionId, displayName, isImportant, metadataRevision }>`; object is the same authoritative File location. This operation does not move anything or return a new location.
- Both metadata values are submitted together against a single nonnegative revision. Empty/whitespace display name becomes null. Stale CAS is `REVISION_CONFLICT`; changed payload reuse is `IDEMPOTENCY_CONFLICT`.
- Durable operation/change-log name: `file.version.metadata.update`; changed ref is the owning File. Existing committed-change publication delivers binding/requestId/seq/changedRefs after locks are released; replay creates no second log.
- Read contracts: `file_versions_list`, `file_versions_get`, and legacy `document_list_versions` gain `displayName`, `isImportant`, `metadataRevision` on each version.
- Independent migration function: `ensure_file_version_metadata_schema`; temporary schema 41 is local to this branch and MUST be reconciled with directory journal migrations by integration. Integration owns the combined initialization and command registry.
- No frontend files, project-content-lifecycle, content workspace/layout, caller invalidation or reference candidates are owned here. No global flush is added. G13 owns target-object flush and closes only the successfully moved old-location tab.

## Baseline compilation note

The first Rust attempt on 0642da9 failed before reaching the regression: four
anyhow-to-rusqlite mapper mismatches in agent_creation_batches plus a missing test
enum import. Local prerequisite commit `3784984` only unblocked those errors.
Native final `04506b4` already fixes the same sites; integration should retain that
upstream solution and take the subsequent G15 commit independently.

Actual red: `g15_version_metadata_defaults_and_important_retention` ran and failed
with `wire.get("displayName") == None`, expected `Some(Null)` (0 passed / 1 failed).
Implementation adds metadata columns and real persistence triggers, not a future-only
helper. Existing registered hash UPDATE immutability is reused; DELETE/REPLACE and
important version identity guards are additional. Existing File version, working
archive and directory reconciliation services keep appending immutable snapshots.

No command registry edit is included: integration must add
`file_read_commands::file_version_metadata_update` to the Tauri handler list.
The local schema is provisionally 41; integration must keep the independent helper
and reconcile all fresh/38/39/40/current and runtime-connection initialization paths.

## Verification and review

Common required prefix (every Rust/build/format invocation):

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py env CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target
```

Commands appended to that prefix:

| Command | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib g15_version_metadata_defaults --quiet -- --test-threads=1` before implementation | RED: missing displayName; 0 passed / 1 failed |
| same targeted command after schema/projection/protection implementation | GREEN: 1 passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib g15_ --quiet -- --test-threads=1` | GREEN: 7 passed, 0 failed (real temporary DB/files/native services plus wire deserialization) |

The seven tests cover defaults, whole File deletion, strict IPC input, Unicode
limits/control rejection/trim/null, stale CAS and durable replay/payload conflict,
actual File/version authorization, reopen, rollback on outbox failure, closed
Workspace fence, two real connections competing for one metadata revision,
managed-copy append/rename, working save/idle archive/restore, exhausted capacity,
directory registration/reconciliation/rename, schema-40 migration and important
DELETE/INSERT REPLACE/UPDATE REPLACE/hash protection.

Standards self-review: no unresolved findings. Scope uses existing Project/File
leases, Workspace fence, transaction receipt/outbox and publication services;
there is no new retention framework, auto cleanup, editor coordination or frontend.
Spec self-review: no unresolved findings for this native G15 package. Whole #304,
registration, combined migration/root wiring, owner movement and platform/UI
acceptance remain integration work. No review subagent was launched (no recursive
delegation per task).

Platforms: tested on this macOS host only. No GUI, Windows/Linux native runtime,
Windows filesystem behavior or integrated Tauri IPC invocation was validated.

The existing `db::file_reads::tests::` regression command is additionally queued
under the same build lock to verify both affected version projections. Its result
is pending at this implementation commit; no broader full-suite rerun is requested.
`rustfmt --edition 2021 src-tauri/src/db/file_version_metadata.rs src-tauri/src/db/file_version_metadata_tests.rs`
completed successfully under the required prefix; subsequent changes are formatting only.
`git diff --check` passed. No frontend build/test is needed for this native-only
package; frontend type additions and IPC registration remain owned by integration/G13.
