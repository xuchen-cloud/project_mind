# XLSX first-open lifecycle diagnosis

## Work package

Issue area: #118 / #191. Scope: XLSX renderer initialization only. Input evidence: the single `under-build-functional` complex probe and installed Univer 0.25.1 sources. Deliverable: exact scheduling/consumer chain and targeted scheduling tests. Non-goals: native harness changes, new browser measurements, reducing functionality or redefining host ready. Acceptance: distinguish the font guard, real content work and deferred feature construction; identify what must remain true before removing a delay. Verification: static source tracing and an isolated test of the actual installed controller.

## Existing probe evidence

All times below are iframe navigation-relative milliseconds from `scripts/office-performance/output/xlsx-after-under-build-functional-20261019/raw.json`. Concurrent release compilation makes this functional diagnosis unsuitable for performance comparisons.

| Event | Time |
| --- | ---: |
| font-load-start | 385.4 |
| font-load-loaded/end | 430.8 |
| runtime-attached / Ready | 499.9 |
| initial-content-loaded | 641.6 |
| Rendered | 968.1 |
| natural calculation start | 2112.9 |
| natural calculation end | 2116.1 |
| natural calculation result applied | 2134.9 |
| Steady | 3972.6 |
| host ready | 3988.9 |

The font guard settled as loaded in 45.4 ms; all four external Carlito URLs returned 200. The 3004.5 ms interval is Rendered → Steady. Optional local alias failures are recorded separately; they do not identify a broken external URL. `main-import-end` only measures completion of module evaluation; upstream `void bootstrap()` continues asynchronously, so it is not a font/bootstrap-complete signal.

## Original upstream chain at the diagnostic checkpoint

Paths in this section are relative to `packages/office-xlsx`.

1. `vendor/apps/sheets/src/renderer/main.tsx`: bootstrap awaits `loadCellFonts()` before React render. Its 3000 ms Promise.race is a font guard and remains intact.
2. `vendor/apps/sheets/src/renderer/App.tsx`: constructs the full preset set, loads the initial snapshot and installs runtime hooks. `create-univer.ts` registers all preset plugins, including drawings, formulas, validation and find/replace.
3. `node_modules/@univerjs/ui/lib/es/index.js`: `UniverUIPlugin.onStarting()` resolves `IUIController` → `DesktopUIController` → `SingleUnitUIController._bootstrapWorkbench()`.
4. `bootstrap$1()` renders `DesktopWorkbench`; its effect calls `onRendered(contentElement)`. `_bootstrapWorkbench()` then awaits lifecycle Ready and schedules a 300 ms callback.
5. That callback mounts/activates the current render engine, subscribes to focus/create/dispose changes, and sets lifecycle Rendered. Synchronous Rendered subscribers construct render modules, formula services, auto-height/editor controllers and drawing/image controllers.
6. Only after setting Rendered does it schedule `setTimeout(() => lifecycle.stage = Steady, STEADY_TIMEOUT)` with `STEADY_TIMEOUT = 3000`. The callback contains no cleanup, font, calculation, image, frame or layout checks.
7. `node_modules/@univerjs/core/lib/es/index.js`: `LifecycleService.stage` synchronously emits on its BehaviorSubject. `PluginService._pluginsRunLifecycle()` → `_runStage()` calls every registered plugin's `onSteady()`. This **starts deferred features**; it does not check that asynchronous content work has completed.
8. At that checkpoint, `renderer-host.ts`'s `finishReady()` waited for initial data and lifecycle Steady, captured the baseline/restored a draft and sent ready. It lacked an explicit natural-calculation-completed predicate, so the fixed delay provided incidental time for unrelated work to finish. The coordinated implementation below adds that predicate and replaces the UI timers while preserving all lifecycle hooks.

## What actually waits for Steady

| Consumer | Work initiated at Steady |
| --- | --- |
| `@univerjs/ui` | ShortcutPanelController |
| `@univerjs/sheets-ui` | FormatPainterController, AutoFillUIController, SheetPermissionInterceptorClipboardController |
| `@univerjs/sheets-formula-ui` | FormulaReorderController |
| `@univerjs/sheets-drawing-ui` | DrawingPopupMenuController, DrawingContextMenuController |
| `@univerjs/sheets-data-validation-ui` | DataValidationAutoFillController |
| `@univerjs/sheets-find-replace` | SheetsFindReplaceController |
| `@univerjs/sheets-ui/lib/es/facade.js` | Scroll and selection-event facade subscriptions (requires lifecycle > Rendered) |

