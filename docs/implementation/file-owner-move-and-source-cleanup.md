# G13 File owner move / G14 native source cleanup

Issue #304. Native baseline `0642da9`; prerequisite repair `88a9d59` is separate so
integration can omit already-fixed baseline errors. Integration owns 04506b4 delta,
IPC registration, schema numbering, editor seals, event publication and UI.
This package changes native code only. No Record migration, G15 metadata, directory
rename/trash feature, frontend, GUI, PR, merge or Issue closure.

## Public native API (frozen)

All methods return `AgentResult<T>`. Filesystem/SQL errors are explicitly converted;
existing typed authorization, CAS and replay errors survive unchanged. Existing
access-denied code is `SCOPE_DENIED`; stale CAS is `REVISION_CONFLICT`, request reuse
is `IDEMPOTENCY_CONFLICT`, binding/fence expiration is `WORKSPACE_CHANGED`.
The wrapper uses `FileCommitHost.database()` outside AppState's global DB lock and
returns direct DTOs via `desktopApi.fileCommand`.

Owner is `Option<i64>` (`null` = Workspace); all DTO fields below are camelCase.
`request` is trusted native `RequestContext`, and binding is `WorkspaceBinding`.

| Method | Arguments after `request,binding` | Result |
| --- | --- | --- |
| `file_owner_move_baseline` | `documentId:i64, sourceOwner:Option<i64>` | `FileMoveBaseline` |
| `file_owner_move` | `&FileOwnerMove` | `FileOwnerMoveResult` |
| `file_owner_move_replay` (read only) | `&FileOwnerMove` | `Option<FileOwnerMoveResult>` |
| `file_drop_prepare` | `source:&Path, target:DropTarget` | `{intentId:string}` |
| `file_drop_commit` | `intentId:&str, trash:&impl SourceTrash` | `DropResult` |
| `file_drop_committed` (read only) | `intentId:&str` | `Option<DropResult>` |

Two trusted locator helpers have **no request context argument**:
`file_drop_target(binding,requestId,intentId)->AgentResult<DropTarget>` and
`file_drop_owner(binding,requestId,intentId)->AgentResult<Option<i64>>`.
They verify native Workspace UUID, full persisted binding and request identity.
Owner delegates to target. Neither locator grants permission; commit/replay repeats
actual object authorization. Wrappers derive only the one target's grant/seal.

```text
FileMoveBaseline = {expectedVersion:i64, expectedWorkingRevision:null|i64,
                   expectedHash:string}
FileOwnerMove = {documentId:i64, sourceOwner:null|i64, targetOwner:null|i64,
                expectedVersion:i64, expectedWorkingRevision:null|i64,
                expectedHash:string}
FileOwnerMoveResult = {documentId:i64, projectId:null|i64, managedPath:string,
                      operationId:string, sourceScope:Scope, targetScope:Scope,
                      oldSessionsClosed:true}
DropTarget = {kind:"new", owner:null|i64, name:string}
           | {kind:"update", documentId:i64, projectId:null|i64,
              managedPath:string, expectedVersionNumber:u32}
DropResult = {documentId:i64, versionNumber:i64, contentHash:string,
              noChange:boolean, cleanupWarning:null|string,
              oldSessionsClosed:boolean}
```

Move baseline uses owner→File→fence, and reads registered history or saved working
revision/hash, including a closed pending working copy. It never initializes working,
opens Office, archives, runs global recovery or changes content. Pending local recovery
rejects baseline. Move CAS uses all three returned fields; the UI must not guess null
or use the archived hash for saved working.

## Object coordination, receipt replay and authorization

Integration's per-File GUI seal runs strict flush only for the affected File. No DB
method waits for editors. Failed flush does not move or close anything. Move deletes
only that File's sessions in the same transaction as its receipt. Successful old Tab
cleanup must skip old-owner working close/save; native close keeps strict actual-owner
authorization. Other File sessions survive. Integration publishes committed changes
for both scopes and `content:owner-moved` only after storage locks release.

