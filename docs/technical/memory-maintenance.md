# Native memory organization work package

Issue: #219, US06/US07. Dependencies: native memory fact/version store, editable Workspace memory Skill, `OverviewModel` / `AppOverviewModel`, existing Overview worker and Workspace assistant schedule settings.

## Delivery

The existing Overview worker checks one due memory scope before its source-dependent Overview work. There is no additional daemon or fabricated user session. Memory changes are independent of source-dirty state. The enabled switch, 24/48-hour interval, timezone and local time come from Workspace assistant settings; next-slot calculation reuses the existing Overview scheduler, including DST handling. A settings revision change retimes a completed or failed run from its original cycle time.

Each scope handles at most one bounded batch per cycle: at most 50 active unlocked facts, further reduced to fit the real model capacity. Fact IDs are ordered and selection resumes after the previous batch's last ID, wrapping at the end. The whole current suppression list remains an explicit negative constraint; it is never silently truncated. If mandatory instructions, constraints and one fact exceed capacity, that cycle records a budget error instead of dropping constraints.

The current Workspace Skill is read for every model run. The model may only patch or merge facts in its prepared batch and scope. Native application uses `MemoryOrigin::Organization`, preserving CAS, locks, suppression, provenance, inferred versions, atomic merge rollback and the actual approval setting. Confirmation cannot be supplied by model output.

## User controls

The Workspace memory dialog lazily opens a shared Skill editor and actual schedule controls. The switch explicitly enables the Workspace assistant and automatic organization together. Users can select the supported 24/48-hour interval, local time and IANA timezone, then save explicitly. Saves use the captured Workspace generation and settings revision; conflicts retain the unsaved form. These controls update the same settings used by the worker, preserving unrelated assistant settings.

Native `memory_schedule_get` and `memory_schedule_save` expose those settings plus a redacted latest-run summary. Reads are scope-authorized; writes require the local main GUI. Shared `read_schedule` / `save_schedule` helpers support the separately authorized DSH bridge. Status contains phase, due time, error and receipt identity/pending state, excluding fact snapshots and raw model output.

## Durability and interruption

`agent_jobs` holds one immutable-identity run per cycle under `memory-organization:<workspace>/<scope>/<id>`. Its payload records phase, fact snapshot, suppression constraints, behavior revision, settings revision, next due time, raw model response, actual usage, profile, receipt and error. Latest state is available through `Database::memory_maintenance_status(binding, scope)`.

Generation intent is persisted before Provider work. A restart with only a generating marker ends that cycle as interrupted instead of charging another model call. Raw model output and usage are persisted before parsing and application. A prepared result replays the same native request ID after a crash; an already committed application returns its idempotent receipt. Revision conflicts and invalid model output end the cycle visibly until the next scheduled slot. This package does not add an immediate retry or a separate refresh control.

The native adapter retains the current Workspace guard for synchronous operations and checks generation and unlocked AI secrets. Workspace enabled state and source foreground work are checked before generation and apply. The real DSH foreground check also runs before work, every 250 ms during generation, and before apply. If Workspace access disappears before the failure can be recorded, the durable generating/prepared marker remains for recovery when that Workspace becomes available again. Suppression changes during generation invalidate the prepared application.

## Non-goals

Extracting new facts from newly read sources, and atomically publishing Overview and memory together, are separate work packages. This cycle organizes existing native facts only. Model stubs validate orchestration, storage and recovery; they do not establish semantic quality on a real Provider.

## Verification scope

Targeted native tests cover schedule CAS, unrelated-setting preservation, status redaction, unsupported intervals, source-independent scheduling, silent inferred updates, preserved conditions, usage receipts, approval mode, foreground deferral, crash replay without repeated model work, user-edit CAS conflict, forbidden additions, fair bounded selection, mandatory suppression constraints and schedule changes. Targeted UI tests cover explicit save, truthful receipt timing, conflict draft retention, Workspace changes and lazy loading. Parent integration validates the real DSH Provider route. No application windows or full suites are required for this package's development loop.

Development checks on this implementation: `cargo test --manifest-path src-tauri/Cargo.toml --lib memory_maintenance::tests --quiet` passed 11 targeted native tests; `vitest run src/components/memory/MemoryScheduleEditor.test.tsx src/components/memory/MemoryDialog.test.tsx --maxWorkers=1` passed 14 UI tests. Existing unrelated compiler warnings remain. These are orchestration checks, not real-model semantic-quality evidence.

## Remote background organization acceptance

The ignored `memory_maintenance::model_evaluation::memory_background_real_model_organization_and_rollback` test uses a private Provider config, verified packaged `ModelRuntime`, production capacity/generate calls, the current Workspace Skill and `memory_maintenance::step`. It seeds two semantically duplicate facts with the same condition plus one unrelated fact into real SQLite. It inspects the actual organization receipt, then uses native rollback within 24 hours to verify restoration, locks and independence. It does not rewrite model output or manufacture a mutation when the model returns no changes. Reports use restricted temporary directories and contain no credentials or Provider profile fields.

Two initial real calls exposed output-protocol gaps and were rejected by native validation before any mutation: the first used `type` instead of `action`; the second omitted required `scope`. Their actual usage is retained separately: first input 1,139 / output 3,039 / total 4,178; second input 1,103 / cache-read 128 / output 622 / total 1,853. These rejected attempts are not organization or rollback successes. The production prompt corrections belong to the main integration agent.

After the production prompt supplied the complete required JSON protocol, attempt 3 passed the real remote acceptance on 2026-10-23: all nine checks succeeded. One actual generation call merged the two conditional facts silently into an inferred version; the condition survived; native rollback restored both original facts and locked them; the independent fact remained byte-for-byte unchanged before and after rollback. Actual runtime usage: input 1,025, cache-read 512, output 524, total 2,061 tokens. The capacity call and generation call each ran once. The credential-free [successful report](evidence/memory-background-20261023-attempt-3.json), [first rejected attempt](evidence/memory-background-20261023-attempt-1.json) and [second rejected attempt](evidence/memory-background-20261023-attempt-2.json) retain actual output, state and usage.

Total real usage across all three attempts, including the two rejected protocol responses: input 3,267, cache-read 640, output 4,185, total 8,092 tokens. The evaluation agent received both the successful run and the separate debug consumption, avoiding a claim that rejected attempts were successful operations. This is one fixed background-organization acceptance case, not the broader multi-turn three-arm semantic evaluation. No test adapter repaired model output or substituted a synthetic result.
