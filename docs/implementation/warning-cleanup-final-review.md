# Rust warning cleanup after assistant integration

## Work package

Baseline: `cc99b732d5a18400af8c7722024e134117c5e73e`, isolated branch `codex/review-warning-cleanup-final`. This is the integration-requested continuation of the warning cleanup, not a new product feature or an Issue closure. Related specifications: the DSH migration in #121/#250 (`docs/requirements/dsh-assistant-migration.md`) and integrated assistant delivery #305 (`docs/implementation/assistant-summaries-305.md`).

Deliverable: remove genuinely unused internal members and compile test-only legacy adapters only in tests, preserving production behavior, database migrations and serialization contracts. Frontend, Office, Fileflow and directory implementations are outside this work package. The earlier assistant boundary was coordination for parallel work; integration has now authorized reviewing it.

Acceptance: compare against the actual 101 production diagnostics and five test diagnostics; run one production library check and the complete affected agent/database test families through the shared build lock; self-review Standards and Spec. Recheck only if a failure or source change invalidates evidence. No GUI, dependency installation, new features or lint suppression.

## Source boundary analysis

- `dsh_assistant.rs::session_request` and the scoped endpoint routing own current session create/list/search/delete. The DSH migration explicitly excludes converting or deleting old Pi session files/databases. Old SQLite projection writers/search adapters are therefore retained for their regression tests; production history reads, schema migrations and orphan-run recovery stay compiled.
- `agent/bridge/registry.rs::registered_methods` generates current tool schemas from the typed inputs and is consumed by `agent/bridge/mcp.rs`. Handwritten descriptors in `agent/{tools,record_write_tools,file_tools,todo_tools}.rs` have only test consumers (`tools_tests.rs` and their inline schema tests). Typed wire DTOs and their `schemars`/Serde contracts stay compiled.
- `agent/source_trace.rs` keeps derived/published-source visibility, context provenance and expansion in production. The legacy result-field extraction chain is consumed by `source_trace_tests.rs` only.
- `db/agent_session_model_search.rs` keeps `SourceReadRecord`, `source_session_record`, message reads and their authorization. Legacy search DTOs and query entry points remain in the existing tests. `agent_session_search_schema` and all SQL files remain production code.
- `OperationBatchConflict.operation_ids` has no serialization derive or production reader; existing batch-plan tests inspect exact missing operation IDs. Only that diagnostic payload, parameter and construction are test-only; conflict reasons, errors and undo checks remain production code.
- `agent/output_service.rs::execute_review_decision` is used only by `agent/file_dispatch_tests.rs`. The production Tauri command in `agent/output_review.rs` still calls the unchanged `Database::agent_output_review`; ordinary per-output execution, receipts and cancellation checks remain compiled.
- `db/agent_profiles.rs::agent_profile_verified` is a test assertion helper; profile resolution and verification receipt writes remain production code. `db/agent_run_provenance.rs::{agent_run_provenance_begin,agent_run_context_check,provenance_insert}` are used by the provenance regression tests. The production observe path (`agent/tools.rs`), source visibility and stored provenance representations remain compiled and unchanged.
- `db/agent_outputs.rs::{DecisionStatusSummary,DecisionStatusItem,agent_output_decision_summary}` are consumed only by `db/agent_output_review.rs` tests. Their test serialization stays intact; production `RuntimeOutput`, `OutputReviewResult` and `ReviewReceipt` fields/Serde attributes are unchanged.
- Five symbols have no calls/overrides even in tests: `WorkspaceRuntime.agent_cancel_started` (only field/initializer), `Database::agent_session_mark_read_only`, `Database::agent_session_summary_get`, `Database::agent_pending_review_plans`, and the default `SessionHistoryUtility::scan`. These are internal members, absent from command registration and the current DSH contract. Removing them does not remove persisted `read_only` handling, summary list/successor reads, durable output review receipts or `SessionHistoryUtility::{read,advance_index}`.

The 101 baseline diagnostics cover these complete groups (one compiler diagnostic can name several methods):

| Paths under `src-tauri/src` | Baseline diagnostics | Treatment |
| --- | ---: | --- |
| `agent/{tools,record_write_tools,file_tools,todo_tools}.rs` | 38 | Test-only handwritten descriptors and dependencies |
| `agent/conversation.rs`, `db/{agent_sessions,agent_session_maintenance,agent_session_search}.rs` | 35 | Test-only legacy projection/lifecycle/search chain; remove unused `agent_session_mark_read_only` within the grouped method diagnostic |
| `agent/source_trace.rs` | 9 | Test-only result extraction helpers |
| `agent/output_service.rs` | 1 | Test-only legacy decision executor |
| `agent/operation_batches.rs` | 1 | Test-only conflict-ID diagnostic payload |
| `db/agent_profiles.rs` | 1 | Test-only verification lookup |
| `db/agent_run_provenance.rs` | 1 | Test-only legacy begin/context helpers |
| `db/agent_session_model_search.rs` | 8 | Test-only search inputs/results/entry points; retain authorized source reads |
| `db/agent_outputs.rs` | 3 | Test-only decision summary |
| `lib.rs`, `db/{agent_session_summary,agent_output_review}.rs`, `source_session_read.rs` | 4 | Remove the other four unused members |

No production-reserved warning is retained solely as “pending.” The remaining live contracts have real consumers: `lib.rs` invokes orphan recovery; `source_session_archive.rs` reads session snapshots; `overview_session.rs` lists summary nodes; `source_session_read.rs` reads authorized historical messages; the native output-review command persists decisions. Preservation follows #121/#250's existing-data/authorization/receipt constraints and #305's integrated DSH history path, rather than protecting every old assistant API.

