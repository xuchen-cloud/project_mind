// @vitest-environment node
import { getSchema } from "@tiptap/core";
import { expect, it } from "vitest";
import { buildRichEditorExtensions } from "../components/rich-editor/extensions";
import { initializeRecordDocument, canonicalDocumentJson } from "./record-document";
import { serializeRecordDocument } from "./record-document-format";

it("validates the editor document in a worker without a browser DOM", () => {
  expect(typeof document).toBe("undefined");
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  const result = initializeRecordDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "中文正文" }] }] }, schema);
  expect(canonicalDocumentJson(result)).toContain("中文正文");
  expect(result.content![0].attrs!.blockId).toMatch(/^[0-9a-f]{32}$/);
});

it("renders nested tables, marks and managed asset metadata without injecting local paths", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  const canonical = initializeRecordDocument({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "<正文>&", marks: [{ type: "bold" }] }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colwidth: [100] }, content: [{ type: "paragraph" }] }] }] },
    { type: "image", attrs: { path: "assets/图片.png", src: "asset://localhost/Users/machine/图片.png", width: 120,
      annotationState: '{"shape":"rect"}', alt: "图片" } },
    { type: "attachment", attrs: { path: "assets/文件.pdf", href: "file:///Users/machine/文件.pdf", title: "附件", meta: "PDF" } },
  ] }, schema);
  const result = serializeRecordDocument(canonical, schema);
  expect(result.html).toContain("<strong>&lt;正文&gt;&amp;</strong>");
  expect(result.html).toContain('data-path="assets/图片.png"');
  expect(result.html).toContain('src="workspace:assets/图片.png"');
  expect(result.html).toContain('data-annotation-state="{&quot;shape&quot;:&quot;rect&quot;}"');
  expect(result.html).toContain("<colgroup>");
  expect(result.markdown).toContain("正文");
  expect(JSON.stringify(result)).not.toContain("/Users/machine");
});

it("requires managed attachment URLs to carry an explicit retained asset path", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true, portableAssets: true }));
  expect(() => serializeRecordDocument(initializeRecordDocument({ type: "doc", content: [
    { type: "attachment", attrs: { href: "workspace:projects/other/private.pdf", title: "Unsafe reference" } },
  ] }, schema), schema)).toThrow(/managed|asset/i);
});