Actual grid/selection render modules, auto-height, formula calculation services and image rendering initialize at Ready/Rendered. Drawing DOM scroll synchronization also listens for Rendered. Changing only the host predicate to Rendered would release the UI before the deferred feature set is initialized.

## Independent calculation delay and safety constraint

`vendor/apps/sheets/src/renderer/formula-stream-hold.ts` deliberately merges streamed mutations: `FORMULA_STREAM_HOLD_MS = 1000`, with a flush scheduled at hold + 20 ms. It prevents repeated dependency-tree rebuilds and incomplete cross-sheet results. The package's natural calculation in the recorded probe applied after Rendered. The full-recalc-after-stream path and chart-data flush on calculation end must be preserved; do not invoke extra calculation from the readiness probe.

This gave a concrete counterexample to a timer-only replacement: advancing Steady shortly after Rendered could let the then-current `finishReady()` send ready around the first second while natural results were still pending. It could also expose charts based on pre-calculation data. The original 3 s timer itself did not guarantee those results on slower/large workbooks either.

## Recommended minimal repair sequence

1. Keep the font guard and the full Steady feature set. Do not change host ready to Rendered.
2. Separate the UI scheduler from real content completion: replace deferred feature construction with a cancellable post-paint task in the pinned build adapter, so all original onSteady controllers and facade subscriptions actually initialize earlier. Preserve stage order, disposal cancellation and Rendered hook completion.
3. Before enabling that scheduling change, make the existing host gate explicitly observe the initial natural calculation/result-applied state for automatic formula-mode workbooks, while preserving manual mode and the streaming-workbook path. Wait for the existing work rather than forcing a new cycle. Include deferred wrap/layout and chart/image evidence in functional acceptance.
4. In the next authorized browser functional window verify complex plus affected no-formula/manual/rebase cases, formulas, image/chart content, wrap metrics, navigation, preview/edit and save/cancel. Only then rebuild the candidate dist for coordinated native/production comparisons.

At the initial diagnostic checkpoint, no scheduler change was enabled because the calculation counterexample prevented a timer-only repair. The coordinating agent subsequently approved and opened a functional window for the coordinated implementation below.

## Targeted test

```sh
src-tauri/resources/agent-host/node --test packages/office-xlsx/tests/steady-scheduling.test.mjs
```

Result: **3/3 passed**. The test evaluates the actual installed `SingleUnitUIController` class with deterministic timers and injected render/lifecycle dependencies. It verifies mount/activate → Rendered → unconditional 3000 ms Steady, cancellation before Rendered, and cancellation after Rendered. It does not launch a browser, validate physical paint or establish an optimized result.

## Coordinated implementation

- `scripts/initialization-adapter.mjs` and `post-paint.ts`: exact transforms of the pinned controller replace both the initial 300 ms mount timer and deferred 3000 ms feature timer with cancellable two-frame/task scheduling. The real engine mount/activate, every Rendered subscriber, stage ordering and all Steady hooks remain. Disposal while awaiting Ready, during either frame, or before the final task cannot mount or progress a disposed controller.
- `initial-calculation.ts` and `renderer-host.ts`: the original preload boundary arms a workbook-identity-specific gate. The existing full-batch flush records the actual previous session ID immediately before issuing its original calculation command; an earlier partial result while that batch is queued cannot satisfy ready. The new session must be started, completed, not stopped and resultApplied. No-formula/streaming mode and manual mode retain their behavior. Closing invalidates the gate. `finishReady()` no longer queues its own RAF; the existing tick/render trigger is sufficient.
- `adaptFormulaStreamHold()`: only the existing full request made after complete initial preload bypasses quiet time. It cannot release before Rendered or while the existing calculation is in progress; ordinary incomplete chunk/scroll batching still uses the original debounce. This advances an existing calculation, without adding a readiness-driven calculation. Manual mode's preload branch still issues no full request.
- Upstream vendor and node_modules files are unchanged; the build adapter validates each exact source point. Font files, alias logic and the font guard are unchanged.

The first coordinated functional checkpoint passed a complex probe and 11 targeted regression cases under build contention. A later checkpoint passed 9 cases including explicit no-formula/manual/reset coverage and the strengthened batch-start gate. Those checkpoints preceded the additional 300 ms scheduler conversion; the final current revision must use its own functional results, not inherit startup assertions from those earlier runs.

Deterministic current-revision verification:

```sh
src-tauri/resources/agent-host/node --test packages/office-xlsx/tests/steady-scheduling.test.mjs packages/office-xlsx/tests/initial-calculation.test.mjs packages/office-xlsx/tests/formula-stream-completion.test.mjs
```

**20/20 passed**, covering original scheduling evidence, both post-paint phases, disposal at each boundary, stale session/results, reset/close, manual/non-formula paths, completed vs incomplete preload and in-progress calculation. Browser evidence is functional only when competing builds run; no speedup or Tauri timing is inferred from it.

## Final functional acceptance (under build contention)

The 300 ms conversion exposed an existing scroll-driven visual reinstall race: viewport changes called `queueVisualInstall`, which disposes all chart/image React components and asynchronously loads them again. All visuals for the active sheet are installed together, while Univer's `SheetCanvasFloatDomManagerService._scrollUpdateListener` already updates their positions. `adaptLoadedVisualScroll` retains range loading but avoids pool reinstallation on scroll after complete preload. Incomplete streaming installs, active-sheet installs, visual edits and chart data refreshes retain their original paths.

Current deterministic suite: **22/22 passed**, adding complete/incomplete scroll-path tests to the 20 initialization cases above. Package TypeScript check passed:

```sh
src-tauri/resources/agent-host/node packages/office-xlsx/node_modules/typescript/bin/tsc --noEmit -p packages/office-xlsx/tsconfig.json
src-tauri/resources/agent-host/node --test packages/office-xlsx/tests/steady-scheduling.test.mjs packages/office-xlsx/tests/initial-calculation.test.mjs packages/office-xlsx/tests/formula-stream-completion.test.mjs packages/office-xlsx/tests/loaded-visual-scroll.test.mjs
```

After the scroll fix, Chromium's previously failing presentation case passed. The affected functional group then passed **4/4**:

```sh
src-tauri/resources/agent-host/node --test --test-concurrency=1 packages/office-xlsx/tests/initialization-browser.test.mjs packages/office-xlsx/tests/presentation-mode.test.mjs packages/office-xlsx/tests/visuals.test.mjs
```

Coverage: no-formula snapshot, automatic initial batch resultApplied ordering, manual edit without added calculation, workbook reset, disposal, wrapped row height (380 px at ready and stable across three frames), images/charts, Chromium/WebKit presentation transitions, same workbook/frame/selection/scroll/zoom, navigation, edit/save, picture drag/resize/insert and shape save. Earlier current-scheduler group passed the other 11 unaffected cases (edit/undo/rebase, frame cancellation, full ribbon/chart/table, no-init-autosave, 50k streamed formula/save, resource failure, explicit/autosave). Browser/server cleanup runs in `finally`. Functional evidence is in ignored `tests/output/`; these results do not establish native physical first paint or a performance improvement.

The final resource-only addition derives the main dynamic import from esbuild metafile and emits one XLSX `modulepreload` link in renderer.html. The actual dynamic import still follows host initialize in renderer-entry.ts. The resource test verifies the exact link and, in a real browser without initialize, successful main fetch with no main-import/font-bootstrap marks or React root content. It then opens the complex workbook via the real explicit URL contract.

## Frozen candidate: initial module graph and on-demand languages

This checkpoint addresses eager module evaluation before the entry mark. The coordinating native production probe recorded entry at about 632 ms; the corresponding HTTP diagnostic fetched only 21 resources (14 scripts), with the 10,164,090-byte shared chunk downloading in about 9 ms. The 208 emitted files were not 208 cold requests. Those observations do not justify adding a preload for every chunk. No new native timing was collected for this candidate; its native benefit remains **pending measurement**.

The following are exact emitted JavaScript bytes from esbuild metafile static-import closures, not compressed transfer sizes, execution time, or all manifest files:

| Static closure | Before (bytes) | Frozen candidate (bytes) |
| --- | ---: | ---: |
| Renderer entry | 11,106,594 | 3,817,616 |
| Entry plus dynamic main and their static dependencies | 13,488,084 | 9,637,632 |
| `/renderer/i18n/` contribution within entry plus main | 3,662,164 | 252,946 |

The new entry closure contains no app/dialog/AI dictionaries; main's initial closure still pays for **zh + en**, the existing default and fallback dictionaries. Other languages load only when selected. Counts and bytes do not imply a proportional latency reduction: core, formula and UI modules still perform required initialization, and many modules removed from the host closure remain reachable from main.

### Boundaries and language contract

