# Office PPTX

PPTX editor implementation for child #191 / parent #118. The embedded editor reuses
GenOffice's pinned slides renderer, Canvas/Konva interactions and document ops.
`inspect` and `edit` consume and return bytes. The host owns File versions, CAS,
saving, historical replacement, native export dialogs and native printing.

## Reproducible build

```sh
npm --prefix packages/office-pptx ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/office-pptx run build
```

`source-lock.json` pins 501 unmodified original files to
`genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`, with byte lengths
and Git blob SHA-1. `fork-source-lock.json` pins four inspected Web adaptation
files from `Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4`.
The actual browser image/media pickers are extracted from that fork. Its old ops
session and arbitrary-path relay are not used. `sources:fetch` restores exact
verified sources; normal builds need no network. Package npm dependencies have
their own lockfile.

`generate-parity.mjs` extracts the pinned preload API, 97 actual document handlers,
required helpers, font sfnt/TTC helpers and browser pickers. Build transforms are
explicit in `parity-build.mjs`: deterministic IDs/timestamps for command replay;
the existing File menu is available on every platform; native-host-owned Open /
Save As are hidden; export cancellation has accurate feedback. Vendor bytes stay
unchanged. Original Apache/Unicode, EMF, UI font and OFL notices are retained;
bundled dependency licenses are collected into `dist/THIRD-PARTY-NOTICES.txt`.

Outputs:

- `dist/engine.mjs`: portable Node ESM with only Node builtin imports. Copy the
  complete dist into `office-dist/pptx/`; the host shim may re-export engine.mjs.
- `dist/browser.mjs`: includes the self-contained isolated upstream renderer HTML,
  plus the older RenderTree SVG adapter retained for compatibility. The actual
  `PptxEditor` uses the full renderer. Host React remains external.
- `dist/*.d.mts`: public declarations use package DTOs and React types.

No production code depends on a workspace absolute path or validation harness.

## Byte contract and long sessions

```ts
inspect(bytes: Uint8Array): Promise<PptxModel>
edit(bytes: Uint8Array, edits: PptxEdit[]): Promise<Uint8Array>
```

Models include source bytes (`sourceBase64`), source SHA-256, slide geometry,
render payloads, media and stable OOXML cNvPr aliases. The renderer opens actual
bytes and executes the original editing operations. Each debounce / before-save
flush produces zero edits, or **one bounded candidate**:

```ts
{kind: 'candidate', sourceHash, base64, changedParts}
```

Native acceptance verifies the exact current source hash, canonical base64,
100 MiB compressed output, <=10,000 ZIP parts, <=100 MiB per part, <=256 MiB total
inflation, valid UTF-8/XML, and the exact actual changed / added / removed parts.
Every part omitted from the manifest must remain byte-identical. File/CAS still
decides whether that candidate is written. A long session does not hide an
unbounded command log inside another edit to evade the worker's 256-edit cap.

Normal save acknowledgment rebases candidate comparison to the new native source
while retaining the upstream bounded 100-step undo/redo history and selection.
A genuinely different model/history replacement remounts the editor session.
Shape text saves checkpoint the original extraction/editText operation while
keeping the same live contentEditable DOM and directional native selection.
Pending native I/O freezes input; a matching receipt retains caret, continued
input and undo. A host pointer/keyboard action cancels focus restoration; true
readOnly or a different historical source closes the old overlay. Table-cell
text and notes keep upstream commit-and-exit behavior.

Every init, request and response carries a non-secret epoch. Model/external-edit
replacement invalidates old host callbacks and queued renderer work; pending
outputs reject and late completions cannot enter the new File. Matching native
acknowledgement explicitly settles old internal save requests even when its
model update precedes the host save Promise completion.

The native API also supports bounded original `kind:'command'` operations and
legacy exact-run text / picture-position patches. Legacy constraints describe
those patches only, not the full editor. Old verified history checkpoints cannot
nest and their total command budget remains 256.

