# DOCX progressive view — Issue #303 / G04, G09

## Work package

- Scope: `packages/office-docx/**` on shared `codex/review-office-progressive`; no commits or branch changes.
- Dependencies: native GUI/historical reads call `inspectView`; full `inspect` remains the authoring API. Native source identity, CAS, journals and receipts remain the enclosing File service's responsibility.
- Delivery: editable initial body, bounded on-demand parsing/conversion/append, complete original archive plus cumulative live PM edits as the save authority, existing full editor and 50%–150% zoom.
- Non-goals: native/shared host changes, other Office formats, Windows acceptance, replacing the full editor.
- Acceptance: unloaded tail does not block initial editable body; saving first-screen edits materializes the missing body and appends to the live document; two saves and reopen preserve both edits, tail and untouched OOXML/media/relationships.

## Implementation

`inspectView` returns a normal `DocxModel` with complete `sourceBase64`, SHA-256 `baselineHash`, and `coverage: {kind, partial, loadedBlocks, sourceHash}`. It omits the optional full authoring summary. The complete metered ZIP admission and fatal XML/rels UTF check run before OOXML normalization, followed by styles/numbering/protection/notes/fonts/header metadata and initial body conversion. This full ZIP/metadata work remains a lower bound; this change does not claim constant-time opening independent of archive size.

`progressive-build.mjs` provides checked build transformations of the fixed source. No pinned upstream/source-lock bytes are changed. The parser keeps its original complete package, XML offsets, relationships and block-building context. It builds 64 initial top-level elements, preserving SDT and field-code dependencies; subsequent requests build 128 elements. Cached field results such as a long TOC can cross batch boundaries. Table media and external textboxes are decoded for the requested batch. Section settings and stable raw drawing ranks are metadata and can be read before body conversion.

The renderer owns one session. It appends newly converted nodes to the current editor; it does not remount the original prefix after an asynchronous read. Near-end scrolling and viewport underfill request another batch. Global commands, saving and output have a full-content barrier. A clean background recovery tick does not request missing content. The barrier includes an in-flight final read, PM append and React metadata commit; errors and cancellation reject saving. The existing streaming tail guard protects the append boundary and preserves ordinary typing/undo in the prefix.

Success receipts advance the host baseline hash; the parser's original source and the cumulative live document remain fixed within that renderer session. A later snapshot therefore includes earlier saved edits. External replacement/disposal cancels the old session. Unmodified parts are copied by the original patch serializer.

### Changed files

All paths below are relative to this DOCX package. Existing G09/Windows portability changes were retained; the pre-existing `test/browser-presentation.mjs` change was not edited by this package owner.

| Area | Files |
| --- | --- |
| Public view API and build | `engine.ts`, `types.ts`, `build.mjs` |
| Progressive parser/session | `progressive.ts`, `progressive-state.ts`, `progressive-build.mjs` |
| Full renderer integration | `progressive-renderer.ts`, `renderer-build.mjs`, `renderer-host.ts`, `secure-extensions.ts` |
| Real regression and fixtures | `test/progressive.test.mjs`, `test/fixtures/progressive.mjs` |
| Headless real renderer | `test/browser-progressive.mjs`, `test/progressive-harness.ts`, `test/progressive-server.mjs` |
| Existing boundary tests | `test/renderer-host-scheduling.test.mjs`, `test/windows-renderer-hooks.test.mjs` |
| Package handoff | `PROGRESSIVE.md` |

## Verification

