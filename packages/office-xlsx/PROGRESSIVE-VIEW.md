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

## Real browser acceptance follow-up (2026-11-10)

This follow-up supersedes the earlier statement that this package ran no browser acceptance. The bounded harness is `tests/browser-progressive.mjs`, with `tests/progressive-browser-host.mjs` and `tests/progressive-browser-server.mjs`. It mounts the actual built renderer, routes `onReadView` to one persistent real native `createViewSession`, and saves immutable session baseline bytes plus the cumulative gateway journal through the actual engine. It does not use the full-inspection performance harness or an alternative renderer/calculator.

The fixture retains the complex workbook's chart, image, styles and hidden sheet, adds 20,000 source rows and tail/cross-sheet formula precedents, and declares ten rows on a second sheet whose indexed cell content ends at row three. The initial model is partial A1:Z100. A visible source-chart SVG text label and the adjacent grid witness are captured in screenshots; the actual grid cell is also checked. This paint witness is not a measured performance improvement.

Preserved diagnostic evidence under `tests/output/`:

- `browser-progressive-formula-red.log` and `progressive-formula-red/`: a preserved old renderer actually evaluates a newly typed `=A10000+1` as 1 rather than 8 while the tail precedent is absent. This is a functional red, not a missing-module failure.
- `progressive-style-diagnostic/` and `progressive-style-old/`: scalar keyboard input carried unchanged resolved Calibri/black font fields into the journal, replacing inherited theme color with RGB and adding fonts/XFs. The same fixture and edits reproduce byte-identical style changes on the preserved older renderer; the defect predates the formula-closure fixes. The strict unchanged-part assertion was retained.
- `browser-progressive-style-final2.log` and `progressive-style-final2/results.json`: 2/2 passed on Chrome 157.0.8103.39 and WebKit 27.2. Scalar-only saves preserve `styles.xml` byte for byte. An explicit toolbar bold change remains in the journal, native candidate and actual reopened renderer. Numeric editing is checked using raw cell data, numeric gateway values, numeric saved OOXML and a SUM reference; the formatted cell-view value `40.00` is not treated as the raw scalar type.
- `progressive-browser-final/`: the actual command trace shows `{}` streamed writes causing the formula observer to clear `f`, despite retaining a cached result. A separate style-only journal replay could also clear a formula. The subsequent sparse-write/style-replay fix is exercised with explicit formula-text assertions after viewport eviction and with a constant edit that forces recalculation.
- `browser-progressive-sparse-final3.log` and `progressive-browser-sparse-final3/`: both browsers pass the strict scalar preservation, two cumulative saves and actual close/reopen, new-tail result 8, explicit formula bold and eviction, journal-only dependency retention/recalculation, and held-native-range pin race result 18. Both then fail before typing the second-sheet C7 formula: actual C7 selection is correct, B500=7 is present, but F2 is canceled with the streaming-area message. Source dimensions are ten rows, the actual grid has 1,000 rows, and completed native coverage ends at row three. This is a product known-blank edit-guard defect, not a navigation or numeric assertion failure. These runs are not whole-suite passes; the outside-extent formula, additional formula save/reopen and final zoom gates remain pending in this checkpoint.

The sparse renderer build is recorded in `tests/output/browser-progressive-build-sparse-state.json` and `browser-progressive-build-sparse.log`. The queued build began with the sparse-write source delta uncommitted, and completed after the identical source was committed as `ac51aa394140c0e45c9a1ddf054fba27ebbef9fd`; pre/post source hashes match. Its compiled `renderer.html` SHA256 is `0c6dedc657c7851504d27dc26770e9cf378bcc71e912c7bb7bb44113a83914a7`. Each run records actual compiled hashes separately from source hashes read at test start.

Browser saves in this harness prove engine baseline-plus-journal behavior, not Tauri IPC, File working/CAS or native GUI acceptance. Synthetic Ctrl-wheel input exercises the actual browser handler but does not prove a physical trackpad gesture. Windows remains unavailable. No Windows, native IPC or performance-improvement result is claimed here.

### Preview layout diagnosis and bounded verification

