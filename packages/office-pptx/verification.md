# PPTX verification — 2026-10-13

Scope: `packages/office-pptx/**` and `src/components/office/PptxEditor.tsx`
in the authorized `office-integration` worktree. No root dependency/configuration
changes, Tauri launch, commit or publication.

## Final package verification

Run from `packages/office-pptx`, after the public DTO boundary correction:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Clean package install passed |
| `npm run build` | Fixed source integrity and portable bundle imports passed |
| `npm test` | 7 engine tests passed |
| `npm run test:ui` | 5 component tests passed |
| `npm run check` | Internal Bundler typecheck passed |
| `node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2021 --module ESNext --moduleResolution Node types.ts declarations/browser.d.mts` | Public DTO/browser declaration check passed without SDK implementation imports |
| A second `npm run build`, comparing SHA-256 of both bundles and notices | Identical outputs |

The engine tests use real simple/complex PPTX fixtures. They cover multiple
slides, targets, paragraphs and runs; repeated edits to one target; Chinese text;
two successive edit/save/reopen cycles; picture movement; preservation of every
unedited actual ZIP part; unsupported fields/structural edits; invalid JSON,
Unicode, UTF-8 and XML; and relocation of the bundled engine.

Component tests exercise actual SVG output, Chinese editing, picture movement,
readOnly, replacement of the model baseline, undo/redo and bounded scroll fades.
No full application build or File/CAS save was performed in this package scope.

### Reproducible output SHA-256

```text
engine.mjs
1129ba3b4f6460c7720ec346fd12ac381047b83cf42bfb58c3cbac621ff98ac0
browser.mjs
0364971f02835750ebde222d47b57fd389560eb888c7cc834b540fd6dbbc3e16
THIRD-PARTY-NOTICES.txt
72d47ee5f6fba5da188aa4bd1ae919a40d5bdfb416859e24bf80e18246e59047
```

## Concentrated headless visual acceptance

The isolated harness imported the actual component and host stylesheet. Compared
against `docs/design/office-editor-direction-20261013.md` / `.html` and the Word
reference screenshot. No Tauri or visible browser window was launched. The
owned browser session and Vite harness were closed after capture.

| Evidence | Behavior |
| --- | --- |
| [Wide editor](output/playwright/pptx-wide.png) | Existing text selected; original slide ratio, 156px thumbnails and 226px inspector |
| [Narrow editor](output/playwright/pptx-narrow.png) | Inspector expands below the canvas |
| [Narrow collapsed editor](output/playwright/pptx-narrow-collapsed.png) | Chinese text changed to 中文编辑完成; inspector collapsed |
| [Picture movement](output/playwright/pptx-image-moved.png) | Picture moved right from 2.032cm to 2.667cm, with vertical position retained at 7.112cm |

At the 1200px viewport, measured thumbnail width was 156px, inspector width was
226px, and no horizontal overflow occurred. No added watermark appeared.
Document style is independent of host shell tokens. Advanced rendering fidelity
limitations and unsupported edits remain explicit in the package README/model.

### 2026-10-23 — #212 PPT current-selection bridge

- `npm run build --prefix packages/office-pptx`: passed; pinned 501 core / 4 Web adaptation sources verified unchanged.
- `npm run check --prefix packages/office-pptx`: passed.
- `npm run test:ui --prefix packages/office-pptx -- --run test/editor.test.tsx`: 24 passed. Registration/channel lifecycle, replacement rejection, preview and retained controller destruction are covered.
- `OFFICE_PLAYWRIGHT_MODULE=<bundled playwright>/index.mjs OFFICE_ACCEPTANCE_URL=http://127.0.0.1:4183 node packages/office-pptx/test/browser-selection.mjs`: passed in headless Chrome. Actual selected element capture, different subsequent selection, text/layout apply, original undo/redo, File save/reopen, atomic invalid-batch rejection, composition/readonly rejection, mutation/undo/external replacement invalidation and mixed-run bold preservation.
- Red-before-green evidence: controller undefined (registration test), selection response timeout (real channel), and `Bold: changed` flattened into one run (persistence assertion), each resolved by its corresponding implementation.
- Scope: package bridge only; parent integration, real model use and native desktop product acceptance are not represented by these checks.