- `renderer-host.ts` dynamically imports `save-actions` only for a nonempty journal inside the existing flush serialization lock. Concurrent flushes retain their existing single-save behavior, and import failures reject the existing action promise. Baseline comparison, draft restoration, natural calculation and ready gates are unchanged.
- `renderer-output` loads inside the relevant async output/import/recalculation/screen-capture action. Request and authority checks precede the import where applicable; native requests follow module initialization, so their reply listener is installed before sending. Cancellation, rejection and byte callbacks retain the existing protocol. PDF implementation is excluded from the initial static graph.
- Printing copies stylesheet-relative external font URLs as data URLs **at output time**, preserving the fetched font bytes. This fixes the self-contained print validator rejecting external Carlito URLs; it adds no first-open font work.
- `scripts/locale-adapter.mjs` transforms pinned sources through guarded matches; vendor files remain unchanged. All **21 languages**, original language keys and complete app/dialog/AI dictionary contents remain available. Tests compare every merged dictionary with the original values. No dictionary is replaced with keys or a reduced translation set.
- Main awaits `ensureLanguage(lang)` after `getLanguage()` and before `setModuleLang`, document language/direction and first React render. The actual File adapter currently returns zh; the browser regression injects ru through the same API to verify non-default startup. No language persistence mechanism or `getLanguage` authority is changed.
- Before bootstrap, the existing `onLanguageChanged` registration is adapted for both LocaleProvider and context-menu consumers. Each subscriber receives a new language only after its complete dictionary is installed. Until then the previous complete language remains displayed. A later event invalidates an earlier pending delivery; unsubscribe invalidates pending delivery and disposes the original listener. `setModuleLang`, React state and context-menu translations therefore consume the completed language, not an intermediate dictionary.
- Other languages share a per-frame promise/module cache: concurrent requests for one language share loading, and successful dictionaries are loaded once per language per frame. Closing/replacing the frame discards that cache. There is no background loading of the remaining languages or automatic retry loop.
- Loading errors preserve the previous language and report through the existing MessagePort error/host `office-error` path, plus the frame error event. An initial language-loading error rejects ready through that same host path. A disposed or superseded subscriber does not publish a stale success/error.

### Verification at freeze

Commands below run from the repository root with Node 24 (`OFFICE_NODE` can select the installed runtime). They record already completed verification; they are not instructions to rebuild during another agent's native run.

```sh
NODE="${OFFICE_NODE:-node}"
"$NODE" packages/office-xlsx/scripts/build-renderer.mjs
"$NODE" node_modules/typescript/bin/tsc --noEmit -p packages/office-xlsx/tsconfig.json
"$NODE" --test \
  packages/office-xlsx/tests/renderer-host-deferred-actions.test.mjs \
  packages/office-xlsx/tests/initial-calculation.test.mjs \
  packages/office-xlsx/tests/locale-adapter.test.mjs
```

**13/13 deterministic tests passed**: deferred action validation/cancellation/errors and serialized save; initial natural calculation/manual/reset/close gates; all 21 dictionaries; gated rapid language events, unsubscribe and error reporting; pinned-source drift checks. Package TypeScript passed. Build-adapted source is exercised by the renderer build and functional tests; the package TypeScript command is not a separate typecheck of generated transformed vendor source.

The following targeted group has **10/10 checks passed** (9 browser cases plus the static manifest/graph/font check). The final results combine serial affected-scope runs; unrelated tests were not rerun after each fix.

```sh
"$NODE" --test --test-concurrency=1 \
  packages/office-xlsx/tests/full-renderer.test.mjs \
  packages/office-xlsx/tests/initialization-browser.test.mjs \
  packages/office-xlsx/tests/output.test.mjs \
  packages/office-xlsx/tests/pdf-output.test.mjs \
  packages/office-xlsx/tests/print-output.test.mjs \
  packages/office-xlsx/tests/renderer-resources.test.mjs \
  packages/office-xlsx/tests/locale-browser.test.mjs
```

Coverage includes real workbook boot, no-formula/wrap metrics, automatic resultApplied, manual/reset, ribbon editing/chart/table/save, CSV cancellation/errors, PDF bytes/mixed paper/cancellation/errors, Chromium and WebKit print, relocated renderer URL/resource failure, non-zh/en startup, blocked-language loading, rapid switching and a missing language chunk reaching the host error event. Pending language delivery cancellation is verified deterministically; it is not claimed as a separately recorded native race test. Browser/server cleanup completed. No Cargo, root Vite build or native performance run was part of this package verification.