After the known-blank coverage fix, `browser-progressive-blank-final.log` reaches every functional formula/save/zoom assertion in both browsers, then fails the strict zero-console-error assertion (Chrome two messages, WebKit three). The isolated `XLSX_LAYOUT_DIAGNOSTIC=1` mode reuses `progressive-browser-blank-final/chromium-formula-saved.xlsx`, imports the actual bundled DocumentSkeleton, and observes its existing `calculate` call without changing its inputs or result. The current renderer and preserved old renderer each reproduce 34 messages in this short preview/slider sequence (`progressive-layout-current/`, `progressive-layout-old/`). Every failing document is `__INTERNAL_EDITOR__DOCS_FORMULA_BAR`, with `pageSize.width:0` while its formula-bar DOM has `display:none` and a zero-width box. Thus this preview defect also predates the formula-closure fixes.

The bundled stack maps to `@univerjs/docs-ui`'s `src/views/rich-text-editor/hooks/use-resize.ts`: the multiline editor writes measured width directly into its document page size. `@univerjs/engine-render`'s `_lineOperator` then reports a nonpositive column width. The sheets-specific formula resize path already rejects zero-size positions; the generic rich-text resize path still runs. Main's CSS fix keeps formula-bar width measurable while collapsing its height and hiding interaction.

`browser-progressive-layout-fixed2.log` passes 1/1 Chrome diagnostic in 1.53 seconds: formula-document width 1199.15625, hidden bar 1440×0, pointer events disabled, actual grid and 204×24 status controls present, and no console/page/network errors. The preceding fixed diagnostic had zero errors and positive width but sampled height 21.78125 during the actual `univer-transition-[height]` transition; waiting for its zero-height endpoint resolves that geometry assertion without changing the product or relaxing the oracle.

`browser-progressive-build-layout-state.json` records the successful rebuild of `ca188a7` plus the CSS delta, subsequently committed with identical recorded source hashes as `ecc73650ea42ebd646fca42fbe61f970f4fea3fd`. The compiled `renderer.html` remains `ffbbb88ca4e1cfb6740685df095fa5286fe42bb363b80f7e86945f7978c15102`; the CSS change is in `renderer/host.css`, SHA256 `200f75ef7e0fb66fe283611eac920ff42336c1a5097125faf485f3be4f24bef5`. Actual run provenance includes this CSS asset separately.

## Final real browser acceptance (2026-11-11)

This final result supersedes the pending browser gates in the earlier checkpoints above. No further optional tests were run after this pass.

### Result and provenance

- **Chrome and WebKit: 2/2 full browser cases passed.** The same serial Node invocation also passes one publication/cleanup regression check: **3/3 Node checks**, zero failures, 60.154 seconds total. Browser cases took 31.308 and 28.598 seconds respectively.
- Chrome 157.0.8103.39, WebKit 27.2, pinned Node v24.21.0; headless only. Both cases have zero page errors, console errors, failed HTTP responses and native-host failures, including disposal. `results.json` contains two explicit `status:"passed"` entries, published only after every integrity assertion and successful browser/native-reader cleanup. The publication check independently injects integrity, browser-close and native-close failures and verifies that none can publish a successful entry.
- Actual package build: `8a09a09568f306e9194f59ae9e41f3b480134a43`. `tests/output/browser-progressive-build-calculation-state.json` records all build-input hashes, unchanged before/after the successful build. This is the calculation-projection fix, including `scripts/patch-univer.mjs` and the new `scripts/calculation-projection-adapter.mjs`. Earlier 13/14-check source snapshots are not the final bundle.
- Main's latest affected source suite is **15/15**, plus package TypeScript, recorded in `/tmp/mind-office-calculation-projection-validation.log`, with Standards/Spec both zero findings. Fifteen replaces the earlier affected-suite counts; these counts are not added together.
- Actual compiled SHA256: `renderer.html` = `73da857d6f61e252e6c5a1f88ad460a49fcee9ca74214a59710a3b9cc9b5ebcb`; `renderer/host.css` = `200f75ef7e0fb66fe283611eac920ff42336c1a5097125faf485f3be4f24bef5`; engine = `370e3ba5072ffe61f2c542d20f5e55d8733fe750c9e3dcc78f92dcf2a6eff2ed`. The complete per-input/compiled/harness hashes are in `tests/output/progressive-browser-complete/provenance.json`.
- Tested harness hashes: `browser-progressive.mjs` = `63997b4d35f6a96e20fe962f6ea90b2f345e98a2e505d9a15615cda842226f81`; `progressive-browser-server.mjs` = `1519aa368774c536c529195d792587c4d34adef842adec7fda0a62e63f2dfe69`; `progressive-browser-host.mjs` = `44af0aa076d55c7aa846f64ac8f6fe0249101b7b4fd459991750a284b39c6978`.