## 2026-11-10 — #303 progressive PPTX view

Scope: only `packages/office-pptx/**`, shared branch
`codex/review-office-progressive`. This agent did not commit or change branches.
Build, test, and headless commands use the shared `with-build-lock.py`; Node
regressions use `--test-concurrency=1`, Vitest uses `--maxWorkers=1`. No watcher
or visible GUI is launched. Full `inspect` remains the authoring entry.

### Actual red and green evidence

- `output/progressive-red.log`: original engine lacks `inspectView`; one actual
  test fails before implementation. Frozen original source is local ignored
  evidence, not a mock replacement of the engine/parser.
- `output/progressive-resource-red.log`: bypassing only the new source-locked
  resource-cleanup build transform reproduces deletion of a 3D resource still
  owned by an unparsed tail slide. The same real-archive regression passes in
  `output/progressive-affected-targeted.log`.
- `output/progressive-ui.log`: initially 49/50; lazy render descriptors exposed
  extra enumerable/default fields and failed the existing strong full-layout
  equality check. Production descriptors were corrected; the unchanged two-test
  file passes in `output/progressive-initial-layout-green.log`.

### Effective package gates

| Gate | Actual result / evidence |
| --- | --- |
| `npm --prefix packages/office-pptx run build` | Passed after final production correction, `output/progressive-affected-build.log`; 515 pinned GenOffice + 4 Web adaptation sources verified |
| `npm --prefix packages/office-pptx run check` | Passed, `output/progressive-affected-check.log` |
| Node existing six files | 22/22, `output/progressive-node.log`; affected renderer-resources repeated 1/1 after final build in `output/progressive-affected-resources.log` |
| Node progressive two files | 14/14, `output/progressive-affected-targeted.log` |
| UI eight files | Effective 50/50: initial 49/50 plus unchanged failed file 2/2 after production correction; seven unrelated files reused |

Progressive regressions execute real pinned parsing/layout, handlers, archive
writer, candidate manifest checks, and native engine edit/reopen. Coverage includes
first real editable layout while tail XML parser reads are unavailable; two
distinct first-slide edits across successive saves; later on-demand tail editing;
undo/redo; duplicate/delete/move of unseen slides; complete global table/chart/image
layout; animation/transition fidelity; shared resource liveness. Full saved ZIP
part lists and every unmodified part are byte compared, including media, masters,
notes, relationships and unknown parts. Exact source hash and changedParts
validation remain enforced. Invalid tail XML is rejected even before its slide
is parsed. A real 3-slide, 45,538-byte fixture measured eager archive admission
8.494 ms and complete XML admission 3.472 ms in the final targeted run; these are
individual measurements, not percentiles or a large-file latency claim.

The `gpt-6.1-sol` implementation/test agent contributed the nine session tests.
The authorized read-only review agent found resource-liveness and screenshot
image-readiness gaps; both were corrected through checked build transforms.
The parent agent owns final independent Standards/Spec review.

### Headless development failures retained

- `output/progressive-headless.log`: first Canvas was available, but the script
  looked up `nvId` on the projected model instead of its exported stable `id`.
- `output/progressive-headless-debug.log`: reusing the still-active overlay wrote
  the second test edit into the first shape; the strong two-target reopen check
  failed. The script now exits the previous overlay and checks the next shape's
  original text before filling it.
- `output/progressive-headless-chromium.log`: first editable input passed, but
  the raw-coordinate click was below the second caption's actual text hit area;
  screenshot diagnosis moved it inside the text. No production workaround or
  weakened persistence assertion was introduced.