## Baseline failure owned by integration

The affected-family run completed **609 passed, 1 failed, 10 ignored**. The failure is `agent::record_blocks::tests::record_blocks_authorizes_policy_scope_withdrawal_and_keeps_legacy_uninitialized`: actual `NotFound`, expected `ScopeDenied` at `agent/record_blocks.rs:569`.

At integration's request, only that test was rerun against exact `cc99b732d5a18400af8c7722024e134117c5e73e` Rust sources. Before running, `git diff --exit-code cc99b73 -- src-tauri` was clean. Result: **0 passed, 1 failed, 1867 filtered out**, the same assertion, exit 101. Cleanup sources were backed up and restored byte-for-byte in this worktree; no other worktree was modified. Evidence: `output/warning-cleanup-final/baseline-source-proof.txt` and `baseline-record-blocks-red.log`.

Minimal cause: the new Record/Transcript branch in `db/sources.rs::source_resolve_business` invokes the owner/alias resolver before request authorization. This fixture supplies a Workspace Record ID in the Project namespace with no Project record or alias; `record_owner_moves::actual` returns `NotFound` before the prior `ScopeDenied` check. Integration separately owns restoring authorization diagnostic precedence while authorizing legitimate historical aliases against their actual owner. This cleanup changes neither `agent/record_blocks.rs`, `db/sources.rs` nor the test expectation. The failure remains red here; no overall green claim is made.

## Verification

All cargo runs were serialized with `python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py`, with `CARGO_INCREMENTAL=0` and `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target`. All used `--offline --manifest-path src-tauri/Cargo.toml`. No frontend verification, GUI or dependency installation was performed.

| Check | Result | Local evidence under `output/warning-cleanup-final/` |
| --- | --- | --- |
| Integration production baseline | 101 warnings | `production-before.log` (copied from combined's native build log) |
| Integration test baseline | 5 warnings | `tests-before.log` (copied from integration `native-2.log`) |
| First `cargo check --lib` | Success; original 101 removed, 2 newly exposed test-only imports | `production-after.log` |
| Final `cargo check --lib` after gating those imports | Success, **0 warnings** | `production-final.log` |
| Complete affected test families | **609 passed / 1 baseline failure / 10 ignored**, **0 compiler warnings** | `tests-after.log` |
| Exact cc99b73 baseline singleton | **0 passed / 1 failed**, same assertion; 5 baseline compiler warnings | `baseline-record-blocks-red.log` |
| Final import-affected database suites | **13 passed / 0 failed**, **0 compiler warnings** | `imports-tests-final.log` |
| Explicit prepared Record worker tests | **3 passed / 0 failed**, **0 compiler warnings** | `record-runtime-tests.log` |

The full affected run used:

```sh
cargo test --lib --offline --manifest-path src-tauri/Cargo.toml -- --test-threads=1 \
  agent:: db::agent_ source_session_read:: \
  overview_maintenance::tests:: overview_generation::tests::
```

After moving only `ObjectKind` and `Caller` imports behind `cfg(test)`, the two affected database suites were rerun (`db::agent_run_provenance::` and `db::agent_session_model_search::`). Other passed tests retain their evidence: these import edits preserve the same bindings in the test configuration. The 609 green cases were not rerun for integration's separate authorization repair.

The three worker tests were selected with `--ignored --test-threads=1 agent::bridge::write_tests::`. They cover contact pinyin, canonical document history and text edits/replay/undo. These are three of the ten original ignores, leaving seven unexecuted acceptance/performance tests: three require the standalone debug `mind` executable, one requires a manual CLI fixture, and three are E16 performance samples. Ignore attributes were not changed. This remains a cleanup verification with the explicitly recorded baseline failure, not an overall green native suite.

Resource reuse: this tree received its own `packages/agent-host/runtime/darwin-arm64` and `packages/agent-host/dist` via copy-on-write from combined's existing cache. Node **24.21.0**, its executable/license checksums, the Record distribution's notices and **120 bundle checksums** passed validation; 14 relevant source/config files matched the cache tree. Manifest SHA-256: `00ea30cb1b14bd969be87638252cc272de94b266fc527f0bc9e2cec7aa55faa3`. The exact cache/source receipt is `resource-receipt.json`; no cached source was edited.

`warning-comparison.json` records diagnostics without compiler summary lines. `verification.json` / `verification-followup.json` retain commands, exit codes and durations. `final-source-hashes.json` verifies all 388 Rust source-directory files remained unchanged through final verification; documentation-only updates need no rebuild. Zero warnings refers to this macOS production library check and library test configuration; no new Windows target build is claimed.

## Self review

- **Standards:** personally reviewed the complete diff from cc99b73 using the code-review skill's Standards axis and repository instructions. Changes are limited to 20 Rust files plus this report. No new lint allowances, visibility widening, feature flags, underscore replacement fields, framework, broad formatting or test expectation changes. No frontend, Office/Fileflow, directory or owner-move implementation changes. No cleanup-specific outstanding finding.
- **Spec:** personally traced each gated entry to its test consumers and checked the surviving production callers above. Database migrations, stored enum variants, wire fields/Serde attributes, native registry schemas, authorization/receipt operations and Windows branches are preserved. The five deleted members have no callers, registered commands or current supported external contract. All 101 baseline production warnings and five test warnings are removed without claiming the known baseline test failure is green.
- **Integration boundary:** the authorization-precedence defect reproduced on exact cc99b73 remains owned by the main thread, which will supply its separate fix and green evidence. This commit is a cleanup handoff only; it does not merge/publish or close #121, #250, #304 or #305. No review subagent was launched.
