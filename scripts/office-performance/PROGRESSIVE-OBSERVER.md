# G12 progressive Office observer compatibility

Issue #307 (G12); isolated implementation based on cc99b73. Dependency: Office
progressive API at ca188a7, read-only reference in a263. Integration/review and
native reruns belong to the coordinating thread.

Deliver: observe actual model and XLSX view responses, with full object identity,
immutable version/hash or working session baseline identity; preserve native
response/rejection objects and reject cross-source or out-of-order contamination.
No extra inspect/read, fabricated content, relaxed visual/content gate, product
Office changes, File flow duplication, GUI, cargo, subagents, or publication.

Acceptance/verification: red then green through the existing native command-wrapper
and visual-proof boundaries; reuse all 46 existing boundary tests; cover deferred
model/read completion, historical/current isolation, missing/wrong media/ranges,
foreign/failing envelopes and unchanged responses. Run Node 24 only, every
build/test command through the review-wide with-build-lock.py. Finish with
Standards/Spec self-review and a local commit; native acceptance stays pending.

## Implementation and review

- `NativeOfficeObserver` records successful native envelopes through the actual
  `command`/`fileCommand` wrappers. Request identity is copied before awaiting.
  A late model cannot replace a later requested source. Read replies do not
  select a model. `ready()` also matches the selected source callback.
- Historical reads join by full scoped File identity, binding generation,
  version and expected hash. Working reads join the opened session's original
  hash/revision, independent of later save receipts. XLSX `coverage.sourceHash`
  must match that baseline (native hashes have the `sha256:` prefix).
- Known cells and media remain separate observer evidence. Native models,
  response/rejection objects and declared Range coverage are not rewritten.
  Same-source reads can arrive before or after the model; latest dispatched
  overlapping reads win, with cells kept in row/column order.
- Missing asynchronous data is unready. Successful media/range observations are
  still subject to exact image source/decode/visible-pixel, chart value/geometry,
  formula, canvas-composition and stable-layout gates. The standalone browser
  probe retains the exact same visual-check function (verified by its test).
- `nativeSource`, `nativeReads` and command `requestId` make the successful
  source/read relationship explicit in reports. No base64 evidence is added to
  report metadata. No extra native request is issued.

Standards self-review: source/request boundaries are typed and isolated; no
product source changes or native IO in the observer; response identity and
rejection identity preserved; test fixtures reuse the original wrapper rather
than a replacement implementation. New entry typecheck also fixes its unused
React import and boolean readiness predicate, and loads the actual application
augmentation types with ES2022 library support for its existing `Array.at` use.

Spec self-review: both reported blockers covered; current/history and differing
object/source/hash/session/generation cannot share evidence; model and read
completion order covered; original 46 boundary checks retained. Native renderer
pixels, persistence and performance require the coordinating thread's rerun.

## Verification history

Commands below were run in `/tmp/project-mind-review-observer-progressive`.
The runtime is the supplied Node **24.21.0**. Every test/typecheck and dependency
copy was serialized with the supplied lock; no npm install, GUI, cargo, Office
build, subagent or chat messaging was used.

```sh
LOCK=/Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py
NODE=/tmp/project-mind-review-combined/packages/agent-host/runtime/darwin-arm64/node

# Initial red: 0/1, missing progressive history model.
python3 "$LOCK" "$NODE" --test --test-name-pattern='progressive history' scripts/office-performance/native-working-observer.test.mjs

# After adding only file_office_view to the old map: 18/20.
# Red: late history overwrites working model; partial image throws for absent media.
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-working-observer.test.mjs scripts/office-performance/native-visual-proof.test.mjs

# Source-isolated model selection: 12/12.
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-working-observer.test.mjs

# Read-join regressions: 1/6 before read support, then 18/18 with working tests.
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-progressive-observer.test.mjs
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-progressive-observer.test.mjs scripts/office-performance/native-working-observer.test.mjs

# Visual helper and browser parity: 8/8 before the additional joined visual test.
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-visual-proof.test.mjs

# Original 46 plus progressive and visual cases: 63/63 at this intermediate scope.
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-acceptance-flow.test.mjs scripts/office-performance/native-history.test.mjs scripts/office-performance/native-races.test.mjs scripts/office-performance/native-visibility.test.mjs scripts/office-performance/native-working-observer.test.mjs scripts/office-performance/native-progressive-observer.test.mjs scripts/office-performance/native-visual-proof.test.mjs

# Final entry/application typecheck and complete native observer boundary scope.
python3 "$LOCK" "$NODE" node_modules/typescript/bin/tsc --project scripts/office-performance/tsconfig.json --noEmit
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-*.test.mjs
git diff --check
```

The first complete boundary attempt passed 93 checks but failed to load the PPTX
suite because the fresh worktree lacked its existing engine artifact. The first
entry typecheck also exposed missing dist declarations, the pre-existing entry
issues noted above and an omitted application augmentation. Dependencies were
then prepared under the lock, copying existing `dist` directories for
`office-docx`, `office-xlsx`, `office-pptx` and `office-html2docx` from combined
with `cp -cR`; no builds were launched. Root `node_modules` and XLSX
`node_modules` are read-only shared via symlinks. All prepared artifacts are
ignored local dependencies, not committed product changes.

