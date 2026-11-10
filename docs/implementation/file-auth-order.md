# File and source locator authorization order

This work package addresses the independent review P2 on `4c85bbb` (no separate Issue was supplied), based on integration `73a932ca3a18d7c228000513ec3a8706fa313f42`.

The File version target boundary must reject stale/invalid requests, unauthorized scopes, unlisted objects and foreign Workspace locators before reporting whether a document ID exists. Successful resolution must still verify actual ownership and the object allowlist. Restore requests derived from genuine undo receipts must continue to work with `operation.undo` authority alone; a caller-provided request prefix is not authority.

Main review added the same missing-object allowlist case in Record/Transcript/File source aliases. The earlier independent review did not identify this source-read gap. It is included here at the user's explicit request: remember claimed-object denial only for unresolved aliases; a real alias still authorizes its actual canonical object. Other source kinds are outside this change.

Scope: `file_version_target_scope`, `source_resolve_business`, the real external File bridge and native DB request tests, canonical alias regressions, and affected native File write/restore/undo tests. No schema, frontend, GUI, dependency installation, or other worktree changes. Integration owns final review and merge.

Validation uses the shared `with-build-lock.py`, `CARGO_INCREMENTAL=0`, `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target`, and offline Cargo. The baseline's 722 passing tests are reused; only the new regression and affected families run. The user additionally requested a final `cargo check --all-targets` to cover binary targets. Before editing, the process inventory showed no Tauri/Rust watcher and one unrelated Vite process in the `8db5` worktree.

## Change

Normal File operations authorize the bound request, claimed scope/operation, Workspace and object allowlist before looking up the document ID. Writes do not accept read aliases. The existing post-resolution check still requires the claimed object to equal the actual owner and enforces its object allowlist, live connection, archive state and source policy.

Restore preflight permits either `file.restore` or `operation.undo` for the claimed scope so that a valid undo-only caller can reach the existing receipt verifier. Only that verifier selects `operation.undo`; an ordinary restore without a verified undo receipt still requires `file.restore`. Non-scope failures, including stale binding and invalid request IDs, propagate immediately, and receipt/storage errors are not converted or ignored.

The source resolver records claimed scope/allowlist denial for Record/Transcript aliases and File `source.read` aliases. Only resolution `NotFound` uses that denial. A resolved alias ignores the claimed denial and checks the actual canonical owner/allowlist as before. I/O errors propagate unchanged. Existing move tests now explicitly read old aliases with only the canonical key allowed, both with and without the old scope in the grant.

## Verification

All Cargo commands below use this prefix from `/tmp/project-mind-review-file-auth-order`:

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py env CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target
```

- Red: `cargo test --manifest-path src-tauri/Cargo.toml --offline --lib file_patch_authorizes_before_missing_target_diagnostics --quiet -- --test-threads=1`, **0 passed / 1 failed**, `/tmp/project-mind-file-auth-order-red.log`. Real external bridge calls returned `NotFound` for both a missing foreign-scope ID and a missing ID under a read-only grant. Existing foreign IDs, forged ownership, authorized missing IDs, stale binding and invalid request IDs produced their expected codes.
- Green: the identical command after the native change, **1 passed / 0 failed**, `/tmp/project-mind-file-auth-order-green.log`. The fixture creates the foreign File through its own authenticated bridge grant and verifies its version remains unchanged. No document/extraction worker or mocked permission result is used.
- File object/Workspace red: `cargo test --manifest-path src-tauri/Cargo.toml --offline --lib file_version_target_authorizes_claimed_object_before_missing_diagnostics --quiet -- --test-threads=1`, **0 passed / 1 failed**, `/tmp/project-mind-file-auth-order-object-red.log`. Real DB requests returned `NotFound` for both an unlisted missing ID and a foreign-Workspace missing ID. This uses a trusted native `RequestContext` for object-limited grants, separately from the authenticated external bridge regression.
- File object green and source alias red: `cargo test --manifest-path src-tauri/Cargo.toml --offline --lib --quiet -- file_version_target_authorizes_claimed_object_before_missing_diagnostics source_alias_reads_deny_unlisted_missing_locators --test-threads=1 --format=pretty`, **1 passed / 1 failed**, `/tmp/project-mind-file-auth-order-alias-red.log`. The File object/Workspace regression passed after its fix; all three source kinds reproduced existing=`ScopeDenied`, missing=`NotFound` with an empty object allowlist. Authorized missing and explicitly allowed existing objects remain control cases.

The initially queued affected-only run was cancelled before build-lock admission when main review added the allowlist cases; it produced no test result.

- Final green and affected families: **118 passed / 0 failed / 5 ignored**, **0 warnings**, `/tmp/project-mind-file-auth-order-final-green.log`. This is the final distinct test count, including all three new regressions and the three expanded canonical-alias tests; earlier checkpoints are not added again. The ignored entries are four subprocess fixtures exercised by their passing crash-test parents and one separately gated real `mind` CLI executable test.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --offline --lib --quiet -- \
  agent::bridge::file_write_tests:: db::file_versions::tests:: \
  file_version_service::tests:: db::agent_file_undo::tests:: \
  agent::record_blocks::tests:: db::sources::tests:: db::source_navigation::tests:: \
  working_sessions_keep_native_owner_generation_and_ai_handoff_boundaries \
  markdown_save_rejects_changed_disk_and_forged_owner \
  office_gui_authority_uses_actual_file_owner_and_cannot_save_with_read_only_grant \
  g13_move_old_reads_actual_owner_and_stale_editor_writes_reject \
  g13_review_old_transcript_time_navigation_authorizes_actual_owner \
  old_reference_reads_current_owner_and_canonical_allowlist \
  --test-threads=1 --format=pretty
```

- All-target check: `cargo check --all-targets --offline --manifest-path src-tauri/Cargo.toml`, exit **0**, **0 warning diagnostics / 0 errors**, `/tmp/project-mind-file-auth-order-all-targets-check.log`. This includes lib/test, the main application, `mind`, and `seed_demo_data` targets; check does not launch them. No unrelated warning cleanup was needed.
- `git diff --check`: passed.

## Self review and limits

Standards: **0 remaining findings** in this work package. Authorization remains at the native boundary; the second actual-owner check follows storage lookup. No new compatibility layer, retry, schema or unrelated cleanup was added. Tests use real SQLite/files, authenticated bridge calls or the native DB request boundary.

Spec: **0 remaining findings** in the explicitly expanded scope. Missing authorized locators still return `NotFound`; missing unauthorized scopes/objects return `ScopeDenied`. Stale/invalid requests retain their earlier failures. Actual owner/allowlist checks still protect successful writes and reads. The existing single/group undo tests pass with restore/update/source-read permissions removed. Real old Record/Transcript/File aliases still read through canonical-only allowlists, with old scopes either granted or absent. Non-alias source kinds and non-`NotFound` storage failures keep their prior behavior.

This is a self review, with no subagent or independent approval claimed. Main review supplied the source-read allowlist finding missed in the earlier independent review and owns the final fixed-SHA review/integration. Runtime evidence is macOS arm64 native only. No GUI, application launch, Windows/Linux execution, packaged CLI execution or platform acceptance was performed. No push or merge was performed.
