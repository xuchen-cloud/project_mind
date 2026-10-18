# Shared editor chrome

- `StatusZoom.tsx`: the single zoom markup/behavior entry. Values are whole percentages (range step 1); `step` is the default button increment, `onStep` preserves native button commands and `onValueClick` preserves zoom dialogs. Existing `.zoom-*` aliases remain.
- `status-bar.css`: 28px status geometry, 24px zoom controls, 100px range, explicit 2px rail / 10px thumb. Theme uses `--editor-chrome-*`; import after format CSS.
- `editor-chrome.css`: toolbar/tab/menu paint and tokens. Office uses marked ribbon/header roots; Markdown uses `.pm-editor-toolbar/.pm-editor-tool/.pm-editor-mode/.pm-editor-separator` (28px tools, 16px icons). Only Office ribbons use 80px height. Existing fades consume `--editor-chrome-fade-size` / `--editor-chrome-fade-block-size`.
- `build-adapter.mjs`: pinned JSX AST seam; fails when the original four zoom nodes change. No vendor files are edited.

Consumers: Word `office-docx/renderer-build.mjs`; Excel `office-xlsx/scripts/build-renderer.mjs`; PPT `office-pptx/parity-{text-edit-,}build.mjs` + `build-parity-frame.mjs`; Markdown `src/components/markdown/MarkdownEditor.tsx` imports the component and both CSS files directly. Complex galleries, layout/format panels, menu positioning and native zoom models remain format specific.
