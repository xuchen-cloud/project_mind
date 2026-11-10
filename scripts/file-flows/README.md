# G13/G14/G15 isolated macOS acceptance

Work package: Issue #304. Base: combined `fbc0a3f` (includes the reviewed cf8 frontend,
2fb caller adapter, and File worker fixes). Depends on the production File commands,
schema 41, Markdown editor, and the existing `office-performance` host.
Apply this harness commit to the main agent's latest combined checkout before the
coordinated build, so later Record, directory-hook, Office, and worker-license fixes
are included. This worktree does not rebuild those dependencies independently.

Deliverable: an opt-in page and runner using a real `main` Webview, native IPC,
SQLite, `ProjectContentWorkspace`, `ProjectFileContent`, editor registration, and
the production move/drop/metadata services. No native responses are replaced.

The runner creates a fresh directory below macOS temporary storage. Workspace,
app-data, assistant data/profile, generated inputs, and reports all stay there.
The host uses the existing incognito measurement Webview; `HOME` is unchanged.
It rejects an existing
output directory and a binary without the opt-in host marker. Only the generated
`incoming/replacement.md` can be sent through the real source Trash flow. No user
Workspace, credentials, source file, or application data is accepted as input.

## Execution (launch only when coordinated by the main agent)

The existing measurement build must include this checkout's frontend:

```sh
cd /tmp/project-mind-review-flow-native-acceptance
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
  env OFFICE_PERFORMANCE=1 CARGO_INCREMENTAL=0 npm run tauri -- build \
  --debug --no-bundle --features office-performance
```

This uses the repository's normal desktop resource preparation. A prebuilt
measurement binary with the same frontend may be supplied instead. The runner
does not build. It requires macOS and Node 22+; Python 3 reads only the fresh
fixture SQLite database. Do not point it at a shipping binary.

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
  node scripts/file-flows/native-run.mjs \
  --binary=/absolute/path/to/office-performance/project_mind_alpha
```

Optional `--out=/tmp/unique-new-directory`, `--hold=15` (seconds after report), and
`--timeout=180000` (milliseconds). A report with all required assertions and no
runtime errors is required for exit 0. `acceptance.json`, `native.log`, and the
isolated fixtures are retained. A timeout, missing assertion, unexpected error,
or failed native operation exits nonzero. A caught page failure submits its partial
report; a startup failure or hang may leave only logs and fixtures. The report
records the binary hash and harness checkout SHA separately; it does not infer
the binary's source revision from the checkout.

## Assertions and limits

- G13 save failure: a real second working session advances revision; the original
  dirty editor then hits native CAS. Its Tab, renderer, draft, and original session
  remain, with no move submission.
- G13 commit failure: native move receives a stale version after real target flush;
  the target Tab/session remains and the release event unlocks it.
- G13 success: the production move service saves the dirty target, flushes its
  actual registered instance, closes only its source Tab, keeps File ID, and leaves
  the saved text under the new owner with its old working session ended.
- The unrelated editor remains dirty and keeps the same session/DOM/text/native
  revision throughout. Scripted composition events keep its genuine pending-input
  state active so its own 1200 ms autosave does not confound the target-only check.
- G14: the production drop batch replaces the same open File; the same Tab remains,
  the old session ends, a new session opens, and replacement bytes render. Saved
  pending text is retained as an immutable version.
- G15: actual version-menu controls update name/importance; a native reread and
  read-only SQLite snapshot verify metadata, unchanged immutable identity/hash,
  and the same working session and renderer.

Inputs use CodeMirror's real transaction API and DOM controls. This is **one-window
component + IPC acceptance**, not OS keyboard/IME or drag hit-testing evidence.
Not covered: multiple windows / multiple target instances, Record movement,
DOCX/XLSX/PPTX active cells, native drag coordinates, cross-volume cleanup, injected
disk failure/crash recovery, Windows, or full application startup. No claim of
complete Issue acceptance follows from this harness.

## Verification status

Passed during preparation:

```sh
node --check scripts/file-flows/native-run.mjs
node --test scripts/file-flows/contract.test.mjs   # 2 collector/entry checks
python3 scripts/file-flows/snapshot.test.py       # 1 synthetic collector check
git diff --check
```

These validate only the runner, evidence contract, opt-in entry and SQLite reader.
The synthetic collector fixture is not native API or application evidence.
The targeted TypeScript check was cancelled while waiting for the shared build
lock; it has not run. Run it in the coordinated preparation step:

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
  ./node_modules/.bin/tsc --noEmit -p scripts/file-flows/tsconfig.json
```

No native build, IPC acceptance run, or GUI launch has been performed during
harness preparation. A successful future `acceptance.json` establishes one-window
real component/native IPC behavior driven programmatically. It does not establish
OS input, visual observation, cross-window behavior, or full application acceptance;
the main agent must record actual window observation separately.