Final results: entry/application typecheck passed with no diagnostics; complete
native observer suite **102 passed, 0 failed, 0 skipped** (Node-reported duration
1176.291333 ms). This includes the original 46 checks, existing canvas/PPTX
coverage, and the progressive regressions. `git diff --check` passed. These results
cover the final code in this commit; only this report/README changed afterward.
Standards and Spec self-review each have **0 remaining findings**.

The reused PPTX engine artifact SHA-256 was
`9ce953d1c2ef5cd439aa2ea3e6bdacaf00e013cb56bde3f31796e9e1434f3c7a`.
Its byte-level tests use the existing engine in memory; they launch no renderer
window or native application. No Vite/native rebuild or real Office run was
performed by this package.

## Limits and handoff

The referenced failures are the original a263 `ca188a7` reports at
`output/playwright/office-native-round3`: DOCX history content timeout and XLSX
missing inspected-media exception. PPTX had no readiness error there. These
reports were read, not modified or regenerated.

This work establishes observer boundary behavior and type compatibility, not
real native acceptance, timings, release/p95 or platform results. Main must
review/integrate this local commit and arrange Office native reruns. The ongoing
combined File flow window acceptance was not repeated. No push, merge or Issue
closure is performed by this work package.

## Follow-up review package (base 214a378)

Issue #307/G12; dependency and verification scope remain the same. Deliver the
Rust `FileOfficeSaved` full-shape regression (including `commit.receipt`) and
support the legal Workspace File scope alongside Project scope. Non-goals:
changing the native save contract or product implementation, adding a TS-only
fallback, GUI/cargo or duplicating main's acceptance. Acceptance: first reproduce
Workspace scope rejection, then pass the focused cases, all 102 prior checks
plus additions, and the existing entry/application typecheck under the same lock.

Contract correction: Rust `FileOfficeSaved` (`src-tauri/src/file_office.rs:116`)
contains `object`, `versionNumber`, `contentHash`, `model`, and `commit`. Its
constructor copies the top-level version/hash from `commit.receipt`; the receipt
also contains `documentId` and `noChange` (`db/file_versions.rs:309`). The TS
`OfficeSaveResult<Model>` describes a narrower shape, not the absence of these
native fields. The legacy tests now use that complete Rust shape and assert the
original returned response/model/receipt identities. Top-level source extraction
is retained; this review does not establish a native save implementation bug or
introduce a receipt-only fallback/extra commit gate.

Workspace File is an existing legal scope in both `AgentScope` and native
`file_office::gui_request` (the `Scope::Workspace` grant). The observer accepts it
alongside Project File; its existing full object key already separates their
scope kinds. New boundary cases exercise fixed-version reads, working-session
reads, and native saves without conflating identical numeric IDs across scopes.
The native measurement UI itself remains the existing ProjectFileContent shell;
these tests are scope-boundary coverage, not a new Workspace GUI acceptance run.

Follow-up verification (same cwd, Node 24.21.0 and lock paths as above):

```sh
python3 "$LOCK" "$NODE" --test --test-name-pattern='legacy|Workspace' scripts/office-performance/native-working-observer.test.mjs scripts/office-performance/native-progressive-observer.test.mjs
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-*.test.mjs
python3 "$LOCK" "$NODE" node_modules/typescript/bin/tsc --project scripts/office-performance/tsconfig.json --noEmit
git diff --check
```

The focused command first returned **2 passed, 2 failed**: both complete-shape
legacy tests passed unchanged, while both new Workspace cases failed to admit
their native model. After the single scope-predicate change, the same command
passed **4/4**. Complete suite: **104 passed, 0 failed, 0 skipped** (1219.785417 ms);
entry/application tsc passed without diagnostics; diff check passed. Existing
dependencies/artifacts were reused. No product changes, GUI, cargo or extra native
IO. Standards/Spec self-review: **0 remaining findings** in this narrow delta;
main still owns integration and real native acceptance.

## Round4 XLSX navigation follow-up (base 96239b5)

Issue #307/G12; Office #303 native acceptance dependency. Deliver only the removal
of the obsolete first-viewport prerequisite after worksheet navigation. Keep
`sheetNavigationPaint`, initial `ready()` / `sheetState`, source correlation,
pixel/content thresholds and all product code unchanged. Verify the actual
navigation orchestration with offscreen A1 / visible B3, missing B3 composition,
and strict initial readiness, then run all native boundary tests and entry tsc.
No GUI/cargo, other worktree edits, subagent, publication or native result claim.

### Exact reported failure

Read-only evidence is the nested report (the initially supplied path omitted
the `xlsx/` directory):

`/Users/xuchen/.codex/worktrees/a263/project_mind/output/playwright/office-native-round4/xlsx/xlsx-large-1.json`

