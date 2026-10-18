# Office browser and native performance harnesses

## Work package

Related area: Issues #118 / #191 Office integration. This directory contains the standalone browser harness, an opt-in native ProjectFileContent harness, a separate application landing observer and a read-only native report summarizer. Dependencies: existing Office dist artifacts, package dependencies and a Playwright browser for standalone runs; a prepared measurement binary and isolated Workspace for native document runs. Deliverables: fixture matrices, raw evidence and summaries with explicit scopes. Product optimization and final native performance conclusions are outside this document's verification claims. Readiness uses real content, fonts/layout and natural Excel calculation evidence; subsequent interaction probes are recorded separately. Existing validation is listed below; this documentation cleanup runs only targeted diff and portability checks.

## Standalone browser run

From the repository root, using the agreed Node 24 runtime:

```sh
src-tauri/resources/agent-host/node scripts/office-performance/run.mjs --formats=docx,xlsx,pptx --tiers=complex --scenarios=first --repetitions=1 --qualification=functional-probe --output=scripts/office-performance/output/complex-probe
```

A serial five-repetition matrix (only when competing compilation/measurement has stopped):

```sh
src-tauri/resources/agent-host/node scripts/office-performance/run.mjs --repetitions=5 --qualification=idle-local --output=scripts/office-performance/output/baseline
```

Optional arguments:

- `--artifact-root=/absolute/path/to/baseline-artifacts`: reads `packages/office-{docx,xlsx,pptx}/dist` underneath it. The default is the worktree root. No build or source transformation is performed on these bundles.
- `--browser=chromium` (default) or `--browser=webkit`; `--channel=chrome` selects installed Chrome for Chromium.
- `--tiers=small,complex,large`; `--formats=docx,xlsx,pptx`.
- `--scenarios=first` runs first open only. Omit to run the full lifecycle sequence.
- `--timeout=90000`: milliseconds for each readiness/interaction gate.
- `OFFICE_PLAYWRIGHT_MODULE=/absolute/path/to/index.mjs`: defaults to `packages/office-xlsx/node_modules/@playwright/test/index.mjs`.

The script owns an ephemeral loopback server, closes every browser, and serializes its own runs using `.measurement.lock`. It never starts a visible browser, Tauri or a build. Coordinate separate native measurements externally. Output directories must be unique for comparisons; never mix two runs into one directory.

## Browser scope and scenarios

**Standalone headless browser using real production Office dist renderers. These are not Tauri, ProjectFileContent or native File results.** Server-side file read and real Node `engine.inspect` replace the native host for this baseline. Markdown is intentionally left for the application host.

For each repetition, primary format and size, launch a **new browser process and new context**. Within it, serially run:

1. `first-format`: first document of that format in this fresh browser.
2. `resources-loaded-different-file`: destroy the renderer and open a distinct sibling file with shared format resources.
3. `close-reopen`: explicitly close, then reread/reinspect/remount the sibling file.
4. `switch-format`: open the next selected format in the same page/process.
5. `switch-back`: return to the primary file with that format's resources warm.

Every open starts in preview. After the content-ready timestamp, measure preview → edit, an actual focus/zoom/cell-navigation interaction, and edit → preview. Open always rereads and reinspects; it does not retain application tab models or unsaved sessions. Switching therefore measures harness remount semantics, not application retained tabs. A switch's format can already be warm on switch-back. Server engines share one Node process and are cached after their first import; `engineImportMs` discloses this. “Fresh” describes the browser process, not cold OS disk cache or cold native workers.

## Browser timing definitions

