# XLSX progressive GUI view — Issue #303 / G04 / G09

## Work package

- Scope: `packages/office-xlsx/**`; shared host, worker, `src-tauri` and performance harness belong to the main agent. No commit or branch changes.
- Dependencies: native owner retains `createViewSession`; GUI supplies `EditorProps.onReadView`; original immutable bytes remain the save baseline.
- Delivery: editable first viewport, persistent native range reads, bounded renderer caching, cached initial formula results followed by complete dependency closure/native recalculation.
- Non-goals: changing CAS/receipts, replacing complete authoring inspection, Windows acceptance, or claiming measured first-paint improvement.
- Acceptance: unopened tail/other sheets absent from initial cell JSON; range readiness independent of whole-sheet completion; two cumulative saves preserve both edits and unopened OOXML/media/relationships; source hash and native owner remain stable across scrolling.
- Verification: serial Node tests, package build/typecheck, real release sidecar integration. No watch or GUI starts. All builds/Cargo use the shared build lock and `CARGO_INCREMENTAL=0` for Cargo.

## Contract

```ts
createViewSession(bytes, context?): Promise<{
  model: Model
  read(request: OfficeViewRead): Promise<unknown>
  close(): Promise<void>
}>
inspectView(bytes, context?): Promise<Model> // short-lived session, then close
```

`OfficeViewRead` is the discriminated union in `types.ts`: range/sheet+Area, formulas/sheet, outline/sheet, media/visualId, or pivot/declared part path. Results use the existing upstream DTOs. Range replies additionally retain `area` and distinguish `rangeReady`, `metadataReady`, and `indexingComplete`. The iframe validates these replies before applying upstream grid mutations.

Initial coverage is `{kind:'partial', sourceHash: SHA256}`. Only the active sheet's A1:Z100 data is in `ranges`; all sheet metadata/styles remain available, while formula inventories, outlines, media payloads and pivot definitions are initially empty. The source bytes are copied before any await. The renderer gets a content identity, never a native session ID or path.

Native `open_view` preserves the ZIP path/count gate and uses the existing zero counting-budget path for trusted dimensions, without changing complete `open` counting behavior. The engine additionally runs the existing metered full ZIP inflation gate once before opening the GUI session. Untrusted dimensions still use existing extent scanning and the two-million-cell used-area limit remains.

Before an editable range returns, a metadata-only worksheet pass skips `sheetData` and publishes the tail's merges, hyperlinks, protection, validation, conditional rules, filters and print metadata. The ordinary cell index then publishes row chunks asynchronously. The range waits only for its required row, never for `indexingComplete`. This metadata pass still reads/decompresses the worksheet; it does not construct its cell/formula index. Shared strings and other native metadata scans also remain part of initial open. This is an explicit remaining lower bound, not constant-time opening.

## Renderer and saving

`onReadView` crosses the existing epoch-bound MessagePort. Range requests reuse the retained native sidecar/index; an eight-range LRU coalesces identical reads. Formula/outline inventories are not cached while they evolve. Complete external import snapshots use a single row index, avoiding a full cells/rows filter on every viewport. Explicit global find reads bounded native chunks as needed, rather than treating missing model ranges as empty.

GUI formula mode starts with cached results. The existing complete dependency-closure loader remains, while the formula stream hold forbids local calculation, including forced Calculate Now, until the closure is active or a full explicit load is complete. Existing native recalculation handles complete-source fallback. Flush does not force calculation over the partial grid, and partial captures omit renderer formula caches so candidate generation recalculates against the full source. Unloaded content never becomes an implicit deletion.

The original gateway journal stays cumulative across receipts. Save continues to use original package bytes plus all current edits. No source/model/cache rebasing is performed after a receipt. Snapshot pruning that assumes a full opening cell baseline is skipped for partial views. Native close releases its index directory before stopping the sidecar and removing the private source directory.

## Source provenance

Vendor renderer files are unchanged. `scripts/progressive-adapter.mjs` uses checked fixed-source transformations through the existing build adapter. Modified native sources are reproducible original-blob patches in `patches.json`; `scripts/source.mjs` verifies their SHA256. The four native patches were also reversed locally and their reconstructed originals matched the pinned upstream Git blob SHA1, verifying the original-to-patched provenance. Existing 50%–150% transformations in `build-renderer.mjs` and `patch-univer.mjs` remain.

## Evidence and limits (2026-11-10)

