# PowerPoint creation contract

The public `create(content, context?)` function returns editable `.pptx` bytes. It reuses GenOffice `d32d1711f1bf985430757b8c6b3fbddd3831d946`: `parseDeckSpec` → `buildDeckPptx` → the same `pptx-ops` transactions and package saver used by the upstream CLI. It does not need the standalone GenOffice application, AI account, or a conversion utility.

The package exports `creationSchema` (JSON Schema for the exact input) and `creationOperationFields` (the allowed top-level fields of every native op). Read these before constructing complex operations. The pinned upstream op guides live in `vendor/packages/pptx-ops/src/prompts/ops/`; the native slide-design and spec guides live in `vendor/packages/pipelines/src/slides/guides/`. They are immutable upstream resources covered by `source-lock.json`.

## Input and layout

`content` is a JSON object with `pages` and optional `operations`.

- `pages`: 1–60 original GenOffice page specs. Each page has optional `background: "#RRGGBB"` and 1–48 `elements`. Array order is z-order. The canvas is 1280 × 720 logical pixels.
- Every element requires `type`, `x`, `y`, `w`, `h`; its full frame must fit on the canvas. Supported types are `text`, `shape`, and `image`.
- Text uses `paragraphs: [{runs:[{text,sizePt?,bold?,italic?,color?,font?}],align?,lineSpacingPct?,spaceBeforePt?,spaceAfterPt?,bullet?}]`. `valign` is `top`, `middle`, or `bottom`. Font sizes are points, 6–160. A run is at most 4,000 characters. Font names are nonempty trimmed names of at most 80 characters.
- Shapes add `shape`, `fill?`, `stroke?: {color,widthPt}`, `paragraphs?`, `valign?`, `flipH?`, `flipV?`. Supported presets are enumerated in `creationSchema` (rectangles, rounded rectangles, arrows, ellipses, triangles, diamonds, chevrons, polygons, stars, heart, cloud, pie/donut, and lines). A non-line shape needs a fill or stroke. Border widths are 0.25–24 pt.
- Images use `url: "data:image/png;base64,..."` or `data:image/jpeg;base64,...`. The spec supports up to eight images per page and crops them to cover their frames without distortion. The bytes must have recognizable PNG/JPEG dimensions, with at most 100 million pixels. Remote URLs and local paths are rejected. Download or prepare media through separately authorized tools, then inline the bytes; this generator never fetches URLs or reads paths.
- Unknown element types, fields, geometry that would be clamped, and content that would be truncated or dropped cause an error. No partially generated deck is committed.

## Native operations and newly created object references

`operations` is an ordered list of `{op: <native GenOffice op>, as?: "alias"}`. Each op runs atomically on the private candidate. If one fails, the complete creation fails. These are data operations, with no JavaScript, eval, browser script, or file-system execution.

All 72 pinned native op names are available: rich text/fonts/paragraphs, shape transforms/geometry/effects, groups, connectors, native tables/merged cells/styles, charts, SmartArt-style editable shape groups, image/media bytes, notes/comments, transitions/animation, page/layout/section/theme/header/footer operations. The exact top-level fields are in `creationOperationFields`; the upstream op guide supplies nested payloads. Unknown op names and unsupported top-level fields are refused, then the original executor checks their meaning and targets.

**Units differ from the page spec:** a bare number in native geometry is document-space EMU. `1 px = 9,525 EMU`, `1 pt = 12,700 EMU`, `1 inch = 914,400 EMU`. Native length fields also accept explicit strings such as `"60px"`, `"2cm"`, or `"24pt"`; using these avoids conversion errors. Slide indices are zero based.

An insertion can set `as: "sales"`. A later op can put `{"$ref":"sales"}` wherever the upstream op expects that new element's ID. Aliases are unique identifiers of 1–64 ASCII letters/digits/underscore/hyphen, starting with a letter. An aliased op must create exactly one element; a missing or ambiguous reference is an error. References are resolved to the actual stable OOXML element identity, so styling a newly added table or connecting new shapes does not require guessing IDs.