| Field | Measurement |
| --- | --- |
| `open.readMs` | Server filesystem read of actual fixture bytes |
| `open.engineImportMs` | Import/cache lookup of actual Node engine dist |
| `open.engineMs` | Real `engine.inspect` |
| `open.inspectRoundTripMs` | Browser request through bytes read, inspect, JSON serialization/transfer/parse |
| `open.rendererImportMs` | Native browser dynamic import of real dist entry and dependencies |
| `open.resourceModuleMs` | Import of the tiny external renderer URL/preload module, when the selected artifacts have a manifest |
| `open.preloadStartedAtMs` | Relative open time when renderer module/CSS hints are installed; null for embedded baseline artifacts |
| `open.cssMs` | Renderer shell stylesheet load (PPT self-contained: zero) |
| `open.mountToReadyMs` | Mount through renderer's real ready/initialized signal |
| `open.readyMs` | Browser open start through ready; inspect/import/CSS run with `Promise.all` |
| `contentReadyMs` | Runner wall time from open request through ready, content/calculation evidence, fonts, images and stable layout; includes automation round trips |
| `previewToEditMs`, `interactionMs`, `editToPreviewMs` | Separate subsequent mode/interaction probes; never included in cold content-ready |
| `totalThroughInteractionMs` | Whole observed sequence, explicitly includes mode changes and interaction |

Do not add parallel phase durations to estimate the critical path. Shell browser import and in-frame renderer parsing/execution are separate. For embedded baseline artifacts, renderer HTML/fonts travel inside the entry's module dependency graph; browser resource timing does not list inline HTML/base64 fonts individually. For external artifacts, the tiny API and resource modules import alongside inspect and shell CSS. Once both modules resolve, the harness installs modulepreload/CSS hints without executing the renderer in the parent, and removes hints on close. The iframe receives the explicit renderer URL. Dist asset byte counts and hashes include manifest-listed nested resources.

Entry selection uses only the selected `--artifact-root`: Word without `renderer-resources.json` uses `editor.mjs`; Word with that manifest uses `full-editor.mjs`. Excel uses `browser.mjs`. A missing selected entry fails instead of falling back to another build. `/harness-config` and raw metadata record the resolved contracts. Baseline snapshots cannot accidentally select newer entries from the worktree.

PPT keeps its existing init parameters/MessagePort handshake. With a manifest its iframe uses the external renderer URL via `src`, `apiEntry` is null and no host API bundle is imported. Without a manifest it imports legacy `browser.mjs` and uses `parityHtml` via `srcdoc`.

Only production dist is supported; `--mode=dev` is rejected. Any future dev harness must write separately labeled outputs. The PPT entry imports React externally; the server exposes the installed React production CJS files as narrow ESM wrappers for the entry's declared imports. The actual PPT dist bundle is served verbatim; there is no esbuild/Vite bundling.

## Browser evidence and validity

- `raw.json`: environment, qualification, artifact hashes/sizes, browser version, fixture IDs, every attempted sample (including failures), timings, in-frame long tasks/font/image/layout evidence, resources/network/console, and screenshot paths.
- `summary.json`: per-format/size/scenario median, p95 (nearest rank), max, successful count and failure count. Failed samples are excluded from aggregates. At n=1, median/p95 are that single observation, not a tail estimate.
- `fixtures/manifest.json`: hashes, dimensions, source provenance and visible witness for all fixtures.
- Screenshots: each attempted scenario, captured after timing. Warm scenarios retain browser resource/cache state.

Canvas `fillText` observation and the existing Sheets host attach/render hooks are instrumented in the test realm only, without changing product files. They introduce measurement overhead; use the same harness version before/after. Readiness requires a unique fixture witness on the actual DOM/canvas, a visible document/main sheet canvas/stage, font readiness, actual image decode evidence and three stable frame geometries. Excel additionally checks populated cells, natural calculation completion and expected formula values (including exact number-format display values from the same installed numfmt library); the probe does not execute calculation. Real first-screen image failures, script errors and HTTP failures invalidate a sample. Hidden ProseMirror separator images and blank error-clearing protocol messages are recorded/classified without being mistaken for content failures.