Report SHA-256:
`1f6debfbc8f145f77e68a70bdb38405687e0e56b3ebecef99fd8b95132fac7b0`.
Round4 `build.json` records source head
`8a09a09568f306e9194f59ae9e41f3b480134a43`, plus its explicit docs/test dirty list,
and binary SHA-256
`2644f22f6773a0b8922a877dd8eb3c0a293e114817f37ad7520af3095efe608e`.
Qualification: macOS arm64 embedded-debug with optimized frontend, **not release**.

`acceptance_navigation_zoom_and_mode` failed after **45006 ms**. Its captured
error diagnostic identifies stage `navigated native sheet content and canvas
witness`, with reason `renderer canvas has not painted native text witness`
and A1 text `未编辑工作表：请保留中文`. The selected range is B3 on sheet-2 `说明`.
The operation selected B3, scrolled to row 2 / column 1 without frozen panes and
zoomed, but then awaited the first viewport's A1 paint before reaching the
existing selected-cell positional proof. This is the blocking observer gate;
it is not proof that the native selected-cell validation has passed.

The report has **6/7 functional acceptance records passed**: reset navigation,
mutation/autosave, close/native readback, explicit archive, reopen/verify and
history/stale CAS. Its `cold_open` is **1701 ms**, explicitly `over_budget`.
Office's status reports DOCX and PPTX at 7/7 functional acceptance, with their
cold opens also above 1000 ms. Neither this fix nor the boundary tests closes
release/p95, performance or the unavailable Windows acceptance requirement.

### Change and regression boundaries

The only entry logic change deletes `await until(() => !!sheetState(model,
target.getSheetId()), ...)` in `navigateAndZoom`. The existing following
`sheetNavigationPaint(model)` gate still verifies the selected source cell,
facade value/formula, number format, zoom/scroll/freeze-adjusted screen position,
canvas ownership and complete cache-to-main composition. Initial first-screen
checks remain byte-for-byte unchanged, including final stable-paint rechecks.

`native-canvas-proof.test.mjs` now extracts the actual `navigateAndZoom`, `until`,
`sheetState` and `ready` functions alongside its existing actual composition
helpers. The fixture supplies facade state and deterministic clock/drawing
boundaries; it does not replace these validation functions with passing mocks.
The positive case selects and scrolls B3, changes zoom to 110%, and proves native
30 formatted as `30.00` at the computed B3 screen box, with A1 absent. The negative
case has B3 text only in the cache and must fail at the selected-cell composition
gate. The initial-ready case has valid B3 composition but still fails on the
missing A1 first-viewport witness. Existing wrong-text/wrong-position, cleared
canvas, wrong facade/source/owner and clipping cases continue to apply.

Canvas calls are boundary doubles, not browser rasterization or Mac WebView
evidence. Timer advancement avoids waiting 45 seconds without changing the
entry's timeout budget. Fonts/layout settling is a boundary double in the
navigation case; no new native rendering or persistence claim is made.

Commands from `/tmp/project-mind-review-observer-progressive`, using the same
shared lock and Node 24.21.0 as the earlier package:

```sh
LOCK=/Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py
NODE=/tmp/project-mind-review-combined/packages/agent-host/runtime/darwin-arm64/node
python3 "$LOCK" "$NODE" --test --test-name-pattern='actual navigateAndZoom|actual initial ready' scripts/office-performance/native-canvas-proof.test.mjs
python3 "$LOCK" "$NODE" --test scripts/office-performance/native-*.test.mjs
python3 "$LOCK" "$NODE" node_modules/typescript/bin/tsc --project scripts/office-performance/tsconfig.json --noEmit
git diff --check
```

RED: **1 passed / 2 failed**. The positive navigation and precise missing-B3
failure-stage assertions both hit the obsolete A1 gate; the strict initial-ready
negative passed. GREEN: the same focused command passed **3/3**. Complete native
suite: **107 passed, 0 failed, 0 skipped** (1322.342166 ms). Observer entry/application
tsc passed without diagnostics; `git diff --check` passed. Full test/typecheck logs
are retained locally in `scripts/office-performance/output/navigation-round4/`.
No dependencies were installed or rebuilt; existing local/shared artifacts were
reused under the lock.

Standards self-review: **0 remaining findings**. Only the observer entry, its
existing canvas-proof regression file and this record changed. Actual gates are
extracted rather than duplicated. Spec self-review: **0 remaining findings** in
the delta; source comparison confirms `sheetState` / `ready` and
`sheetNavigationPaint` are unchanged. The runtime delta removes one postnavigation
wait and adds its rationale; no product code, thresholds, native IO, response
objects, visibility behavior or original first-screen checks changed.

Main must review/integrate the fixed commit, then arrange Office's rebuilt
measurement entry and affected **XLSX-only Mac rerun**. This package does not send
other-chat messages or repeat main's File flow acceptance. Preserve round4 as
failed navigation evidence and keep native navigation/mode acceptance open until
the rerun passes. Performance/release/p95 and Windows platform acceptance remain
open independently; no GUI/cargo, native run, push, merge or Issue closure here.
