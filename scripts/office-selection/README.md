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