The fixtures are reproducible derivatives of committed real OOXML fixtures: small = simple, complex = complex, large = extended complex (500 extra Word paragraphs; 37 extra PPT slides; 10,000 Excel rows and 10,000 formulas). Siblings carry different visible witness strings and different bytes. They are controlled synthetic workloads, not representative customer-document distributions. This first implementation checks initial viewport and in-memory formulas; it does not claim all offscreen pages or every interaction are validated. System font fallback remains browser/OS dependent and font evidence must accompany comparisons.

Native document and application landing scopes are described separately below. Browser `engine.inspect` and renderer timings do not substitute for either native scope.

Excel initialization marks are captured in `paint.initialization`, including font load result (`loaded`/`timeout`), React render, lifecycle stages, initial calculation and ready. The font guard remains intact. Current XLSX artifacts use the pinned build adapter's cancellable two-frame/task scheduling in place of the original 300 ms render and 3000 ms Steady timers. Engine mount/activate, Rendered subscribers and every Steady hook remain; host ready also observes the existing initial automatic calculation through resultApplied. Manual/non-formula paths retain their behavior, and the readiness probe does not initiate calculation. Earlier artifact snapshots can retain the original timers; identify the selected artifact before interpreting marks. See the [XLSX diagnosis and functional evidence](../../packages/office-xlsx/FIRST-OPEN-DIAGNOSIS.md).

## External resource preparation (2026-10-19)

This subsection is the preparation checkpoint, not the final acceptance state. Later Word standalone URL/browser checks and native evidence are recorded in [the final work-package report](../../docs/implementation/office-first-open-performance-20261018.md); that report distinguishes passing scopes from remaining gaps.

Recorded syntax checks and `server.test.mjs` passed for artifact-local baseline/after entry selection, missing-entry failure and loopback resource-module routing without launching a browser. Package functional evidence is recorded separately in `packages/office-docx/test/output/external-renderer-verification.json` and `packages/office-xlsx/tests/output/initialization-functional.json` (ignored local outputs). The Word record distinguishes the passed resource/lifecycle checks from the pending browser recheck after its dynamic default-URL change. XLSX evidence includes natural calculation ordering, manual/reset behavior and stable wrapped row height; its qualification is `under-build-functional`. These checks establish specific functional behavior, not a native timing improvement. No tests, builds or measurements were rerun for this documentation cleanup.

## Functional verification (2026-10-18)

Node 24 syntax checks pass for the five owned JavaScript modules. Targeted Chromium complex first-open probes passed independently after fixing probe selectors and value formatting:

- Word: `output/complex-diagnostic/raw.json` (`docx` sample); real full document content, image diagnostics, fonts/layout, focus and preview/edit passed.
- Excel: `output/xlsx-diagnostic-v3/raw.json`; one natural start/end/result-applied sequence, populated main canvas, three expected formulas, keyboard selection and preview/edit passed. No forced calculation.
- PPT: `output/complex-probe-v2/raw.json` (`pptx` sample); real slide stage, fonts/layout, zoom click and preview/edit passed.

Earlier failed probe outputs are retained for diagnosis and are not baseline samples. These probes ran while native compilation could compete for CPU. At this 2026-10-18 checkpoint, lifecycle warm/switch scenarios and the full size/repetition matrix were implemented but had not established a baseline. The metadata-only harness hash addition did not affect those verified renderer paths. This historical standalone checkpoint supplies no final native performance result.

## Native document shell and application landing

The `office-performance` Cargo feature enables the native entry. Normal application builds do not enable this entry by default. `native-run.mjs` launches the supplied binary with `PROJECT_MIND_OFFICE_PERFORMANCE`, an isolated app-data directory and a loopback report collector. It records the raw JSON, matching `.log` and `-memory.json`; a valid JSON result is distinct from a budget pass. Runs must be coordinated serially with all builds and other measurements stopped; the browser lock does not serialize native runs.

### Document shell

