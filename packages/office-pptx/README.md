# Office PPTX

Production format adapter for #118. `inspect` and `edit` consume bytes only; they
never write business files, upload or save a File version. The host owns CAS,
saving, lazy component loading and rebase. Production has no dependency on a
validation harness, temporary directory or workspace absolute path.

## Build and deployment

```sh
npm --prefix packages/office-pptx ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/office-pptx run build
```

All 82 required public core sources are vendored **unmodified** at GenOffice
`d32d1711f1bf985430757b8c6b3fbddd3831d946`. Every build verifies Git blob SHA-1 and
length using `source-lock.json`. No fetch is required for a normal build. The
optional `npm run sources:fetch` restores the exact pinned files, with integrity
verification. `package-lock.json` locks the package's own npm closure.

Copy the complete `dist` to `office-dist/pptx/`. The host's top-level
`pptx-engine.mjs` can re-export `./pptx/engine.mjs`:

- `dist/engine.mjs`: self-contained Node ESM, only Node builtin imports, no
  accompanying runtime resources. Includes GenOffice parsing/render geometry and
  the guarded ZIP loader. Node 24+ is the intended runtime.
- `dist/browser.mjs`: browser ESM containing actual `pptx-render` layout and the
  thin React SVG adapter; only `react` and `react/jsx-runtime` stay external so
  Vite can reuse the host React instance. No root aliases are needed.
- `dist/THIRD-PARTY-NOTICES.txt`: original Apache/Unicode/MPL notices and all
  bundled npm runtime attributions. Source `LICENSE`, `NOTICE`, vendor MTX
  license and the pinned Nodable MIT license are retained in this package.
- `dist/*.d.mts`: declarations import only this package's public DTOs and React
  types. Public `types.ts` never imports SDK types or source implementations.

## Contract

```ts
inspect(bytes: Uint8Array): Promise<PptxModel>
edit(bytes: Uint8Array, edits: PptxEdit[]): Promise<Uint8Array>
```

`PptxModel` contains `format: 'pptx'`, slide size/order, original hash, complete
serializable slide payloads, `renderSlides`, data URL media, `textElements`, and
`pictureElements`. Render payloads are opaque to the host; the browser layer
owns their SDK interpretation. All exported element/render IDs are stable.

Edits use zero-based `slideIndex` plus the original numeric **string** `cNvPrId`.
Text edits additionally address the existing zero-based paragraph and run:

```json
[
  {"kind":"text","slideIndex":0,"cNvPrId":"5","paragraphIndex":0,"runIndex":0,"text":"中文修改"},
  {"kind":"move-image","slideIndex":0,"cNvPrId":"7","x":960120,"y":2560320}
]
```

Image coordinates are absolute EMU. Multiple targets, multiple paragraphs and
repeated edits to the same target are applied in order. The last edit to a run or
picture position wins. Reopen returned bytes before editing the new baseline.
No process-local `sp_*`/`pic_*` ID is stored or accepted.

Plain text changes only the original `<a:t>` payload, preserving `<a:rPr>`,
paragraph/body properties, extensions and inheritance. Position edits only
replace the original picture `<a:off x/y>` attributes. All other actual ZIP part
bytes remain unchanged, including notes, masters, themes, chart XML, embedded
workbooks and media. Empty edit lists return the original bytes unchanged.

The input boundary rejects non-byte input, invalid edit object/field types,
invalid Unicode/XML characters, malformed UTF-8/XML and out-of-range image
coordinates. Source XML encodings other than UTF-8 are explicitly unsupported.
Fields, math, structural text changes/newlines, grouped objects, table/chart
edits and images lacking an original position reject without flattening.

## React integration and design

Lazy import the named `PptxEditor` from
`src/components/office/PptxEditor.tsx`; it re-exports `PptxModel`/`PptxEdit`.
Props: `{model, edits, onChange, readOnly}`. Edits stay relative to the model's
baseline. The host replaces `model` and clears `edits` after successful save;
the component resets local selection/undo history for that new model. During
saving or historical viewing, pass `readOnly=true`. No component persistence.

The frontend-design reference in `docs/design/office-editor-direction-20261013.md`
governs the shell: actual app color/font tokens, 28px controls, small undo/redo
toolbar, 156px slide thumbnails, proportional document canvas and 226px object
inspector. The inspector becomes collapsible in narrow containers. Original
document colors/fonts are never replaced with host theme tokens. Bounded regions
reuse `HomeSidebarList` and its continuous, resize-aware fades.

GenOffice core exposes **RenderTree**, not a native React editor or shell theme
API. The package's ReactSvgSlide is a thin draw adapter over that actual tree,
covering shapes, pictures, groups, tables, chart primitives and unsupported-object
chips. `buildRenderSlide` exposes `fitWidthPx`, `metrics`, `media` and `slideNo`;
font metrics can be customized inside the package. Shell tokens and selection
stroke are customizable independently; they are never written to OOXML.

Preview uses heuristic font metrics/system fonts. Advanced 3D/WordArt/shadows,
complex pattern/gradient/image effects and EMF/WMF decoding are not full-fidelity
rendered. The original bytes are preserved. This package does not claim pixel
equivalence to PowerPoint or delivery of the host File/CAS integration.

## Verification

```sh
npm --prefix packages/office-pptx test
npm --prefix packages/office-pptx run test:ui
npm --prefix packages/office-pptx run check
```

Tests use two real, generated PPTX fixtures with checked source hashes; verify
two successive save/reopen cycles, multiple pages/targets, multi-run/multi-paragraph
rich text, image moves, preservation of unedited actual parts, explicit rejection
and bundle relocation. UI tests use real inspection/render output, Chinese input,
readOnly, rebase, undo/redo and continuous bounded scroll fades.

For a headless component screenshot (no Tauri), prepare the real model and serve
the isolated harness, using the existing host style dependencies:

```sh
cd packages/office-pptx
node test/ui/prepare.mjs
node_modules/.bin/vite --config test/ui/vite.config.mjs
```

Actual screenshot evidence is under `output/playwright/`; it exercises this
component rather than the full app or the illustrative design reference.