## Host integration

Lazy import `PptxEditor` from `src/components/office/PptxEditor.tsx`.

```ts
{
  model, edits, onChange, readOnly,
  registerBeforeSave?: (flush: () => Promise<void>) => () => void,
  onPendingChange?: (pending: boolean) => void,
  onSaveRequest?: () => void | Promise<void>,
  onExport?: (file: {name: string; mime: string; bytes: Uint8Array}) => Promise<boolean>,
  onPrint?: (document: {html: string; title?: string; pageSize?: {widthPt: number; heightPt: number}}) => Promise<void>,
  onRenderPdf?: (document: {html: string; title?: string; pageSize?: {widthPt: number; heightPt: number}}) => Promise<Uint8Array>
}
```

Before saving, await the registered flush. It commits upstream active text/notes
and the operation queue; it rejects during IME composition. Pass readOnly while
saving or viewing historical content. On success replace model with the native
re-inspected result and clear edits. Internal save requests finish only with their
own host result, including void callbacks, rejection and missing integration.

Export waits for `onExport`: true means written, false means canceled. Only an
unhosted browser falls back to an anchor download. File-menu exports execute the
original renderer export actions: PNG slides are delivered as a zip. With
`onRenderPdf`, PDF uses the pinned upstream page HTML builder: exact vector SVG
pages, inline data fonts/images, original page dimensions and link overlays.
The returned native PDF bytes go unchanged to `onExport`. Without a render
callback, standalone PDF uses 2x raster pages and hyperlink annotations.
Both callbacks receive explicit physical `pageSize` in points (72 points/inch).
PDF and full-slide print use the current deck's EMU dimensions divided by 12700,
including custom sizes; fitted Canvas pixels never replace the source geometry.
The same dimensions govern the HTML. Handouts/notes retain the pinned A4 template
paper and orientation. Native hosts must apply the payload to their paper rectangle.

Print uses upstream print-only HTML for full pages, 2/3/6-up handouts and notes.
Slide images are data PNGs with slide fonts already rendered; CSS is inline and
notes use system fonts. No scripts, editor controls, blob URLs or external network
resources are required. `onPrint` is awaited. Only standalone browsing uses the
hidden print iframe's `contentWindow.print()`. Desktop print-panel verification
belongs to the native host; a browser pass does not prove WKWebView printing.

The isolated document follows actual host data-theme / .dark, computed app font
and color tokens. Document colors are not overwritten. Bounded scroll regions
have resize/content-aware continuous edge masks; reduced-motion is respected.
Duplicate AI/App-management chrome is removed. Browser-selected fonts use the
pinned sfnt parser, FontFace and a webview IndexedDB store; no mirror means no
download-only font actions, matching upstream's policy.

## Verification and current gaps

```sh
npm --prefix packages/office-pptx test
npm --prefix packages/office-pptx run test:ui
npm --prefix packages/office-pptx run check
```

Headless browser acceptance (no Tauri or visible window):

```sh
node packages/office-pptx/node_modules/vite/bin/vite.js \
  --config packages/office-pptx/test/ui/vite.config.mjs --host 127.0.0.1 --port 5189
OFFICE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
OFFICE_ACCEPTANCE_URL=http://127.0.0.1:5189 \
node packages/office-pptx/test/browser-acceptance.mjs
# Same environment for test/browser-resources.mjs, test/browser-layout.mjs,
# test/browser-fonts.mjs, test/browser-caret.mjs and test/browser-protocol.mjs.
# Run these sequentially:
# they intentionally share the fixture's real byte save/reinspect boundary.
```

See `docs/implementation/genoffice-parity-ppt.md` for the current matrix, exact
commands/results and outstanding acceptance. All upstream editing controls are
backed by real ops; mapped controls alone are not evidence of full acceptance.
Filled imported slides retain their real empty placeholder nodes and hide their
editor hint text, keeping content unobscured. Existing placeholders remain
selectable/editable; new empty layout slides retain prompts; actual placeholder
text remains visible and saved. The fixture really contains empty title/subtitle
shapes; this is an interaction adjustment, not a parser adding/removing shapes.
Ribbon scroll fades use a sibling overlay so fixed dropdowns remain visible and
clickable outside the scrollport; narrow nested layout menus have real pointer
regression coverage in both Chromium and WebKit.