The report scope is `native ProjectFileContent shell (not full application startup)`. It uses the real ProjectFileContent component, file/version commands, Office worker and installed renderers. The sequence is `cold_open`, `first_other_file`, `close_reopen`, `switch_file`, then `preview_to_edit`; Markdown instead records `rich_to_source` and `source_to_rich`. Optional cycles add close/open repetitions. `--acceptance=1` adds real edit/autosave/receipt/close/native-readback operations with a separate acceptance kind. Performance records carry a 1000 ms budget; `over_budget` is separate from readiness failure. Absent optional large fixtures are skipped after a directory scan; unreadable fixtures or scan failures remain errors.

For an authorized serial matrix, set `OFFICE_NATIVE_BINARY` to the absolute path of the prepared measurement binary, `OFFICE_NATIVE_OUTPUT` to a unique absolute output directory, and `OFFICE_NATIVE_WORKSPACE` to the prepared isolated Workspace. The declared mode must match the binary; this command does not build or provision it:

```sh
NODE_BIN="${NODE_BIN:-src-tauri/resources/agent-host/node}"
"$NODE_BIN" scripts/office-performance/native-matrix.mjs --mode=release \
  --binary="$OFFICE_NATIVE_BINARY" --out="$OFFICE_NATIVE_OUTPUT" \
  --workspace="$OFFICE_NATIVE_WORKSPACE" --formats=docx,xlsx,pptx,md \
  --samples=simple,complex --repetitions=5
```

`native-matrix.mjs` records machine, binary hash, mode and qualification in `matrix.json`. Each sample launches a fresh native process with a visible incognito WebView. OS caches are retained. `native-run.mjs` accepts `--visible=1`; without it the window is hidden, which can suspend RAF/painting and invalidate readiness. The runner's `wallMs` and shell navigation marks are diagnostics, not document-open or full-application-startup substitutes.

### Application landing

`native-run.mjs --page=startup` retains the real application landing page and injects `startup-probe.js`. It reports scope `full application landing` and `durationFromNavigation`: the navigation-relative time through a visible landing heading, loaded fonts and stable geometry across two RAF intervals. `observerDuration` is a separate duration from observer injection. This is landing readiness, not Workspace opening or document rendering. Store these reports in a separate directory so their native-run filenames cannot overwrite document reports:

```sh
"$NODE_BIN" scripts/office-performance/native-run.mjs \
  --binary="$OFFICE_NATIVE_BINARY" --out="$OFFICE_STARTUP_OUTPUT" \
  --page=startup --visible=1
```

`OFFICE_STARTUP_OUTPUT` must identify a unique output directory; its default isolated app-data directory supplies a fresh landing state. Visibility and readiness errors remain part of the evidence. This section describes the implemented scope and does not assert a final native startup result.

## Summarizing existing native evidence

This command only reads existing native reports and sidecars; it launches no application, browser or build. Set the `OFFICE_*` paths to the existing absolute input directories, a metadata JSON file describing machine/cache/build conditions, and a new summary file:

```sh
NODE_BIN="${NODE_BIN:-src-tauri/resources/agent-host/node}"
"$NODE_BIN" scripts/office-performance/summarize-native.mjs \
  "--input=baseline:$OFFICE_BASELINE_OUTPUT" "--input=after:$OFFICE_AFTER_OUTPUT" \
  "--metadata=$OFFICE_PERFORMANCE_METADATA" "--output=$OFFICE_SUMMARY_JSON"
```

`--baseline=DIR` / `--after=DIR` are aliases; repeated labels pool directories. Metadata is optional and retained verbatim; omitted environment facts are not inferred. Output is compact JSON (stdout if `--output` is omitted), with per-format/sample/scenario `n`, `rawms`, median, max, nearest-rank p95 and status. Sample means the run's configured cohort; each record retains the actual file. Unlike the browser summary, native statistics retain all finite observed elapsed times, including failed elapsed times, with status counts and separate `failures` / `over_budget` lists. Missing data remains null/unknown. Raw reports take precedence over matrix summaries, preventing double counting; matrix-only fallback leaves run completeness unknown.