`file_owner_move_replay` hashes exactly the same private `{binding,input}` Payload as
move. It takes actual-current-owner→File→fence, authorizes current owner `file.move`
and canonical object allowlist, and returns only an existing receipt. It performs no
move/recovery/write. Missing receipt plus unavailable seal means EditorBusy in wrapper.
Old owner grant alone is insufficient, even for receipt replay.

Stable File IDs alone do not solve old references: the previous source entry point
authorized claimed scope first. `file_resolve_read_alias` now canonicalizes **only
source.read File locators** with current scope or a persisted former-owner alias for
this same `documents.id`. Actual current owner grant, canonical object allowlist,
visibility/archive/exclusion policies apply. An allowlist containing only the old key
cannot authorize the alias. Mutations still reject old-owner locators. Tests perform
actual source capture/read bytes through an old ObjectRef, with old/new grants and
CLI canonical/old allowlists.

Update Drop prepare/commit use the target-only seal with the same requestId. The
wrapper rearms prepare with a fresh nonce/60s expiry; native receives no arbitrary
cleanup path at commit. A changed version ends old sessions atomically with its version
receipt; failed destination commit ends none; noChange retains sessions. The wrapper
publishes `content:file-replaced` (keep/reload target Tab), not owner-moved.

`file_drop_committed` checks the exact native import/version receipt even if saving
`file_drop_intents.result` failed after commit. It authorizes actual current owner and
canonical allowlist under owner→File→fence. It never imports, appends, archives or
cleans source. Pending/interrupted cleanup is returned as a separate warning.

## Move persistence and recovery

Global recovery runs before lease/fence admission. Acquire exclusive source/target
owner leases in sorted `Option<i64>` order (Workspace first), then File lease, then
fence, then SQL. Target archive/name collisions are rejected. Source/target are owner
roots, not relative path moves. Copy+verify a create-new staging file on the destination
volume; never assume source rename works across volumes. A synchronous SQLite journal
pins source/target/staging/retired relative paths, physical identities, hash, binding,
request and frozen payload before placement.

One transaction commits owner/head/working identity, directory index, Tag links mapped
by label/color, read aliases, policy keys, source/target change logs, sessions and receipt.
File ID and all version IDs/numbers/hashes are preserved. Immutable history paths remain;
only a current version path that aliases the live head follows the moved head.

Precommit recovery removes only journal-owned staged/placed bytes with matching
identity/hash. Postcommit recovery first verifies target, then retires/removes the old
live duplicate using identity/hash checks. Replacements are retained. Ambiguous cleanup
retains journal evidence; it does not turn a committed receipt into an uncommitted move.

## Drop persistence and recovery

Prepare snapshots source bytes **before** native import/version prepare. A durable
intent pins original frozen request, canonical source, physical identity/hash and the
owned immutable staging path. A per-request lease serializes pending prepare/replay.
For Update, original target version/path and saved working revision/hash are checked.
Only that File's saved pending working is explicitly archived. Its `post_archive`
baseline marker commits in the **same working archive SQL transaction**. Retry resumes
this marker; it cannot append a duplicate archive. No working/Office/session is opened
when none exists. Later writer changes fail CAS. The final intent uses post-archive
version/hash while its prepare receipt keeps the original frozen payload.

Destination import reuses the native import journal and `file.create` receipt. Update
reuses native original-location replacement journaling and a distinct `NativeDrop`
version payload; old NativeCas payloads keep their serialization. The destination
receipt is durable before cleanup. Default Trash adapter uses system Trash; all tests
use isolated fixtures/adapters and never recycle user files.

Cleanup requires readable destination hash equal to receipt and captured source hash.
It rechecks source regular-file kind, canonical path, physical identity and hash. Same
physical managed Files, any Workspace paths (including history/resources), symlinks and
directories are protected. A matching independent external copy is eligible even for
noChange. Persist attempted state before a same-directory exclusive quarantine rename;
verify again before Trash. Failure restores source where safe, retains target, and
returns a warning. An ambiguous crash never repeats Trash automatically. Request replay
does not repeat import/version creation or recycling. Cross-Workspace/binding replay
is rejected. One source failure does not undo other successfully imported files.