### Verified behavior

- The real renderer visibly paints the grid's `XLSX303` witness, source chart and image from a 160,443-byte/20,000-row workbook. Initial model coverage is partial A1:Z100. A real keyboard edit succeeds while A19000 is absent from both the resident matrix and all requested native ranges. In this bounded fixture, the native index is already complete by the first range reply; this proves partial renderer residency and early editing, not editing before native indexing completes.
- Two cumulative scalar saves retain B3=40 and D3=60 from the immutable session baseline. Raw values, journal values and saved OOXML are numeric; native/reopened SUM is 60. Formula caches progress 20037 → 20067 → 20107. A separate complete-source native recalculation with tail/cross-sheet edits returns 30109 without changing fixed-source view caches. Only worksheet1/worksheet2 change in these two scalar saves; **15 other ZIP parts, including `styles.xml`, media and the unopened witness, remain byte identical**. Real native close/reopen preserves both edits and formula results.
- A new manual `=A10000+1` resolves to 8 with formula text retained and without publishing the old erroneous 1. Explicit formula bold survives viewport replay. A source-blank journal-only B5000 value survives dependency pinning/eviction; changing 7 → 9 updates its retained dependent formula 8 → 10. Holding the real A12000 reply while earlier pins face viewport eviction still produces 18.
- On `说明`, native EOF progress remains row index2 while acknowledged blank coverage extends through requested row9. Actual C7 UI input is permitted within the declared ten-row sheet. A new B500 journal value expands formula input beyond original dimensions; `=B500+1` retains `f` after departure/reentry and recalculates 8 → 10 after B500 changes to9.
- The final readonly oracle creates unsaved D8=23 with explicit bold and a new C7 formula `=B5000+A14000+1`. It holds the actual A14000 native dependency reply, enters preview, requests a previously unvisited viewport near row16000, proves D8 has actually left the resident matrix, then reenters the first viewport and verifies D8 value/bold and the unsaved formula replay. It releases the dependency while still readonly: closure becomes active, actual formula-observer/result mutations execute and C7 becomes **14008**. Content/style/structure/protection journal entries remain identical throughout; no permission modal or errors appear. Returning to edit retains the formula/result. Both full browsers pass this oracle.
- One **additional formula save**, separate from the original two scalar saves, then saves/reopens C7 formulas/results 18 and10 on the two sheets, explicit formula bold, and readonly-replayed D8=23/bold. Total native opens are three; scrolling/view changes reuse the current retained owner and immutable source hash within each session.
- Real 50–150% slider/buttons, disabled endpoints, five invalid numeric entries, valid125%, presets50/75/100/150, fit-to-selection (50%), Cmd+= steps, Ctrl-wheel line steps, fractional Ctrl-wheel zoom, bounds, preview restore and 560×520 controls all pass. Preview's formula bar is hidden/noninteractive at1440×0 while retaining measurable width. Every zoom shortcut and the whole zoom sequence preserve all journal fields except the existing persisted `pageSetup.zoomScale` view preference.
- The isolated WebKit case additionally attempts ordinary UI F2 after the clean preview gates. `set-cell-edit-visible` returns false, cell editing stays false and content journal remains unchanged. Any permission dialog caused by this deliberately rejected edit is left intact until disposal; it is not dismissed to make another assertion pass.

Single-run instrumented observations, not performance comparisons:

| Browser | Visible source witness | Editor ready | First edit confirmed from navigation | Keyboard edit response | Initial native open |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chrome | 718 ms | 672 ms | 950 ms | 161 ms | 37.3 ms |
| WebKit | 863 ms | 799 ms | 1069 ms | 148 ms | 21.4 ms |

### Reproduction and retained artifacts

Run from the shared worktree root. No visible browser windows or watchers are started. All actual build/browser work below used the shared lock and pinned Node24.

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py /Users/xuchen/project_mind/src-tauri/resources/agent-host/node packages/office-xlsx/scripts/build.mjs --skip-native

python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py env XLSX_REQUIRE_STYLES_UNCHANGED=1 XLSX_ACCEPTANCE_OUTPUT=output/progressive-browser-complete/ OFFICE_BROWSERS=chromium,webkit OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs OFFICE_WEBKIT_EXECUTABLE=/Users/xuchen/Library/Caches/ms-playwright/webkit-2336/pw_run.sh /Users/xuchen/project_mind/src-tauri/resources/agent-host/node --test --test-concurrency=1 packages/office-xlsx/tests/browser-progressive.mjs

