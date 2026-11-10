# PPTX production format package

Issue: #118 / F04–F06; dependent on the host Office/File integration.

Delivery: byte-only inspect/edit engine; real GenOffice render tree and React SVG
canvas; existing rich-text run edits and top-level picture position edits, with
stable slideIndex/cNvPrId addressing. The host owns lazy loading, saving and CAS.

Non-goals: root dependencies, app routing, File persistence, structural text edits,
fields, grouped object editing, table/chart editing, exact PowerPoint typography,
commits and publishing. No GUI or Tauri process is started.

Acceptance: real simple/complex files inspect; multiple targets and paragraphs
survive two successive save/reopen cycles; all other OOXML part bytes and original
rich-text properties remain; unsupported edits reject; preview uses real render
geometry, Chinese input, readOnly and bounded scroll fades.

Verification seams authorized by the user: inspect/edit with real fixture bytes,
exported React editor with user input and actual SVG output. Targeted Node and
jsdom tests, package typecheck, pinned-source verification and reproducible bundle
build. No root/full application verification.

## Current-selection AI bridge (2026-10-23)

Issue: [#212](https://github.com/xuchen-cloud/project_mind/issues/212), current Office
selection delivery on `codex/dsh-word-selection`. This package completes the PPT
selection bridge; shared integration and full Issue delivery remain with the parent. Dependencies: shared host selection
registration and DSH tool routing, supplied by the parent agent.

Delivery: capture actual selected slide elements and apply bounded text/geometry
changes through native transactions; frozen targets, mutation rejection, undo,
live render and the existing File candidate journal. Non-goals: independent AI
runtime, deck generation, grouped-child editing and network images.

Acceptance and verification: public React registration/message lifecycle tests;
headless browser against the real upstream App/MessagePort and native save harness.
Cover selection movement, mixed-run emphasis, geometry, undo/redo, persisted bytes,
invalid batches, readonly/preview, composition, mutation/undo/external replacement
and destruction. Package build and typecheck; no root build, app launch or review
subagent. Red evidence: missing registration, missing iframe reply, and flattened
mixed-run text all failed before their corresponding implementation changes.

## #303 / G04 + G09: progressive GUI opening (2026-11-10)

Dependency: shared host dispatches `engine.inspectView` for GUI and keeps full
`engine.inspect` for authoring. File CAS/receipts remain host owned. Scope is this
format package, shared worktree `codex/review-office-progressive`; no commit.

Delivery: view DTO carries exact complete source/hash, presentation catalog and
first parsed slide. Renderer reuses that seed and materializes other slides with
the pinned parser's inheritance/dependency traversal when viewed/edited. Loaded
models are a cache; complete archive plus cumulative dirty state owns saving.
Candidate comparison inspects archive bytes rather than parsing the entire deck.
Keep full upstream editing, output, undo/redo and the imported 50–150% zoom patch.

Non-goals: other formats, host/native changes, Windows or visible GUI acceptance,
release and Issue closure. ZIP inflation remains eager under the existing metered
resource gate; this package removes eager slide parsing/layout/media encoding.

Acceptance/verification: real fixture and upstream parser/session/handlers; first
slide editable while tail stays unmaterialized; successive saves and reopen keep
both edits and untouched tail/media/master/notes/animation/rels/opaque parts;
exact candidate changedParts and source binding; sources verify, package build,
Node regressions (single test worker), UI unit tests and package typecheck. Reuse
unchanged checks and record true red/green evidence and outstanding native GUI
acceptance. Headless App acceptance is authorized in this package under the shared
lock, with Vite watching/HMR disabled; visible GUI remains with the parent agent.
Implementation/test delegation uses
`gpt-6.1-sol`; review has explicit user authorization for this turn.
