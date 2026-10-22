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
