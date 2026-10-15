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