- Actual pre-change engine: `XLSX_RED_BASELINE=1 ... --test-name-pattern='first view excludes' tests/progressive.test.mjs` fails because complete `inspect` serializes unvisited tail cells. The same test passes with `inspectView`.
- Initial missing-session API regression was also observed as two failing tests against the old engine.
- `tests/view-source.test.mjs` + `tests/renderer-host-deferred-actions.test.mjs`: 9 passing deterministic tests. Covers one-time row indexing, LRU/coalescing, evolving inventories/failures, source transforms and existing deferred save/output behavior.
- `tests/engine.test.mjs` + `tests/parity.test.mjs` + `tests/initial-calculation.test.mjs` + `tests/steady-scheduling.test.mjs`: 34 passing checks on the first rebuilt engine/sidecar. Complete inspection, repeated native saves, preservation, structural formula changes and existing lifecycle behavior remain compatible.
- Real progressive session, cumulative save/reopen, declared pivot/cache/media, and cached-first formula/native computation tests passed individually. One save test first failed because its fixture used gateway `cell` instead of the actual `value` field; correcting the fixture produced a pass without weakening assertions.
- First-viewport formula is cached as 20007 while its tail and other-sheet precedents are absent from the initial model; complete-source native recalculation after editing both precedents returns 30009. A subsequent view read still returns its fixed-source cache of 20007.
- Full package build (`scripts/build.mjs --skip-native`) and package TypeScript (`tsc --noEmit -p packages/office-xlsx/tsconfig.json`) passed under the build lock. The real release-native 100,000-row test passed 1/1, including first-range `indexingComplete:false` with protection, merges and validation already present. Final engine/parity/progressive checks passed 24/24 on the final engine, and the non-GUI renderer manifest/resource check passed 1/1. The forced-calculation gate was then strengthened and its new deterministic test passed; the final full package rebuild for that adapter change passed under the shared build lock; the distribution is ready for staging.

GUI/coverage-aware first-editable witness, File working two-save acceptance and actual zoom interactions belong to the main agent's concentrated integration run. This package ran no browser/GUI acceptance and does not equate native engine saves with File working saves. No Windows machine is available; no Windows result or performance gain is claimed. File-level CAS/receipts remain owned and verified by the shared host.

## Reproducible commands and result reuse

All commands run from the shared worktree root. `LOCK` below denotes
`python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py`.
Node test commands all use `--test-concurrency=1`; no browser test was run.

```sh
LOCK env CARGO_INCREMENTAL=0 node packages/office-xlsx/scripts/build-native.mjs
LOCK node packages/office-xlsx/scripts/build.mjs --skip-native
LOCK node packages/office-xlsx/node_modules/typescript/bin/tsc --noEmit -p packages/office-xlsx/tsconfig.json
LOCK env CARGO_INCREMENTAL=0 cargo test --locked --release --manifest-path packages/office-xlsx/native/engine/Cargo.toml --config packages/office-xlsx/native/engine/.cargo/config.toml --target-dir packages/office-xlsx/native/target --test progressive -- --test-threads=1
node --test --test-concurrency=1 packages/office-xlsx/tests/progressive.test.mjs packages/office-xlsx/tests/engine.test.mjs packages/office-xlsx/tests/parity.test.mjs
node --test --test-concurrency=1 packages/office-xlsx/tests/view-source.test.mjs packages/office-xlsx/tests/renderer-host-deferred-actions.test.mjs
node --test --test-concurrency=1 packages/office-xlsx/tests/initial-calculation.test.mjs packages/office-xlsx/tests/steady-scheduling.test.mjs
node --test --test-concurrency=1 --test-name-pattern='external renderer manifest' packages/office-xlsx/tests/renderer-resources.test.mjs
node packages/office-xlsx/scripts/source.mjs
git diff --check -- packages/office-xlsx
```

Effective unique check count: 50 (49 Node checks and one native integration test), including reused unchanged lifecycle checks. Commands were not all rerun together: final engine close/range changes caused the affected engine/parity/progressive group to be rerun; the later renderer-only forced-calculation change caused its new test and renderer build to run. Earlier unchanged passing checks remain valid. No commit hash is claimed: this shared worktree intentionally remains uncommitted.

## File inventory

- API/engine: `types.ts`, `engine.ts`, `sidecar.ts`, `browser.ts`, `browser.d.mts`, `frame-browser.ts`.
- View/renderer: `renderer-host.ts`, `renderer-view.ts`, `view-source.ts`, `view-protocol.ts`.
- Reproducible build/source: `scripts/progressive-adapter.mjs`, `scripts/build-renderer.mjs`, `patches.json`, `tsconfig.json`; existing `scripts/patch-univer.mjs` zoom changes preserved.
- Native: `native/engine/src/{lib,protocol,types,worksheet}.rs`, `native/engine/tests/progressive.rs`.
- Tests: `tests/progressive.test.mjs`, `tests/view-source.test.mjs`, `tests/renderer-host-deferred-actions.test.mjs`.
- Documentation: `README.md`, this file. `dist` and test scratch outputs are ignored generated artifacts.
