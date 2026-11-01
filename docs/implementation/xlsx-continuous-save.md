# XLSX continuous save

The editing model and its renderer source remain fixed for a workbook session. Every gateway journal is cumulative against those original bytes. Persisting a candidate must use those same original bytes; native CAS independently checks the latest working file. Changing only a source hash is not a rebase.

`onChange(edits, {editRevision})` reports each changed serialized snapshot, including an empty journal after undo to the original source. `savedEditRevision` confirms only the captured renderer revision. The host must preserve the model and cumulative edits on receipt. A different model always opens a new iframe/workbook. Renderer revisions belong to that mounted model session.

Save receipts do not change the ready promise, workbook unit, journal, selection or undo history. Ordinary updates avoid repeating `setEditable` when permission has not changed: repeating it cancels an active cell editor even if the same boolean is supplied.

## Verification

`save-undo-browser.test.mjs` uses the production renderer, real headless Chromium and native XLSX engine. Its writer repeatedly runs `edit(originalBytes, cumulativeEdits)` then `inspect(savedBytes)`. Ten saves cover formula edits, AI and manual undo, delayed persistence while a new cell input remains active, old receipt delivery, committing that late input, row insertion, a further edit/save, and a nonzero scroll position. Every receipt checks the original underlying Workbook identity and ready promise. Active input focus and scroll state survive the delayed receipt. An actual model replacement still opens a new frame and rejects the old selection.

The test first failed on the old bundle because save snapshots had no revision. The active-input case also exposed unconditional permission resets; preserving the workbook alone did not preserve uncommitted input. Build uses `npm --prefix packages/office-xlsx run build -- --skip-native` and never starts the native app or rebuilds its Rust code.