Version/inspect/recalc commands are extracted individually. Worker log differences use two independent cumulative clocks: inspect's `read → worker-complete → revalidated`, and the worker request's `worker-slot → worker-spawn → worker-response → worker-decode`. The slot interval includes validation/frame preparation; spawn includes temporary setup; response includes parallel send/receive and engine execution; decode includes child-exit wait. No parallel durations or overlapping outer/worker timelines are added. Command/request joins require an exact recorded requestId; the current native command records omit it, so order is not used to invent a match.

Startup stays separate by scope and retains `durationFromNavigation`. Memory includes only explicitly marked new-WebKit candidate RSS, in KiB: it is not heap, may include unrelated processes and has no guaranteed application ownership. Sampled per-process peaks are not summed into an application total.

Existing summarizer verification passed syntax checks, fixed temporary JSON checks for statistics/missing data/phase differences/CLI behavior, and read-only parsing of three existing native reports with 15 scenario groups and matching logs. No new native measurements were run for that verification. Final native comparisons require the coordinating agent's valid serial results and environment/build metadata.

### Committable native release extract (2026-10-19)

[`evidence/native-release-20261019.json`](evidence/native-release-20261019.json) is a compact extraction of existing raw reports, not a new measurement. Its scope is **native ProjectFileContent shell, not full application startup**. Set `OFFICE_PERF_EVIDENCE` to the existing evidence root to reproduce it without launching a build, browser or application:

```sh
node scripts/office-performance/evidence/native-release-20261019.mjs
```

The generator reads only the declared source matrices and their selected raw reports/logs. Baseline pools `baseline-native-release-formal` for Word simple/complex plus all PPT/Markdown cohorts, `baseline-native-large-word-corrected` for Word large, and `baseline-native-release-xlsx-visual` for Excel. The main after stage uses the completed four-format, 44-run `after-native-release-verified-formal` matrix. Earlier `after-native-release-other-formal` Word/PPT/Markdown runs remain a separate 33-run `after-prior` stage; labels prevent pooling. The generator requires `matrix.finishedAt` and exact 3/5/3 repetitions per format, and derives `pending` from actual final-stage readiness completeness. The invalid original Word large runs are excluded with their hashes and recorded reason. The **1499 ms** Word cold-open observation from `native-optimized-host-release-probe` remains as a separate non-formal run and is never pooled into formal statistics. The three `native-final-xlsx-probe` runs are also retained as non-formal; `probeGroups` contains their separate statistics and the Word probe, while `groups` keeps the formal stages distinct.

Every scenario group retains all raw milliseconds, aligned source references, median, max, nearest-rank p95 and status counts. `coverage` records expected/observed/readiness-complete counts; any captured errors or scenario anomalies remain explicit rather than being silently dropped. Command groups and native worker phases retain the same statistics; each run also retains individual commands, worker request IDs, the two independent cumulative worker/inspect clocks, shell navigation fields and every recorded cold `office-xlsx:` / `office-component:` mark. Missing mark fields remain `null`; captured empty marks remain `[]`. Document clocks are not combined, and worker requests are not assigned to commands by ordering. Full canvas traces, base64 media, screenshots and RSS samples stay in raw evidence rather than being duplicated in this extract.

Source matrices supply historical binary SHA, machine and cache qualification. Each selected raw JSON is rehashed and checked against its matrix; logs, matrices and fixture manifest also carry SHA-256. Paths are relative to `$OFFICE_PERF_EVIDENCE` or repository paths. Fixture provenance includes the v2 manifest and verified current fixture/workspace hashes; native reports did not record historical input-byte hashes, so present workspace bytes are not represented as proof of historical bytes. The matrices describe fresh visible native processes with incognito WebViews and retained OS caches, not a cold machine/cache experiment.

This artifact establishes recorded performance readiness and budget outcomes only. It does **not** mark optional edit/autosave/race/history/Workspace acceptance as passed. Over-budget samples are retained without trimming, and the non-formal outlier is not erased. The coordinating report owns interpretation and subsequent evidence additions.