- `output/progressive-headless-webkit.log`: launch failed before product execution
  because the installed Playwright expected WebKit 2391, while only older
  revisions were cached. Matching browser installation uses the shared lock and
  `PLAYWRIGHT_SKIP_BROWSER_GC=1` to retain other agents' browser caches.

### Remaining product/platform limits

- Opening still inflates the complete budget-admitted ZIP and validates every
  XML/rels part before first editable content. The optimization removes full-deck
  semantic parsing/layout and eager media URL encoding; it is not a streaming ZIP
  implementation. Individual complex slides still parse/layout synchronously
  when requested.
- Lazy render descriptors inspect slide XML headers for hidden/background flags;
  this does not build tail shape models or layouts. Global operations/output
  intentionally materialize their complete required slide set.
- Actual headless acceptance uses the production App, Canvas, MessagePort and
  OfficeEditSession with real engine byte saves in the Vite fixture endpoint.
  It does not exercise Tauri filesystem transactions, staged native working-save,
  physical trackpad hardware, or Windows. The parent agent owns native File/CAS
  acceptance and visible GUI/platform acceptance.
- Zoom/clipboard screenshot image-readiness transformations have checked build
  seams and package resource coverage; this package does not claim a new complete
  pixel suite for every upstream editing/export feature.

### Scope handoff file list

All paths below are inside `packages/office-pptx/`:

- View/validation contract: `engine.ts`, `types.ts`,
  `declarations/engine.d.mts`, `archive-validation.ts`, `progressive-open.ts`.
- Renderer/session/source-locked transforms: `parity-entry.tsx`,
  `parity-session.ts`, `parity-candidate.ts`, `parity-history.ts`,
  `progressive-build.mjs`, `parity-build.mjs`, `parity-text-edit-build.mjs`.
- Verification/harness: `package.json`, `test/build-portability.test.mjs`,
  `test/progressive.test.mjs`, `test/progressive-session.test.mjs`,
  `test/headless-progressive.mjs`, `test/ui/main.tsx`, `test/ui/vite.config.mjs`.
- Documentation: `README.md`, `work-package.md`, `verification.md`.

The imported `parity-text-edit-build.mjs` / build-portability zoom changes are
retained. No source-lock manifest or vendor bytes were edited. After the parent
snapshotted the implementation, the final acceptance work writes only
`test/headless-progressive.mjs`, `README.md`, `work-package.md`, and this document;
engine and renderer production source/build artifacts remain unchanged. Build
outputs and evidence logs/screenshots are ignored artifacts, not new source files.

### Actual headless App acceptance — final reruns

The fixture is a real 102,422-byte, 48-slide PPTX expanded from the checked
complex fixture; parser, inheritance, App, Konva Canvas, MessagePort,
OfficeEditSession, candidate validation and engine byte writing remain real.
The test wraps only the built tail parser with a checked fault-injection seam:
slide 48 is unavailable until explicitly released after both saves. Full-archive
UTF-8/XML validation still runs before the first slide is editable.

The save interaction waits for the host React model commit and new epoch's
initialization/loading-overlay completion. Old iframe `readonly=false` alone
was not a valid save-receipt barrier and caused the earlier pointer timeouts.
Target selection reads the real rendered hit canvas; actual click/F2 and
contentEditable input are used, and the target's original text is checked before
filling it. The second edit modifies a different shape, so losing the first save
is observable. No production fix or persistence assertion relaxation was needed.

WebKit final command (under `with-build-lock.py`):

```sh
env OFFICE_PLAYWRIGHT_MODULE=/Users/xuchen/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs \
  OFFICE_WEBKIT_EXECUTABLE=/Users/xuchen/Library/Caches/ms-playwright/webkit-2336/pw_run.sh \
  OFFICE_BROWSERS=webkit node packages/office-pptx/test/headless-progressive.mjs
```