Evidence paths, relative to this package:

- `tests/output/lazy-locales-validation.json`: frozen before/after byte counts, test groups, resolved failures and cleanup summary. This is a summary, **not a complete raw TAP or browser trace**.
- `dist/renderer-meta.json`, `dist/renderer-resources.json`: current raw build graph and complete resource contract; the resource check verifies all on-demand language shards, exclusion of other dictionaries/PDF from the initial graph, and unchanged Carlito file hashes. For a future comparison, archive the pre-build metafile separately and reference it as `$XLSX_BEFORE_META` before replacing dist.
- `tests/output/initialization-functional.json`, `tests/output/full-renderer-draft.json`, `tests/output/full-renderer-*.png`: initialization state/marks and real editing/screenshot artifacts.
- `tests/output/print-document.html`, `tests/output/print-document-{chromium,webkit}.png`, `tests/output/print-visual-geometry-{chromium,webkit}.json`, `tests/output/print-fit-columns.html`, `tests/output/print-explicit-area.html`: raw print content, screenshots and geometry.
- Raw TAP pass/failure output is retained in the implementation task's command/tool history; this checkpoint did not save a separate TAP log. The initial PDF/print failure was the external-font validator error and passed after output-time embedding; the locale browser assertion was corrected to the existing `ru-RU`/`ja-JP` BCP-47 values.

Ignored dist/output artifacts may be overwritten by later runs. The earlier `under-build-functional` raw JSON referenced above remains diagnostic evidence for the previous scheduler checkpoint, not a native performance result for this frozen graph. The remaining Rendered → calculation-start interval was not changed without additional evidence.

## Follow-up: complete-batch task release

The next coordinating native probe (`$NATIVE_XLSX_PROBE_DIR/xlsx-complex-{2,3}.json`, first measurement) recorded Rendered → initial-calculation-starting as **525 → 599 ms** and **527 → 605 ms** (74/78 ms). Other scenarios varied from 1 to 43 ms, so this is not evidence of a fixed residual 100 ms wait. Lifecycle stage notification is synchronous; the Rendered mark can precede other synchronous subscribers. Font loading already overlapped remaining main evaluation (253–324 vs main ending at 300 ms; 263–335 vs main ending at 311 ms), so its order was retained.

The full-preload branch previously released its existing calculation via `setTimeout(0)`. Its release now uses one coalesced microtask, after the current synchronous Rendered stack returns, avoiding an extra task-queue boundary. A pending full release cannot be replaced by a partial veto's quiet timer. Incomplete stream/scroll debounce, the upstream dirty-mutation 100 ms merge timer, the existing in-progress calculation wait, all lifecycle hooks and the real resultApplied ready gate remain. Runtime disposal invalidates the microtask, clears a quiet timer and unregisters the added lifecycle listener. No extra calculation or readiness shortcut was added.

Frame-local marks `rendered-hooks-complete`, `initial-calculation-queued` and `initial-calculation-flush` distinguish synchronous Rendered work from release scheduling on the next native run. This change does **not** establish that all 74/78 ms can be removed.

Renderer-only build passed; engine/sidecar/staged native resources were not rebuilt. Deterministic scheduling/gate tests passed **24/24**; targeted browser tests passed **5/5**; the resource graph/Carlito hash check passed. Commands from repository root, with `$NODE` selected as above:

```sh
"$NODE" packages/office-xlsx/scripts/build-renderer.mjs
"$NODE" --test packages/office-xlsx/tests/formula-stream-completion.test.mjs packages/office-xlsx/tests/steady-scheduling.test.mjs packages/office-xlsx/tests/initial-calculation.test.mjs
"$NODE" --test --test-concurrency=1 packages/office-xlsx/tests/initialization-browser.test.mjs packages/office-xlsx/tests/presentation-mode.test.mjs packages/office-xlsx/tests/full-renderer.test.mjs packages/office-xlsx/tests/recalculate-browser.test.mjs
"$NODE" --test --test-name-pattern='external renderer manifest' packages/office-xlsx/tests/renderer-resources.test.mjs
```

The browser group verifies actual no-formula/wrap, automatic/manual/reset, Chromium/WebKit presentation, chart/table editing/save and streamed workbook calculation/save. Evidence summary: `tests/output/initial-calculation-microtask-validation.json`; functional state/mark names: `tests/output/initialization-functional.json`; raw TAP: this task's command history. No new native timing is claimed. Browser/server cleanup completed; the candidate renderer is frozen for coordinated native validation.
