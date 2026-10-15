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
