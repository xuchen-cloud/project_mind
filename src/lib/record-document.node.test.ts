// @vitest-environment node
import { getSchema } from "@tiptap/core";
import { expect, it } from "vitest";
import { buildRichEditorExtensions } from "../components/rich-editor/extensions";
import { initializeRecordDocument, canonicalDocumentJson } from "./record-document";
import { serializeRecordDocument } from "./record-document-format";

it("preserves Workspace Record identity through committed JSON, HTML and Markdown", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  const canonical = initializeRecordDocument({ type: "doc", content: [{ type: "paragraph", content: [
    { type: "internalReference", attrs: {refKind:"note",refId:42,label:"项目资料"} },
    { type: "text", text: " 和 " },
    { type: "internalReference", attrs: {refKind:"workspace_record",refId:42,label:"个人方法"} },
  ] }] }, schema);
  const result = serializeRecordDocument(canonical, schema);
  expect(result.markdown).toBe("[[note:42|项目资料]] 和 [[workspace_record:42|个人方法]]");
  expect(result.html).toContain('data-ref-kind="workspace_record"');
  expect(result.html).toContain('data-ref-kind="note"');
  expect(canonical.content![0].content![2].attrs!.refKind).toBe("workspace_record");
});

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

it("rejects unsafe link schemes before they can be silently changed by HTML rendering", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  const linked = (href: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Link", marks: [{ type: "link", attrs: { href } }] }] }] });
  for (const href of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,secret", "file:///private/file", "asset://localhost/private", "workspace:private.sqlite"]) {
    expect(() => initializeRecordDocument(linked(href), schema)).toThrow(/link/i);
  }
  for (const href of ["https://example.com/path", "mailto:person@example.com", "tel:+12345", "#section", "guide/page", "//example.com/page"]) {
    const document = initializeRecordDocument(linked(href), schema);
    expect(serializeRecordDocument(document, schema).html).toContain(`href="${href}"`);
  }
});

it("requires complete supported reference identities instead of defaulting malformed references", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  for (const node of [
    { type: "internalReference", attrs: { refKind: "private_kind", refId: 1 } },
    { type: "internalReference", attrs: { refKind: "note", refId: null } },
    { type: "tagMention", attrs: { tagId: null } },
    { type: "contactMention", attrs: {} },
  ]) expect(() => initializeRecordDocument({ type: "doc", content: [{ type: "paragraph", content: [node] }] }, schema)).toThrow(/reference|mention/i);
});

it("keeps old reference canonical JSON unchanged when the optional SourceRef attribute is introduced", () => {
  const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));
  const old = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "a".repeat(32) }, content: [
    { type: "internalReference", attrs: { refKind: "document", refId: 51, label: "Legacy" } },
  ] }] };
  const canonical = initializeRecordDocument(old, schema);
  expect(canonicalDocumentJson(canonical)).toBe(canonicalDocumentJson(old));
  expect(serializeRecordDocument(canonical, schema).document).toEqual(old);
  const explicitEmpty = structuredClone(old) as import("@tiptap/core").JSONContent;
  explicitEmpty.content![0].content![0].attrs!.sourceRef = null;
  expect(initializeRecordDocument(explicitEmpty, schema)).toEqual(old);
});
