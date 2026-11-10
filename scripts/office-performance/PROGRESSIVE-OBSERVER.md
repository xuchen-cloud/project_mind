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
