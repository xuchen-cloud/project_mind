---
name: genoffice-authoring
description: Create and edit native Word, Excel and PowerPoint Files with bundled GenOffice engines, including document layout, workbook formulas and objects, and multi-slide presentation design.
---

# GenOffice authoring in Project Mind

This adapts the locked upstream GenOffice Skill (v2.67.1) to the current assistant. Use `file_office_create`, `file_office_inspect` and `file_office_edit`. These tools use the bundled local engines and save through native File identity/version/receipts. The standalone `genoffice` CLI, its account, filesystem paths and cloud services are not prerequisites.

Read the relevant format branch before constructing content:

- [Word](references/word.md): HTML plus upstream document operations, page setup, styles, tables, pictures, charts, headers/footers and notes. For an exact operation use [Word operation catalog](references/word-catalog.json).
- [Excel](references/excel.md): multi-sheet creation and complete gateway changes, preserving formulas, styles, objects and computed caches. Read [creation schema](references/excel-create.schema.json) and [gateway schema](references/excel-gateway.schema.json) only for fields needed by the task.
- [PowerPoint](references/powerpoint.md): native page specs and operations, editable content, layout audit and object references. Use [presentation design](references/presentation-design.md) for decks with a visual narrative.

For native authorization, identity and uncertain-save recovery, follow [Project Mind File contracts](../project-mind-cli/references/record-file.md). A similar filename does not establish the same File. Keep the existing File for revisions; new independent deliverables receive new identities.

## Author and save

A create call is `{name,content,request_id,project_id?}`. The `.docx`/`.xlsx`/`.pptx` extension selects the format; `content` is its JSON contract (Word also accepts the existing restricted HTML string). In Project Sessions the current Project is the default and other Projects are rejected. In Workspace Sessions omission means Workspace ownership; an explicit Project must be actually authorized.

Keep one stable request ID and the unchanged original payload for retries. Creation returns the actual File identity, v1, hash, receipt and fixed-version inspection. A generator preview or a directory file is not that receipt. Failures before commit do not publish a partial File. If a response is uncertain, recover the same request rather than creating again under a new ID.

Content JSON is bounded to 2 MiB, including embedded media; native saved bytes are bounded to 100 MiB (XLSX engine source bytes to 64 MiB). Use inline media accepted by the format contract; these workers do not fetch URLs or read caller paths. Prepare real requested content within the available engine semantics. Report a concrete unsupported feature instead of replacing it with a picture or dropping it.

## Continue and verify

Inspect the complete saved SourceRef and use it unchanged for `file_office_edit`. Use the format's operations for structure and style; simple text/cell/run edits remain available. A successful edit returns a new version on the same File. Re-inspect that version before later edits; a stale baseline rejects the write. Read-only Sessions can inspect but cannot create or edit.

Verify both identity and meaning: the result's object/version/hash must match the intended material, then check headings/table values, actual formula results, slide count and layout issues. For byte-sensitive work use the CLI fixed-version download described in the File guide. A hash match establishes byte equality, not correct pagination or layout. When visual output is available, inspect representative and dense pages; follow actual layout/audit findings through a bounded repair pass. State any unverified visual or unsupported calculation behavior.

## Upstream reuse

The workflow and format operations derive from the same GenOffice commit as the bundled engines: `d32d1711f1bf985430757b8c6b3fbddd3831d946`. [Source attribution](references/upstream-sources.json) records the original Skill and guides. [Upstream Skill reference](references/upstream-skill.md) marks portable launcher substitutions and is provenance/reference only: its standalone commands map to the tools above, rather than being executable instructions in this environment.
