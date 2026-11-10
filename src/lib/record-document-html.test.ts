import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import { buildRichEditorExtensions, recordDocumentSchema } from "../components/rich-editor/extensions";
import { validateRecordDocument } from "./record-document";
import { serializeRecordDocument } from "./record-document-format";
import { parseRecordHtml } from "./record-document-html";

// Correct-behavior regression migrated from the G01 review probe.
it.each([
  ["paragraph", "<p>hello</p><p>world</p>"],
  ["hard break", "<p>hello<br>world</p>"],
  ["empty paragraph", "<p>hello</p><p></p><p>world</p>"],
  ["bold image", '<p><strong>hello</strong></p><strong><img src="https://example.com/a.png"></strong>'],
  ["list", "<ul><li><p>hello</p></li><li><p>world</p></li></ul>"],
  ["table", "<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>"],
  ["code", '<pre><code class="language-ts">hello\nworld</code></pre>'],
])("preserves browser editor canonical HTML roundtrip: %s", (label, html) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildRichEditorExtensions("", { stableBlocks: true, recordKey: "g01" }),
    content: html,
  });
  try {
    const canonical = validateRecordDocument(editor.getJSON(), recordDocumentSchema);
    if (label === "code") expect(canonical.content![0].attrs).toMatchObject({ language: "ts", languageExplicit: true });
    const projection = serializeRecordDocument(canonical, recordDocumentSchema);
    const restored = parseRecordHtml(projection.html, recordDocumentSchema);
    if (label === "code") expect(restored.content![0].attrs).toMatchObject({ language: "ts", languageExplicit: true });
    expect(restored).toEqual(canonical);
  } finally {
    editor.destroy();
  }
});
