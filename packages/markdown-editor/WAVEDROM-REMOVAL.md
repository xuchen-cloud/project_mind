# WaveDrom removal — #308

User-authorized scope, 2026-11-11: remove waveform, register and logic diagrams
from Record/Markdown; keep Mermaid (all existing diagram types), math, and user
source. [Issue #308](https://github.com/xuchen-cloud/project_mind/issues/308).
Worktree: `/tmp/project-mind-review-wavedrom-cleanup`, branch
`codex/review-wavedrom-cleanup`, base `0cdf9ab`.

The earlier renderer-only proposal was withdrawn before delivery. Its files and
validation logs are archived locally under
`output/playwright/wavedrom-cleanup/renderer-only-history/`; they are not shipped.
In particular, its shipping minifier removed the embedded license comment, so
that abandoned proposal is not claimed as a completed license solution.

The main thread's type-only/test-query cleanup `d178def233beb41f7b09e3747fd9aa9079ac6cc9`
was cherry-picked as local prerequisite `481588a`. Integration should take only
the subsequent WaveDrom removal commit; the prerequisite is already on main's
integration branch.

## Consumer inventory and resulting behavior

- Markdown toolbar and slash insertion: remove the WaveDrom template/button,
  waveform slash item and 21 localized labels. Mermaid, math and ordinary code
  insertion remain available. The toolbar now has 12 buttons instead of 13.
- Rich code, safe preview and export preparation: only `mermaid` is classified
  as a diagram. Existing `wavedrom` fences, including invalid or empty content,
  use ordinary code paths. No WaveJSON parsing, SVG, error UI, migration or source
  rewrite is performed. BOM/CRLF and edits retain the original fence language.
- DOCX: narrow the language-only adapter and declaration to Mermaid and rebuild
  the existing fixed-source DOCX bundle. Former WaveDrom content is exported as
  code text, with no diagram callback or generated image.
- Print/PDF preparation: remove the WaveDrom-only local-use geometry expansion.
  Former WaveDrom blocks remain code in the same HTML preparation shared by
  native print/PDF and browser raster exports. Generic SVG resource checks and
  local symbol support remain for Mermaid.
- Record: its rich code and export routing already classify only Mermaid as a
  diagram. Regression tests now explicitly include the `wavedrom` language as
  ordinary code. Removing the shared renderer branch also removes WaveDrom from
  the Record worker dependency graph.
- Dependencies: root `package.json` and lock drop WaveDrom and JSON5. Resolve the
  lock's dependency/optional/peer edges and prune their 25 exclusive package
  entries, including bit-field/logidrom/onml/tspan and their unused CLI helpers.
  No remaining lock edge points to a removed entry. Shared sax/xml-js and
  graceful-fs/enhanced-resolve stay. Other package locks contain no WaveDrom
  dependency and are unchanged. No installation or node_modules product patch.
- Source provenance: the original 93 upstream files and source hashes remain
  unchanged. `sync-upstream.mjs` explicitly excludes the renderer and ambient
  type file, removes the slash item/labels and narrows the local diagram adapter.
  `--check` rejects a reintroduced generated renderer/type. Historical acceptance
  records are marked superseded, not rewritten as new evidence.

Non-goals: general bundle splitting, vendor-size warning removal, unrelated
export/menu/table fixes, native staging, cargo, GUI, installation or publishing.

## Exact verification commands and results

All generation, test, typecheck and build subprocesses used Node **24.21.0**:
`/tmp/project-mind-review-combined/packages/agent-host/runtime/darwin-arm64/node`.
Each was serialized by
`python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py`.
The serial Python runners invoked that executable with the arguments below;
`node` here denotes that exact path, not PATH's Node. Logs are in the ignored
`output/playwright/wavedrom-cleanup/` directory. CoW dependencies and pre-existing
Office dist copies are local; file-package symlinks point to this worktree.

From `packages/markdown-editor`:

```sh
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/wavedrom-removal.test.tsx --reporter=json --outputFile=../../output/playwright/wavedrom-cleanup/removal-red.json
node sync-upstream.mjs
node build-exports.mjs
node --test tests/diagram-build.test.mjs
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/wavedrom-removal.test.tsx tests/preview-diagrams.test.tsx tests/mermaid-theme.test.tsx --reporter=json --outputFile=/tmp/project-mind-review-wavedrom-cleanup/output/playwright/wavedrom-cleanup/removal-focused.json
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --reporter=json --outputFile=/tmp/project-mind-review-wavedrom-cleanup/output/playwright/wavedrom-cleanup/removal-package-full.json
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node sync-upstream.mjs --check
node build-exports.mjs --check
```

- RED: 1 passed / 8 failed, on the original insertion/classification, special
  previews, HTML/DOCX and print behavior. No missing-module red.
- Browser graph/dependency tests: **2/2 passed**; Mermaid is present and WaveDrom,
  JSON5 and its rendering dependencies are absent. Runtime lazy import behavior
  is additionally checked in the shipping graph.
- First focused run: 19 passed / 2 failed because the new test selected an absent
  language CSS class. Corrected those assertions to inspect actual `pre code`
  text. The final package run passes all **21 focus tests**: 9 removal cases,
  7 preview/printing cases and 5 Mermaid theme/security cases. These use actual
  rendering, real DOCX ZIP/XML, real source edits and the public print callback.
- Final full package run: **70 passed / 11 failed (81 total)**. `editor` 21/21,
  `export` 9/9, `image-async` 18/18 and `source` 1/1 pass alongside the focus tests.
- Package tsc: **0 errors** after the main thread's prerequisite. Source sync
  verifies all 93 original hashes and the local exclusions; DOCX generation is
  reproducible at 731,108 bytes with its existing notices unchanged.

From repository root:

```sh
node node_modules/vitest/vitest.mjs run src/components/document/MarkdownFileContent.test.tsx src/components/document/ProjectFileMarkdown.test.tsx src/components/markdown/MarkdownEditor.test.tsx src/features/record-export/diagramExport.test.ts src/components/rich-editor/extensions/MermaidCodeBlock.test.ts
node node_modules/vitest/vitest.mjs run src/components/markdown/MarkdownEditor.test.tsx
node node_modules/typescript/bin/tsc --noEmit
node scripts/office-performance/build-host-graph.mjs
node scripts/check-bundle-boundaries.mjs
node --test scripts/office-performance/host-bundle-boundary.test.mjs
node node_modules/vite/bin/vite.js build --config vite.record-worker.config.ts
```

- Root related suite: first run 74/75 passed, with the old toolbar count (13)
  failing after the authorized button removal. Updated that count to 12;
  the file then passed **12/12**. Reuse the other four files' **63 passes**;
  all **75 distinct cases** therefore have valid passing evidence.
- Root tsc: **0 errors**. Both root/package tsc and sync were rerun after excluding
  the ambient type file; passing runtime checks were reused for that type-only
  cleanup.
- Normal shipping Vite uses the existing observational graph hook, no extra
  entry or warning filter. Build passed; **0 eval warnings**, only the existing
  >900 kB chunk-size advisory remains. Standard lazy/budget check passed (main
  **249 KiB / 250 KiB**) and host boundary tests passed **6/6**.
- Record worker build uses its existing config, own `packages/agent-host/dist`,
  no staging. Only this task's previous renderer-only worker outputs were
  removed using their manifest before rebuilding, so old WaveDrom chunks cannot
  remain in the output directory.

The locked Node audit called
`verifyRecordWorkerDistribution('packages/agent-host/dist')` from
`scripts/record-worker-notices.mjs`. It verified all **118 bundle checksums** and
the generated notices. The manifest describes **118 packages**, including
Mermaid and KaTeX, with no WaveDrom/bit-field/logidrom/onml/tspan/JSON5. No stale
WaveDrom chunk remains. There is no new prebundled notice boundary: that proposed
adapter was removed, and the existing node_modules notice collector is unchanged.

- Distribution manifest SHA-256:
  `04847e2ae44c64272c6ac3f3f0bd16466c8cff393d06c991501c0edfc411f55f`
- Notices SHA-256:
  `274ac9cde4f14bd96ff8c2da468ca0d9f0d8219ffd7116085aafe2a580f7ea59`
- `removal-distribution-evidence.json` also records the normal shipping graph:
  **274 chunks**, no removed modules, **66 Mermaid chunks** outside every entry's
  static startup closure, and KaTeX retained. Both build logs have zero eval
  diagnostics. Checksums describe these local build artifacts, not future builds
  with different integration inputs.

To repeat the distribution verification under the same lock/runtime, from root:

```sh
node --input-type=module -e "import {verifyRecordWorkerDistribution} from './scripts/record-worker-notices.mjs'; console.log(await verifyRecordWorkerDistribution('packages/agent-host/dist'));"
```

## Baseline failures and verification limits

The 11 package failures are exactly the same test names and first diagnostics as
the original `0cdf9ab` WaveDrom import comparison (39/50 passed in those four
files). `removal-baseline-comparison.json` records exact equality. All failures
are in `desktop-export.test.tsx` (6) and `native-pdf.test.tsx` (5): ten still look
for the old “导出与打印” text; one desktop print test expects a “Markdown 源码”
textbox while the editor is in rich mode. No expected result was relaxed or
these tests skipped. This is not a claim that the full package is green.

Earlier suite runs intermittently failed table undo and two image-paste tests.
They passed in the original-import comparison and in the final removal suite;
they are recorded as suite/timing observations, not a proven stable baseline
defect or a WaveDrom regression. No table undo fix was made.

No GUI/native PDF/cargo acceptance was run. The real print callback tests inspect
prepared HTML; they do not claim native page or pixel acceptance. No clean npm
installation was run; declaration/lock pruning and the actual browser/worker
graphs verify dependency removal. The integration PR remains the main thread's
draft and no push/merge is performed here.

## Standards / Spec self-review

Standards: generated changes originate in the sync/export scripts; upstream
bytes, hash manifest and licenses are unchanged. The implementation deletes
unused behavior rather than adding compatibility fallbacks. Edits are confined
to the authorized feature, direct consumers, tests and documentation. No edits
to main's exact-option/Highlight changes; only the toolbar count in the same test
file changes as part of removing its button. No subagent or other-chat messages.

Spec: all three WaveDrom types and their insertion/render/export routes are
removed together. Existing content remains ordinary, editable/exportable code.
Mermaid flowchart/sequence/Gantt/theme/security tests, math/export tests and
Record ordinary-code tests remain passing. No runtime dependency is retained
as a hidden compatibility path. No new blocking findings in this diff; the
explicit package baseline failures and native verification limits remain above.