## Schema and integration conflicts

No numbered migration or user_version is allocated in this worker. Integration must
allocate one for additive tables initialized by `ensure_file_flow_schema`:

- `file_owner_move_journals`: one pending move payload per document.
- `file_owner_aliases`: stable document ID + former scope key, FK cascade on deletion.
- `file_drop_intents`: unique request, payload JSON, result JSON, cleanup state/warning.

Root/shared edits needing reconciliation: db.rs module declarations and Project root
lifecycle guards; working schema initialization, post-lease owner validation, explicit
Drop archive marker; global File recovery dispatch; import authority discriminator;
File source.read resolver; original-location replacement receipt/session handling.
Integration owns final root registration and reconciliation with 04506b4/G15/files.

A real regression proved source Project trash could destroy moved File history.
`file_owner_require_unshared_root` rejects root rename/trash while it contains another
owner's managed/history/version paths. Hooks cover Project rename/delete and persisted
Project-trash retry. Latest files directory rename/trash must reuse this guard. This
observable restriction preserves required immutable history paths; history relocation
is outside this package.

## Verification and platform boundary

Behavioral red logs: `/tmp/g13-g14-red-2.log`, `/tmp/g13-g14-fix-verify.log`.
Initial expanded verification: `/tmp/g13-g14-green-1.log` (15/17 passed); the two failures
were fixed and passed exact reruns (actual old-reference reads and old root lifecycle).
`/tmp/g13-g14-green-2.log`: all 13 move tests passed (one helper ignored), including four
real process-death recovery stages; 14/16 Drop tests passed, two changed-update failures
diagnosed at the obsolete managed-copy version route. Final results recorded below.

All Cargo commands use the shared build-lock wrapper, `CARGO_INCREMENTAL=0` and the
explicit shared target. Native services use real temporary DB/files/leases; no GUI or
system Trash is invoked. Windows Trash/locking and macOS real system Trash GUI acceptance
remain integration platform gates. Destination-volume staging is exercised, but no real
second mounted volume has been verified here; algorithmic copy/verify is not a substitute
for that platform evidence. Do not declare #304 fully delivered or close it from this work.

### Final native verification (implementation diff at delivery)

| Filter | Passed | Evidence |
| --- | ---: | --- |
| `db::file_owner_move::` | 13 | `/tmp/g13-g14-green-2.log` (unchanged move/alias/root behavior reused) |
| `db::file_drop::` | 17 | `/tmp/g13-g14-final-verify.log` |
| `db::file_working::tests::` | 20 | `/tmp/g13-g14-final-verify.log` |
| `db::source_files::tests::` | 13 | 4 passed initially; 9 resource-dependent failures rerun successfully in `/tmp/g13-source-remaining.log` |
| `db::sources::tests::` | 3 | `/tmp/g13-source-remaining.log` |
| `directory_file_restore_` | 5 | `/tmp/g13-source-remaining.log`, including real process interruptions |
| `binary_file_create_preserves_bytes_replays_and_cleans_failed_import` | 1 | `/tmp/g13-source-remaining.log` |

Total: **72 distinct targeted tests passed**. Ignored child-process helpers are invoked
by their parent tests; the unrelated combined Record worker fixture remains excluded.
The source retry used CoW copies of only generated `source-extractor` and fixed
`agent-host/node` resources, never a node_modules symlink. Resource checksums and the
fixed Node version are verified by the real extraction worker before those nine tests
run. No native assertion was weakened or skipped to conceal missing resources.

Reproduce native tests using:

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
  env CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target \
  cargo test --manifest-path src-tauri/Cargo.toml --lib FILTER -- --test-threads=1
```

The source retry additionally skipped the four already-passed tests listed in
`/tmp/g13-source-and-remaining.py`; it did not repeat unrelated full suites.
`git diff --check` passed. Native crate compiled on macOS arm64, without opening an app.
Self-checks covered Standards (scope, explicit errors, leases/fence, no blanket grants,
no source checkout changes) and Spec (identity/history, receipts, source cleanup safety,
object-only sessions). Integration still owns independent final review/platform gates.
