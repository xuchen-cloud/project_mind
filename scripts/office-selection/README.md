# #212 native Office selection acceptance

This opt-in harness uses an isolated Workspace, the actual `ProjectFileContent`
(and its `OfficeFileContent` toolbar), original Office editor, native selection
register/bind/claim/reply commands, real native-owned DSH Node process and File
save/readback. Only the local model provider is deterministic. It sends an actual
`office_selection_edit` tool call through DSH. No fake editor apply or native
source responder is installed.

## Opt-in entry

`scripts/office-performance/native.html` loads `../office-selection/entry.ts`. This dispatches
`page: 'office-selection'` to this harness and all other configurations to the
existing performance page. No Rust routing changes are needed: the existing
`office-performance` feature routes non-app/non-startup pages to native.html.

Use the existing build configuration that includes native.html and Cargo feature
`office-performance`, with built Office packages and DSH runtime/resources. An
ordinary application binary without that feature cannot run this harness.

## Run (launches GUI)

From repository root, after building and informing the user about the native window:

```sh
/opt/homebrew/bin/node scripts/office-selection/native-run.mjs \
  --binary=/absolute/path/to/measurement-build \
  --format=docx \
  --out=/absolute/path/to/new-empty-parent/selection-run
```

The output directory must not exist. The runner reuses the existing performance
setup command to create the isolated Workspace and Performance project, copies
the selected format's committed fixture into that project's directory, then launches the native
selection page. It configures only the isolated Workspace's default model to the
local fixture provider. The isolated Session explicitly selects `workspace-write`
through the existing permission command. Reports contain synthetic fixture text and IDs.
The output directory is canonicalized before setup because SQLite's NOFOLLOW
requires canonical parents (macOS `/tmp` aliases `/private/tmp`).

The page uses the real Word DOM selection, Excel name box or PPT canvas, then clicks
`引用选区`, observes the produced bound Session reference, prepares it over the real
Tauri DSH transport, and sends it through actual Session prompt RPC. It checks the
provider receives `editor_draft`, `saved:false`, and Word's `tracked:true`, observes real
native claim/reply commands, then saves via the normal toolbar (or observes normal
autosave) and verifies a newer File version by native Office inspect.

Evidence: `selection-result.json`, `selection.log`, and existing setup reports.
A missing entry, unavailable runtime, denied claim, save failure, provider error,
or readback mismatch fails instead of claiming acceptance. The harness is a native
File shell, not acceptance of the full chat composer or complete application UI.

Run each of `--format=docx`, `--format=xlsx`, and `--format=pptx` serially in separate
output directories. Word additionally verifies persisted insertion/deletion XML;
Excel verifies B3's value, B4's formula and untouched cells; PPT verifies e_5's text
and untouched text/image geometry witnesses.

## Implementation-only checks

`node --check scripts/office-selection/native-run.mjs` and the provider fixture test
can run without GUI. Passing these does **not** establish native acceptance.

## Acceptance — 2026-10-23

All three formats passed on macOS arm64 using the real native File shell and DSH
transport described above. Each saved File version 1 as version 2. Word additionally
unmounted/reopened the full editor and verified insertion/deletion XML with author
`Project Mind AI`; the inspect model's plain editable-node list intentionally omits
paragraphs with revisions. Excel preserved non-target cells and persisted the new
value/formula; PPT preserved non-target text and image geometry.

Native acceptance exposed and fixed the prepare endpoint allowlist and an Excel
stale-selection bug: delayed `fromFormula` cache mutations now follow the existing
save journal's exclusion rule. User edits and structural mutations still invalidate
captures. The existing Workspace symlink-parent save failure is tracked separately
in [#218](https://github.com/xuchen-cloud/project_mind/issues/218).

## Full application Office acceptance — 2026-10-23

The ordinary macOS application bundle (without the harness feature) was also
tested through its actual project file list, Office toolbar, split view and DSH
chat composer. An isolated Workspace used the deterministic local provider above;
this verifies the real application/tool transport, not external model quality.

- Word: selected `春风拂面`, quoted it into the composer, requested replacement,
  observed tracked changes, then undo/autosave and redo/autosave. Version 4 reopened
  with the replacement and `Project Mind AI` insertion/deletion XML. Version 1 was
  read-only and retained the original text; embedded media bytes were unchanged.
- Excel: captured B3:B4, moved the live cursor to D2, and sent the composer request.
  B3 became 25 and B4 became `=B3*3` (75); D2 remained empty. This exposed an
  autosave remount that cleared undo. The fix passes an exact native save receipt
  and reuses upstream undo-carry in the same iframe. The rebuilt app preserved D2
  after autosave; native undo saved 10/20, redo saved 25/75, and version 4 reopened
  correctly. Other formulas, percentage formatting and multiline text remained.
- PPT: quoted the selected image-caption text box, changed it through the composer,
  then undo/autosave, redo/autosave and reopen. Version 4 retained the replacement,
  three slides, other text and the original image bytes.

The Excel save fix also passed a real browser/native-byte roundtrip for AI and
manual edits, four affected browser tests and 40 host tests. External model
replacement still rebuilds the iframe and rejects old selections. The reused
upstream undo-carry does not carry worksheet add/remove/rename history across
save; this acceptance covers selected-cell value/formula editing.