python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py env XLSX_READONLY_JOURNAL_ONLY=1 XLSX_ACCEPTANCE_FIXTURE=packages/office-xlsx/tests/output/progressive-browser-blank-final/chromium-formula-saved.xlsx XLSX_ACCEPTANCE_OUTPUT=output/progressive-readonly-calculation/ OFFICE_BROWSERS=webkit OFFICE_WEBKIT_EXECUTABLE=/Users/xuchen/Library/Caches/ms-playwright/webkit-2336/pw_run.sh OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs /Users/xuchen/project_mind/src-tauri/resources/agent-host/node --test --test-concurrency=1 packages/office-xlsx/tests/browser-progressive.mjs
```

The last command intentionally reuses the retained saved workbook artifact; the full command creates its own fixture and does not depend on earlier outputs.

- Build stdout/stderr: `tests/output/browser-progressive-build-calculation.log`; build provenance: `browser-progressive-build-calculation-state.json`.
- Full log: `tests/output/browser-progressive-complete.log`; results/provenance/actual read logs and native saved XLSX files: `tests/output/progressive-browser-complete/`.
- Visually inspected screenshots: both `*-first-viewport.png`, `chromium-readonly-journal.png` (visible14008 and bold23 in preview) and `webkit-narrow.png` (visible slider and result10, no modal). Each browser also retains saved-view, new-formula, dependency and readonly screenshots/JSON.
- Isolated strong readonly result: `tests/output/browser-progressive-readonly-calculation.log`, 2/2 checks including the publication test, WebKit8.672 seconds; detailed blocked-edit and observer/read evidence in `tests/output/progressive-readonly-calculation/`.
- Retained genuine readonly reds: `progressive-layout-webkit5/` shows trusted viewport `set-range-values` edit commands rejected while readonly; `progressive-readonly-final2/` shows the later calculation-start mutation canceled after a held dependency completes, with formula retained but no value. The final scoped source/journal/calculation projection fixes turn both cases green. `progressive-readonly-final/` is separately labeled setup failure: Enter moved selection to D9 before a bold click; the corrected oracle reselects and verifies actual D8 journal/style before entering preview.

Final inventory additions: the three browser harness files; source build inputs `scripts/patch-univer.mjs`, `scripts/calculation-projection-adapter.mjs`, `scripts/progressive-adapter.mjs`, `streamed-cell-writes.ts`, `formula-closure-edits.ts`, `input-style-journal.ts`, `cell-comparison.ts` and `view-source.ts`. Product changes were owned by main; this acceptance worker changed only its harness files and appended this evidence, with no commit.

### Remaining acceptance boundaries

Windows is unavailable and remains a blocker for that platform. This browser acceptance does not certify Tauri IPC, File working/CAS/history or the separate native GUI/observer batch. Those remain main-owned evidence. The synthetic wheel test is not a physical trackpad test; timings are one instrumented fixture run and establish no performance improvement. The complete-source recalculation check does not claim exhaustive unsupported-formula fallback coverage. Historical negative logs are retained rather than relabeled as final passes.

### Coordinator native status and final review handoff

Main reports Round4 native validation on exact source `8a09a09568f306e9194f59ae9e41f3b480134a43`, binary SHA prefix `2644f22`: DOCX and PPTX each pass 7/7 functional checks; XLSX passes 6/7. The remaining XLSX navigation check is an observer mismatch confirmed by Spec: `native-page` line1108 selects B3 and scrolls to row2/column1, but `sheetState` line1113 then requires offscreen A1's first string before the existing selected-cell composition gate. Native content and calculation-cycle checks pass; composition values123.456/30 exist, but the exact B3 position/mode continuity gate was not reached. G12 owns that observer follow-up; this worker made no shared observer edits. All three reported cold measurements exceed1000 ms. These coordinator results do not convert the remaining native check or timing target into passes.

The three new harness files at the exact hashes above and this evidence appendix are submitted for final bounded Standards/Spec review. The earlier `c48044` harness review snapshot is superseded and is not claimed as approval of this final snapshot. Only these three new harness files and the evidence append are this worker's changes; no commit was made.
