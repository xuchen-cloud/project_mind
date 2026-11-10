# Markdown table command undo diagnosis

This work package follows the unified build cleanup review (Draft PR #316, Markdown #191 / parent #118), based on combined `d178def233beb41f7b09e3747fd9aa9079ac6cc9`. It investigates the package editor suite's second table-command undo returning four rows instead of three. Two integration suite runs failed while a baseline single-test run passed; this was not evidence of a stable baseline defect.

Scope is the proven cause in rich Markdown value/history synchronization and the existing editor regression file. Preserve row/column undo and redo assertions and read-only behavior. No WaveDrom changes, editor redesign, native work, dependency installation, GUI, subagents or push. Integration owns final review and merge.

Acceptance: a discriminating red reproduction, a minimal supported fix, the original editor suite plus the new regression, affected Markdown suites, root and package TypeScript checks, and Standards/Spec self review. Heavy commands use the shared `with-build-lock.py`. Dependencies are CoW copies of the integration cache, with both root file-package links rebound to this worktree. Node `v24.22.1` is reused from the existing Codex runtime. No watchers were present before editing.

## Cause and fix

The original 21-test suite reproduced **20 passed / 1 failed** in this isolated tree. The unchanged target test alone passed. A lightweight transaction trace then showed normal history depth increasing to three after table insertion, row insertion and column insertion. The first undo correctly removed the column and left two undo events. A delayed passive value effect then loaded the previous four-column local echo over the now-three-column document and recreated `EditorState`, clearing history. The following three-column echo loaded again. The second undo therefore had no row-insertion event left to undo.

The value trace directly captured both stale loads. Neither needed a new `documentKey`, an external document replacement, an appended history transaction, nor an earlier test's state. A single-test regression pins the same ordering: a host layout effect dispatches the first real Undo button click after the column edit commits but before passive effects. It reproduced the exact second-undo row-count failure twice without preceding tests. Native `click()` avoids nesting Testing Library's `act` inside React's commit; schema commands, context menus, serialization and history remain real.

The production fix changes only the existing incoming-value reconciliation from `useEffect` to `useLayoutEffect`. It checks a committed local echo before another input can advance `source.current`. Actual external values and `documentKey` changes still use the same content load and history reset; no values are ignored by a new cache, queue, debounce or retry. The original row/column undo, redo and read-only test is unchanged. The additional regression retains both row/column undo and redo expectations.

The earlier intrusive logging probe delayed the race and also caused its own cleanup lookup error; a buffered version passed and was not treated as a fix. The smaller transaction probe and load probe captured the actual failure. Initial scheduler harness attempts nested `fireEvent`/`act` in a layout effect and timed out before their intended assertion; those are diagnostic harness failures, not product regressions. All temporary `[DEBUG-md-undo]` instrumentation was removed.

## Reproduction evidence

All test commands use this prefix, from `packages/markdown-editor` unless specified otherwise:

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py \
  /Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
```

- Original suite: `../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/editor.test.tsx --reporter=verbose`; **20 passed / 1 failed**, `/tmp/project-mind-markdown-undo-suite-red.log`.
- Original single test: same command with `-t 'performs actual rich table row/column context commands'`; **1 passed / 20 skipped**, `/tmp/project-mind-markdown-undo-single-baseline.log`. This distinguishes the observed timing dependence without declaring a stable baseline defect.
- Minimal transaction and incoming-value traces: same full-suite command; both reproduce **20 passed / 1 failed**, `/tmp/project-mind-markdown-undo-minimal-probe.log` and `/tmp/project-mind-markdown-undo-load-probe.log`.
- Pinned single regression: same command with `-t 'keeps table history when undo precedes'`; **0 passed / 1 failed / 21 skipped** twice, `/tmp/project-mind-markdown-undo-pinned-click-red.log` and `/tmp/project-mind-markdown-undo-pinned-click-red-confirm.log`. Both fail at the second Undo with expected three rows / actual four.

## Final verification

- Pinned regression after the fix: the identical filtered command, **1 passed / 21 skipped**, `/tmp/project-mind-markdown-undo-pinned-green.log`.
- Package affected suites: `../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/editor.test.tsx tests/image-async.test.tsx --reporter=verbose`, `/tmp/project-mind-markdown-undo-package-affected.log`. The complete editor suite passed **22/22**, including the original unmodified undo/redo/read-only scenario. Image tests initially passed 16/18; the other two stopped at `mkdtemp` because the new worktree lacked their expected `packages/markdown-editor/output/` parent directory. After creating that ignored directory, only those two were rerun with `tests/image-async.test.tsx -t 'keeps current (rich|source) paste pending'`: **2 passed / 16 skipped**, `/tmp/project-mind-markdown-undo-package-image-retry.log`. Their existing byte-save/reopen assertions passed without source/test changes.
- Root affected suites, from repository root: `node_modules/vitest/vitest.mjs run src/components/markdown/MarkdownEditor.test.tsx src/components/markdown/RichMarkdownEditor.contextMenu.test.tsx --maxWorkers=1 --reporter=verbose`, **30/30**, `/tmp/project-mind-markdown-undo-root-affected.log`. This includes delayed clipboard cancellation across document/read-only/selection/unmount changes.
- Package typecheck, from root: `node_modules/typescript/bin/tsc --noEmit -p packages/markdown-editor/tsconfig.json`, exit **0**, **0 diagnostics**, `/tmp/project-mind-markdown-undo-package-tsc.log`.
- Root typecheck: `node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`, initially exit 2 with five TS2307 missing generated Office-module diagnostics, `/tmp/project-mind-markdown-undo-root-tsc.log`. The three Office package sources matched combined with no local changes; their existing `dist/` caches were CoW copied into this tree, without build/install/source changes. The same locked root command then exited **0**, **0 diagnostics**, `/tmp/project-mind-markdown-undo-root-tsc-final.log` (empty successful compiler output).
- Final coverage is **70 distinct passing tests**: package editor 22, package image-async 18, root Markdown/context-menu 30. The earlier single-test checkpoints are not counted again. No remaining failed or unexecuted cases in these four suites; filtered diagnostic/retry skips are not acceptance gaps. Final test logs contain no warning or stderr sections.
- `git diff --check` passed. No temporary debug probes remain. Full logs are retained at the exact paths above; `/tmp/project-mind-markdown-undo-validation-results.json` records completed commands and their exit codes, including initial environment failures.

## Self review and limits

Standards: **0 remaining findings** in this work package. The production change adjusts one existing synchronization boundary and preserves its checks; it adds no new state/cache, timer, compatibility branch or generic framework. Tests pin the observed ordering through the real public editor and preserve the original assertions. Temporary instrumentation and harness errors are not presented as verification success.

Spec: **0 remaining findings** in this work package. Two successive undo operations and two redos preserve the expected row/column states. Ordinary local echoes keep history; actual external values and same-text `documentKey` replacements retain their existing reset behavior. Read-only and async image/clipboard cancellation regressions pass. No WaveDrom implementation, dependency or entry point was changed.

This is self review only; no subagent or independent approval is claimed. Execution covers macOS Node/jsdom and static TypeScript checks, not GUI/browser/WebView behavior or Windows/Linux platform acceptance. No Cargo, application launch, dependency installation, push or merge was performed. Main owns final fixed-SHA review and integration. The rest of the repository suite was not rerun.