```json
{
  "pages": [
    {
      "background": "#F4F7FB",
      "elements": [
        {
          "type": "text", "x": 60, "y": 40, "w": 1160, "h": 90,
          "paragraphs": [{"runs": [{"text": "季度经营回顾", "sizePt": 36, "bold": true, "color": "#17365D", "font": "Arial"}]}]
        },
        {
          "type": "shape", "shape": "roundRect", "x": 60, "y": 180, "w": 1160, "h": 300,
          "fill": "#DCE6F1", "stroke": {"color": "#17365D", "widthPt": 2},
          "paragraphs": [{"align": "center", "runs": [{"text": "以证据说明增长", "sizePt": 32, "bold": true}]}]
        }
      ]
    },
    {
      "elements": [
        {"type": "text", "x": 60, "y": 40, "w": 1160, "h": 90,
         "paragraphs": [{"runs": [{"text": "数据与结论", "sizePt": 36, "bold": true}]}]}
      ]
    }
  ],
  "operations": [
    {"op": {"op": "applyTheme", "name": "Project Mind", "colors": {"accent1": "#17365D"}, "majorFont": "Arial", "minorFont": "Arial"}},
    {"as": "sales", "op": {"op": "addTable", "target": {"slide": 1}, "rows": 2, "cols": 2,
      "offset": {"x": "60px", "y": "160px", "cx": "430px", "cy": "260px"}}},
    {"op": {"op": "setTableCell", "target": {"slide": 1, "el": {"$ref": "sales"}}, "row": 0, "col": 0,
      "paragraphs": [{"runs": [{"text": "季度", "bold": true}]}]}},
    {"op": {"op": "setTableCell", "target": {"slide": 1, "el": {"$ref": "sales"}}, "row": 1, "col": 0,
      "paragraphs": [{"runs": [{"text": "第一季度"}]}]}},
    {"op": {"op": "setTableCell", "target": {"slide": 1, "el": {"$ref": "sales"}}, "row": 1, "col": 1,
      "paragraphs": [{"runs": [{"text": "120"}]}]}},
    {"op": {"op": "setTableStyle", "target": {"slide": 1, "el": {"$ref": "sales"}}, "styleName": "headerDarkBlue"}},
    {"as": "revenue", "op": {"op": "addChart", "target": {"slide": 1}, "kind": "bar", "title": "季度营收",
      "categories": ["Q1", "Q2"], "series": [{"name": "营收", "values": [120, 180]}],
      "offset": {"x": "550px", "y": "160px", "cx": "650px", "cy": "400px"}}},
    {"op": {"op": "setNotes", "target": {"slide": 1}, "text": "数据来源：用户提供。"}}
  ]
}
```

Add images to a page using this exact element shape, replacing the final string with actual PNG bytes encoded in canonical base64:

```json
{"type":"image","x":760,"y":160,"w":280,"h":280,"url":"data:image/png;base64,<actual PNG base64>"}
```

Charts are native editable chart parts, with an embedded `.xlsx` data workbook. This adapter fills the gap in the pinned upstream generator, which emits data caches without a workbook: PowerPoint can open **Edit Data**, and chart changes through `slides:edit-chart` also refresh the adapter-owned workbook. Existing imported workbooks keep their own relationships and bytes. Supported native chart kinds are `bar`, `bar3D`, `barStacked`, `barPercentStacked`, `line`, `area`, `pie`, `pie3D`, `doughnut`, `scatter`, `radar`, and `comboBarLine`; horizontal bars use `barDir: "bar"`. Use sourced values or clearly identify illustrative data.

## Verification and continued editing

After creation, read the returned native File `sourceRef` with `file_office_inspect`. `inspect.authoring` returns a semantic summary of every slide, shape, table, chart, group, and notes, with no package XML, renderer tree, or base64. Each editable element provides its actual `target: {slide, el}` and `sourceId`; group children also provide the outer `group` ID. Copy those fields directly into native operations. Chart entries include title, category/series data; table entries include rich cell text, merged-cell spans, dimensions and style. Geometry is EMU (`box.coordinateSpace` identifies slide or group-local coordinates). `inspect` also returns `layoutAudit` from upstream `auditDeck` for each page. Findings flag overlaps, overflow, out-of-canvas geometry, distortion, or other layout problems, and can include a native `setTransform` suggestion. Font measurements are heuristic and findings are advisory; render complex decks and inspect the visible result before delivery. The generator never substitutes a page screenshot for editable native elements.

Apply theme operations before inserting styled tables, charts and diagrams; the pinned theme operation intentionally remaps existing explicit colors. Plan the narrative and design system first using upstream's design guide; verify one representative page, then the complete deck. Fix actual overflow or unintended overlap, retain intentional overlaps, and verify Chinese text and selected fonts in the actual renderer. Keep a consistent palette, grid, margins, and font hierarchy. Do not fabricate font fidelity that the current environment cannot provide.

For subsequent changes, use the same native data vocabulary with one sole edit: `{"kind":"operations","operations":[{"op":{"op":"setNotes","target":{"slide":0},"text":"修订备注"}}]}`. The operations list must have 1–1,024 entries, supports the same `as` / `$ref` references, and is limited to 2 MiB. Existing shapes use `inspect.authoring.slides[].elements[].target` exactly as returned; a group-child operation also copies its `group` field. Never derive or guess a prior ID or mix this envelope with other edit kinds. Chart operations refresh the adapter-owned embedded workbook in both native tool edits and browser saves; unchanged chart workbooks retain their exact bytes.

Existing `file_office_edit` PPTX command edits remain available, e.g. `{"kind":"command","name":"slides:edit-text","args":[{"slideIndex":0,"sourceId":"e_2","paragraphs":[{"runs":[{"text":"修订标题","bold":true}]}]}]}`. Take the real `sourceId` from `inspect.authoring`, do not copy the example's ID. Save against the new fixed native `sourceRef` and CAS baseline so the existing File receives v2 rather than becoming a separate File.

Budgets: creation JSON ≤ 2 MiB UTF-8, ≤ 100,000 JSON nodes, nesting ≤ 32; 1–60 pages, ≤ 48 spec elements/page, ≤ 8 spec images/page; ≤ 1,024 operations and ≤ 10,000 final top-level elements; final candidate ≤ 100 MiB plus the shared candidate ZIP expansion limits. The native host owns scope, durable creation, replay receipts and CAS. The Office package has no native File or storage authority.