Authorized local fonts now supply the pinned `OpentypeMetrics` with parsed real
advances, ascenders, descenders and hhea leading. IndexedDB reload waits for both
metrics parsing and FontFace loading before the first layout; local installation
rebuilds layouts without a document edit or history entry. Exports wait for font
work and fetch fresh layouts before SVG/PNG rendering. Missing faces/glyphs retain
the upstream heuristic fallback. No OS font paths are read by this adapter.

Remaining differences include standalone raster PDF, no cross-monitor audience window,
no native system/Office-private font discovery, missing-font heuristic fallback,
full upstream platform shaping/substitution not ported, and binary
`.ppt` being unsupported upstream. Browser system clipboard access depends on
webview permission; internal editable object/slide clipboard remains available.
These are recorded gaps, not a declaration that #191 is fully complete.

### Embedded presentation and host output

`presentationMode: 'preview' | 'edit'` retains the same upstream App, Canvas,
model and Undo history. Preview hides the editing ribbon/notes and forces the
native session read only; page navigation, ordinary slideshow and zoom remain.
File/save/autosave controls belong to the host filename row. The embedded
editing row contains Undo/Redo and the original editing tabs. Both modes use a
28px status bar, 12px text, 24px controls and a 100px zoom slider.

On the existing connected MessagePort, the host sends:

```ts
{source: 'project-mind-pptx-host', epoch, type: 'output', requestId,
 command: 'pdf' | 'images' | 'print'}
```

The renderer checkpoints text and waits for the operation queue as for `flush`,
then calls the live upstream App action. It replies:

```ts
{source: 'project-mind-pptx', epoch, type: 'output-done', requestId, error?: string}
```

PDF/images resolve after the existing output delivery completes; cancellation
resolves normally, failures reject through `error`. Print opens the original
PrintDialog and acknowledges that action; confirmation still sends the existing
`print-request` and awaits `print-finished`. Existing `render-pdf-request` /
`render-pdf-finished` and `export-request` / `export-finished` remain unchanged.
Old epochs are ignored and cannot acknowledge or deliver into a replacement File.

## Current selection bridge

`PptxEditor.registerSelection(controller)` registers the live iframe controller and
returns a cleanup callback. `captureSelection()` resolves to
`{selectionId, text}`; `text` is JSON containing the current slide index/path,
selected stable element IDs, element text and geometry. Capture requires selected
top-level elements in edit mode, with no active text/group editor or pending input.

`applySelection({selectionId, change})` accepts:

```ts
{elements: [{id: 'e_5', text: 'Revised text', x: 914400, width: 4572000}]}
```

All geometry uses integer OOXML EMU (914400 per inch), in slide coordinates;
optional fields are `text`, `x`, `y`, `width`, `height`. IDs must belong to the
captured selection. At most 256 elements and 50 native operations are accepted
(text and geometry count separately), matching GenOffice's atomic transaction
limit. Duplicate IDs, extra fields and unsupported text targets reject the entire
request. Text edits retain unchanged prefix/suffix run styling and use upstream
paragraph mapping for changed text.

A capture freezes its slide, IDs, epoch and document mutation version. Moving the
selection does not retarget it; any intervening document mutation (including
undo), File replacement or editor destruction invalidates it. Successful apply
consumes the capture, uses the original `slides:apply-txn` handler, updates the live
canvas and produces the existing candidate edit journal. One undo restores the
transaction. Saving remains the normal native File/CAS flow. Readonly/preview,
composition, active editing and busy states reject instead of queueing an AI edit
against unstable input. This bridge adds no model, chat or network image runtime.
