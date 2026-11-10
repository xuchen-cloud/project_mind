# Integration warning cleanup

## Work package

- Association: the user-authorized integration cleanup, based on `9b43d6ab19282103b02326e91fb64249ee7e02cb`; this is not a separate functional Issue completion.
- Dependencies: the combined Records, Files, Office, assistant, Mermaid, observer and final flow snapshot already in this branch.
- Delivery: remove unused imports/bindings and obsolete helpers; compile test-only adapters only in tests; preserve Windows implementations and assistant APIs awaiting integration.
- Non-goals: owner-move/drop behavior, directory changes implementation/tests, all frontend work (owned by integration), dependency installation, GUI verification, warning suppression, broad formatting, publishing or merging the integration branch.
- Acceptance: successful production library check, successful test compilation and affected native tests, no new warnings, and documented reasons for retained assistant warnings.
- Verification: all cargo/npm/install commands use the shared build lock; Rust uses `CARGO_INCREMENTAL=0` and `/Users/xuchen/project_mind/src-tauri/target`. No GUI or `tauri dev`.

## Production verification

The baseline and final checks both succeeded with the same environment and command:

```sh
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target \
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
cargo check --lib --offline --manifest-path src-tauri/Cargo.toml
```

Compiler diagnostics decreased from **150 to 102**: 48 removed, zero new diagnostics when compared by source file and warning message. Compiler summary lines are excluded from this count. Local logs are `output/warning-cleanup/check-before.log` and `check-after.log`; the exact comparison is `warning-comparison.json` in the same directory.

The 102 retained warnings are intentionally visible:

| Family | Diagnostics | Reason |
| --- | ---: | --- |
| Agent conversation, operation conflicts/review execution, source trace and tool-description/schema helpers | 53 | Assistant capabilities not yet connected to production consumers; retained under the main agent's coordination boundary to avoid interfering with parallel work. |
| Agent profiles, sessions, session maintenance/search/model search/summary, run provenance and output decisions/review | 46 | Currently unwired assistant APIs/support chains; retained under the same coordination boundary. |
| `WorkspaceRuntime::agent_cancel_started` | 1 | Pending assistant cancellation state, retained to avoid changing parallel assistant work. |
| `SessionHistoryUtility::scan` | 1 | Pending assistant history interface, retained under the integration coordination boundary. |
| `Database::file_drop_owner` | 1 | Drop file ownership belongs to integration, outside this subtask; the main agent will verify its current references and handle cleanup separately. |

The merged assistant history path calls `AssistantProcess::launch` from `dsh_history.rs`, so both `launch` and `launch_with_source` remain production code. `history_preparation`, `execution_ready`, `lock_runtimes`, `runtime_status` and `workspace_runtime_command` are untouched.

## Semantic boundaries

- Only test-consumed imports, adapters and diagnostic fields gain `cfg(test)`. Production Record save/restore/mutation, source indexing, registry reconciliation, Overview batch publication and voice recovery paths remain compiled.
- Windows PATH helpers use `cfg(any(windows, test))`. Hidden test subprocess builders keep the Windows `creation_flags(0x08000000)` call and make only that branch mutable.
- The unused `read_grant` helper and request counter/accessor/increment are removed. The separate hash-verification counter remains.
- `GeneratedOverview.usage` and its unused plumbing are removed. The external response still requires an object-valued `usage`, and output text/budget validation remains intact; the existing test now also asserts the returned text.
- No `allow(dead_code)`, `allow(warnings)` or underscore replacement fields were added. No owner-move/drop or directory-changes files were changed.

## Test verification

The complete library test configuration compiled successfully. The targeted run passed: **140 passed, 0 failed, 5 ignored, 1697 filtered out**. The five existing ignored tests require the prepared fixed Node runtime and built Record/source workers; their ignore attributes were not changed, and this cleanup does not claim those runtime integration checks. No dependency installation or cache preparation was needed for the 140 executed tests.

```sh
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target \
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
cargo test --lib --offline --manifest-path src-tauri/Cargo.toml -- --test-threads=1 \
  overview_model::tests:: overview_generation::tests:: overview_maintenance::tests:: \
  overview_service::tests:: knowledge_service::tests:: source_session_read::tests:: \
  source_search_index::tests:: source_service::tests:: db::source_index_queue::tests:: \
  db::source_registry::tests:: db::overview_maintenance::tests:: workspace::tests:: \
  agent::bridge::cli_install::tests:: record_editor_coordination::tests:: \
  quick_note_transfer_ source_worker_rejects_inconsistent_coverage_and_source_anchors \
  source_runtime_fixture_does_not_change_shared_node_identity_or_stamp
```

The test build retains **8 warnings**: five currently unwired assistant symbols retained under the coordination boundary (`agent_cancel_started`, `agent_session_mark_read_only`, `agent_session_summary_get`, `agent_pending_review_plans`, `SessionHistoryUtility::scan`) and three `unused_mut` diagnostics in files owned by integration: `db/project_directory_changes_recovery_tests.rs:8,240` and `db/project_directory_changes_tests.rs:637`. Those integration-owned files are unchanged. Local evidence: `output/warning-cleanup/tests-after.log`.

Windows PATH helper tests passed on macOS. The Windows-only subprocess flag branch was inspected, but no Windows target build was performed. No frontend install, application build or GUI run was performed. Rust source hashes were checked after verification to reuse the successful production/test results without redundant builds.

## Self review

- Standards: inspected the diff against `9b43d6ab19282103b02326e91fb64249ee7e02cb` for scope, repository verification rules, unnecessary abstraction/formatting and warning suppression. No outstanding findings.
- Spec: checked cleanup authorization and the integration ownership boundary against each removal and cfg boundary; verified merged assistant production references, retained Windows behavior, parallel-work boundaries and response validation. No outstanding findings.