WebKit **passed** (`output/progressive-headless-webkit-fit-final.log`;
`output/playwright/progressive-webkit-result.json`): first Canvas content
593 ms, first real editable input completed 926 ms, input interaction 86 ms;
eager archive admission 23.466 ms, full XML admission 5.162 ms. These timings
come from the actual initial model used by that page. Coverage stays 14/48
through both saves. Full reopened bytes contain both edits and the unvisited
slide-48 text; every original ZIP part name survives and only
`ppt/slides/slide1.xml` changes byte content. A forced full-layout query then
proves that the tail fault really rejects, and releasing it resolves all 48 real
layouts.

Actual WebKit zoom coverage: range keyboard and mouse input; repeated status
buttons from 50% through 150% and back with disabled endpoint no-ops; Ribbon
preset steps and repeated endpoints, its real 100% button; Ctrl/Meta keyboard
shortcuts and reset; Ctrl/Meta wheel notch events; fractional Ctrl-wheel pinch
up/down and both endpoint clamps; fit; and restores below/above bounds both in
edit mode and after switching into a ready readonly preview. Canvas widths are
640 px at 50% and 1920 px at 150%; fit is 0.813868528315471 and pinch-up from
1.0 is 1.0125784515406344. The percentage label is a span: a numeric scale dialog
is not applicable, and the unrelated slide-insertion ZoomDialog is not counted.
Wheel/pinch events reach real production handlers but do not claim physical
trackpad hardware acceptance.

Chrome **passed** (`output/progressive-headless-chromium-final.log`;
`output/playwright/progressive-chromium-result.json`), with the same strict data
and zoom assertions. First Canvas content: 567.100 ms; first real editable input
completed: 857 ms; input interaction: 86 ms. Actual initial eager archive admission
18.843 ms, complete XML admission 5.944 ms. Coverage also stays 14/48 through both
saves, with the tail parser held and only `ppt/slides/slide1.xml` changed.

Both final browser runs assert fit against the real viewport/paper dimensions:
1317×658 viewport, 1280×720 nominal paper, expected clamped fit 0.813888889,
actual fit 0.813868528, and actual paper bounds 1041.752×585.998 px. WebKit also passes
the same explicit viewport-formula assertion and the real 640→1920 px Canvas
width ratio. The final targeted WebKit rerun uses the latest unchanged script;
its fitGeometry/expectedFit fields are retained in the merged evidence.

| Browser | First Canvas draw | First editable input completed | Edit interaction | Eager ZIP admission | Full XML admission |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chrome | 567.100 ms | 857 ms | 86 ms | 18.843 ms | 5.944 ms |
| WebKit (explicit 2336 executable) | 593 ms | 926 ms | 86 ms | 23.466 ms | 5.162 ms |

`output/playwright/progressive-results.json` combines the two original successful
result files without recalculating their measurements. Navigation timing includes
this Vite harness/resource/initial-model path, excludes browser launch, and is a
single run per engine rather than a percentile. First Canvas draw is the actual
text witness's `fillText` call; firstEditable completes real contentEditable input.
It is not a native launch, compositor presentation, Windows, or large-file
latency benchmark. Physical wheel/trackpad hardware remains untested.

Both final browser commands exited 0, including the required latest WebKit fit
assertion rerun. No PPTX command remains running or queued. No optional repeat
was added after these successful final gates.
Native staged working-save 7/7 is reported by the parent agent, not counted as
this package's native GUI or platform performance acceptance. Independent final
Standards/Spec review, root/native acceptance and publication remain with the
parent agent. This agent made no commits and did not switch branches.

### Process coordination incident

While replacing the queued WebKit command with an explicit executable, this agent
mistakenly terminated stale PID 10476, whose ownership was not established. The
incident was promptly reported to the parent agent; no result for that process
is claimed here. The actual superseded own WebKit waiter 10562 was subsequently
verified by its log descriptor and full command and canceled. Final Chrome and
WebKit success logs above are from completed commands, not canceled work.
