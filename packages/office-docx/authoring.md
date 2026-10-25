# Word authoring contract

This adapter reuses `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`'s `packages/cli/src/formats/docx.ts`, Tiptap editor, operation registry and DOCX serializer. Source files remain pinned by `source-lock.json`; host-specific DOM and image adapters are separate. GenOffice's Apache-2.0 LICENSE/NOTICE and runtime dependency licenses ship in `dist/THIRD-PARTY-NOTICES.txt`.

`engine.create(content)` accepts the existing restricted HTML string, or `{html?: string, ops?: object[]}`. Object form requires HTML or at least one operation. Each operation is the upstream flat `{op, ...fields}` protocol. `engine.edit(bytes, [{type:'operations',ops}])` applies the same protocol to an existing baseline; this edit must be the only edit in the array. Existing text/document/snapshot edits retain their behavior. The caller persists returned candidate bytes through native File version/CAS services.

The serialized input budget is 2 MiB; at most 256 operations, HTML at most 50,000 nodes / 64 levels. Source bytes retain the existing ZIP budget and read-only checks. Unknown operation names and top-level fields reject the candidate. Atomic mode produces no candidate if any operation fails.

HTML is a content fragment, not a browser page: use `h1`–`h6`, `p`, `ul/ol/li`, `strong/em/u/s`, `a href`, `br`, `table/thead/tbody/tr/th/td`, `pre/code`, `blockquote`, and `formula`. Tables start with plain text cells; create merged cells and formatting through native operations. Unsupported tags, CSS/style attributes, comments and declarations are rejected. `insert_content` / `replace_blocks` HTML gets the same checks. Existing simple-string creation deliberately retains its stricter original contract.

Call `engine.catalog()` or read the build-generated `dist/authoring-catalog.json` for exact operations and field definitions, derived from the upstream validator. `inspect(bytes).authoring` returns current top-level block indexes, styles, table styles, sections, headers/footers and notes without media bytes. Re-inspect after structural operations; indexes identify the current document order. `target.scope:'document'` alone is not an upstream target condition: use a nodeType, containsText or explicit blockIndexes.

## Example: structure, typography, page geometry and headers

```json
{
  "html": "<h1>季度报告</h1><p>第一段正文</p><table><tr><th>项目</th><th>金额</th></tr><tr><td>研发</td><td>120</td></tr></table>",
  "ops": [
    {"op":"setFont","target":{"blockIndexes":[0,1,2]},"fontSize":12,"fontFamily":"宋体"},
    {"op":"setFont","target":{"nodeType":"docHeading"},"fontSize":26,"bold":true,"color":"#17365D"},
    {"op":"setParagraphFormat","target":{"nodeType":"docHeading"},"align":"center","spaceAfter":240},
    {"op":"setParagraphFormat","target":{"nodeType":"docParagraph"},"lineSpacing":1.5,"indentFirstLine":480},
    {"op":"setTableCellFormat","target":{"nodeType":"table"},"range":{"row":0,"col":0,"colEnd":1},"fill":"#D9E2F3"},
    {"op":"mergeTableCells","target":{"nodeType":"table"},"range":{"row":1,"col":0,"colEnd":1}},
    {"op":"set_page_setup","paper":"A4","margins":{"top":"2cm","bottom":"2cm","left":"2cm","right":"2cm"}},
    {"op":"set_header_footer","kind":"header","text":"内部报告"},
    {"op":"set_header_footer","kind":"footer","text":"第 {PAGE} 页 / 共 {NUMPAGES} 页"}
  ]
}
```

Run font sizes are points. `setParagraphFormat` lengths are twips (20 twips = 1 pt). `set_page_setup` accepts twips or explicit `cm/in/pt/mm` lengths. A CJK font changes the East Asian script slot and keeps the Latin font. Defining a style uses `define_style` with `run.fontFamily` / `run.eastAsiaFontFamily`, then `applyStyle` on a target. System font availability affects rendering fallback; the file keeps the requested font name.

For multiple page setups, `insert_section_break` takes `afterBlockIndex` and `type` (`nextPage`, `continuous`, `evenPage`, `oddPage`); follow with `set_page_setup` targeting `section:N`. Inspect `authoring.sections` for current section indexes.

## Native pictures and charts

```json
[
  {"op":"insert_picture","url":"data:image/png;base64,...","width":"2cm","altText":"项目标识"},
  {"op":"insert_chart","kind":"bar","title":"业务收入","categories":["研发","销售"],"series":[{"name":"收入","values":[120,160]}]}
]
```

Pictures only accept canonical inline PNG/JPEG/GIF data URLs whose declared MIME and detected header/dimensions match. Paths, `file:` and HTTP(S) URLs are rejected. The worker never fetches media or reads model-supplied paths. The input's 2 MiB total budget also bounds inline image bytes. `insert_picture` additionally accepts explicit height and floating position/wrap fields from the catalog. The upper-level host resolves approved assets into inline data before calling this data-only engine.

Charts are native Word charts, with their embedded XLSX workbook at `word/charts/embeddings/`; they remain editable. `edit_chart` updates the chart part and embedded workbook. Chart kinds supported by upstream insertion are bar, line and pie; this is not a claim that every Word chart type can be created.

## Verification

`node build.mjs` verifies fixed upstream blobs, bundles the declared DOM runtime and its default CSS, emits the authoring catalog and license notices. The worker is a single relocatable ESM with only Node built-in imports and no runtime assets. Optional native canvas/WebSocket accelerators and the synchronous XHR worker are unavailable; authoring does not execute scripts or request resources. CSSOM's optional CSSStyleDeclaration upgrade is disabled in the build adapter because it depends on sloppy-mode assignments incompatible with an ESM bundle; CSSOM's own implementation remains active. Its native error fallback uses an explicit TypeError/DOMException constructor map instead of direct eval, preserving the closed distribution contract.

`node --test test/*.test.mjs` covers existing edits, creation, operation rejection, media restrictions, real OOXML formats and closed-directory relocation. Explicit `test/browser-authoring.mjs` uses an environment-supplied Playwright module and headless Chrome to render the generated complex report with the unchanged full renderer, then writes screenshots and result JSON under ignored `test/output/browser/`. It opens no app window.