All heavy commands run under:

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py COMMAND...
```

Node tests use `--test-concurrency=1`; no watch or visible GUI is started. Focused regressions use real ZIP/parser/converter/serializer operations, with 320 appended paragraphs and opaque XML/media/relationships. `DOCX_RED_BASELINE=1` exercises the preserved full `inspect` as the old GUI path and must fail the unloaded-tail assertion; a missing build module is recorded separately as a setup failure.

The opt-in `test/progressive-server.mjs` and `test/browser-progressive.mjs` use the actual full renderer, inspectView and real engine save bytes. Metrics begin at navigation and observe visible body text and editable content, with a subsequent real keyboard edit. They are desktop headless browser measurements, not Tauri/native IPC timings or Windows acceptance.

### Executed on 2026-11-10

- `node packages/office-docx/build.mjs`: passed; all 519 pinned sources and print-font provenance checked. Generated `engine.d.mts` exports `inspectView`; `types.d.ts` includes the coverage projection.
- `env DOCX_RED_BASELINE=1 node --test --test-concurrency=1 --test-name-pattern=inspectView packages/office-docx/test/progressive.test.mjs`: expected failure, 0/1 passed. The old full GUI path contained the tail before returning. Log: `/tmp/mind-docx-red-functional.log`.
- The first targeted run against the initial build passed 12/16. Its genuine failures exposed deletion of untouched image relationships, malformed Strict UTF accepted after normalization, long TOC over-parsing, and cross-batch image ranking. They were fixed without weakening the assertions. Log: `/tmp/mind-docx-focused-green.log` (historical name; this run was **not** green).
- `node --test --test-concurrency=1 packages/office-docx/test/*.test.mjs`: final **50/50 passed**, including all four failures above, two cumulative saves/reopen, complete untouched entries, authoring-summary hashes, clean recovery ticks, output error propagation, IME/late edits/receipt scheduling and actual Windows-path build-transform dispatch. This dispatch check is not a Windows runtime acceptance. Log: `/tmp/mind-docx-all-tests.log`.
- `node packages/office-docx/test/browser-progressive.mjs` against the opt-in progressive server: real Chromium and WebKit headless **both passed**. Each observed an editable 64-block prefix before the unvisited tail, performed two saves against evolving File baselines in the same editor, reopened the saved bytes, compared every untouched archive entry, and switched preview/edit. Errors were empty. Server was stopped. Log: `/tmp/mind-docx-browser-progressive.log`; structured local evidence: `test/output/browser/progressive-results.json`.
- `git diff --check -- packages/office-docx`: passed.

| One navigation sample, 1440×1000, macOS arm64 / Node 26.8.1 | First visible content | First editable content | Real keyboard edit confirmed | Parsed blocks at readiness |
| --- | ---: | ---: | ---: | ---: |
| Chromium headless | 497.8 ms | 497.8 ms | 536 ms | 64 |
| WebKit headless | 581 ms | 581 ms | 617 ms | 64 |

These are single navigation samples including the test HTTP model fetch and renderer startup, with no cache-clearing or percentile claim. They do not include native working open, IPC, CAS or platform filesystem cost and cannot be compared directly with the older Tauri cold-open measurements. The fixture adds 320 paragraphs to the real simple DOCX and includes opaque parts and unused media/relationships. Large indivisible tables/SDTs and field-code dependencies can exceed the nominal initial element limit. ZIP/UTF admission, metadata, notes and embedded font preparation still precede first content.

The internal gpt-6.1-sol Standards/Spec review identified seven risks: pre-normalization UTF, a final-read/append save race, image ranks, TOC field results, alternate FindPanel entry points, clean recovery over-parsing and swallowed output failures. All were corrected before the final build/test/browser run. The race now waits any in-flight read and checks fully mounted content after append and metadata commit. The final independent two-axis review belongs to the integrating agent's exact commit.

Final artifact SHA-256:

- `dist/engine.mjs`: `3b85a193164f22719e90437cf185bfcb3a1b5b76f2c03a8038da82c7dfe1d89d`
- `dist/renderer.mjs`: `454853d70afb52603c7c0cbc123d7ac1c14e76a2cb6696129a22915dc3b8be79`
- unchanged `source-lock.json`: `8e1c6fac9b5dc5ce8d2d72fd234d95d768bc0d79a5aaed6ba4dac48d30df90d4`

No native GUI, Windows runtime, Cargo, shared host edits, commit, branch switch or publication was performed by this package owner. Native working/CAS/receipt integration and visible platform acceptance remain with the integrating agent. Temporary logs live under `/tmp/mind-docx-*`; no red logs are product test inputs.
