// @vitest-environment node
import type { JSONContent } from "@tiptap/core";
import { expect, it } from "vitest";
import { recordDocumentSchema as schema } from "../components/rich-editor/extensions";
import { initializeRecordDocument, recordBlockIndex } from "./record-document";
import { serializeRecordDocument } from "./record-document-format";
import { parseRecordHtml } from "./record-document-html";
import { renderMarkdownToHtml } from "./richTextContent";
import { applyRecordTextEdit } from "./record-text-edit";

const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });
const doc = (...content: JSONContent[]) => initializeRecordDocument({ type: "doc", content }, schema);
const markdownDoc = (markdown: string) => parseRecordHtml(renderMarkdownToHtml(markdown), schema);
const markdown = (document: JSONContent) => serializeRecordDocument(document, schema).markdown;

it("replaces one literal match across marks, retaining untouched text, links and block identity", async () => {
  const document = doc({ type: "paragraph", content: [
    { type: "text", text: "前火", marks: [{ type: "bold" }] },
    { type: "text", text: "车后", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
  ] });
  const original = structuredClone(document);
  const result = await applyRecordTextEdit(document, { kind: "replace", oldText: "火车", newText: "列车" }, schema);
  expect(result.document.content![0].content).toEqual([
    { ...document.content![0].content![0], text: "前列车" },
    { ...document.content![0].content![1], text: "后" },
  ]);
  expect(result.document.content![0].attrs).toEqual(document.content![0].attrs);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
  expect(result.noChange).toBe(false);
  expect(document).toEqual(original);
});

it("appends Markdown blocks with fresh identities and keeps managed assets and references byte for byte", async () => {
  const document = doc(paragraph("正文"), { type: "image", attrs: { path: "assets/图片.png", width: 120, annotationState: '{"shape":"rect"}' } },
    { type: "paragraph", content: [{ type: "internalReference", attrs: { refKind: "note", refId: 7, label: "来源" } }] });
  const result = await applyRecordTextEdit(document, { kind: "append", markdown: "## 新增\r\n\r\n* 条目\r\n\r\n| 日期 | 内容 |\r\n| --- | --- |\r\n| 11月 | 排期 |" }, schema);
  expect(result.document.content!.slice(0, 3)).toEqual(document.content);
  expect(result.document.content!.slice(3).map((node) => node.type)).toEqual(["heading", "bulletList", "table"]);
  expect(new Set(recordBlockIndex(result.document).map(({ blockId }) => blockId)).size).toBe(recordBlockIndex(result.document).length);
  expect(result.createdBlockIds.length).toBeGreaterThan(3);
  expect(result.deletedBlockIds).toEqual([]);
});

it("edits an exact Markdown baseline while preserving unrelated lossy blocks and inline styles", async () => {
  const document = doc({ type: "paragraph", content: [{ type: "text", text: "旧标题", marks: [{ type: "underline" }, { type: "highlight" }] }] },
    { type: "image", attrs: { path: "assets/保留.png", width: 99, annotationState: "original" } },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2, colwidth: [120, 160] }, content: [paragraph("复杂"), paragraph("多段落")] }] }] },
    { type: "paragraph", content: [{ type: "internalReference", attrs: { refKind: "note", refId: 7, label: "参考" } }] });
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("旧标题", "新标题") }, schema);
  expect(result.document.content!.slice(1)).toEqual(document.content!.slice(1));
  expect(result.document.content![0].attrs).toEqual(document.content![0].attrs);
  expect(result.document.content![0].content![0]).toEqual({ ...document.content![0].content![0], text: "新标题" });
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("rejects duplicate, overlapping, missing and cross-block literal matches atomically", async () => {
  for (const [document, oldText, message] of [
    [doc(paragraph("火车 火车")), "火车", /Ambiguous/],
    [doc(paragraph("aaa")), "aa", /Ambiguous/],
    [doc(paragraph("火车"), paragraph("火车")), "火车", /Ambiguous/],
    [doc(paragraph("火车"), paragraph("排期")), "火车\n\n排期", /single text block/],
    [doc(paragraph("正文")), "不存在", /not found/],
  ] as const) {
    const original = structuredClone(document);
    await expect(applyRecordTextEdit(document, { kind: "replace", oldText, newText: "改" }, schema)).rejects.toThrow(message);
    expect(document).toEqual(original);
  }
});

it("changes a heading, table cell, list item and fenced code using a full CRLF Markdown diff", async () => {
  const document = markdownDoc("## 标题\n\n前言\n\n* 第一项\n* 第二项\n\n| 版本 | 日期 |\n| --- | --- |\n| 11.1 | 11月1日 |\n\n```ts\nconst value = 1;\n```\n\n结尾");
  const before = markdown(document);
  const after = before.replace("## 标题", "### 新标题").replace("前言", "新的前言")
    .replace("第二项", "第二项更新").replace("11月1日", "11月2日").replace("value = 1", "value = 2").replace("结尾", "新的结尾");
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: before.replaceAll("\n", "\r\n"), afterMarkdown: after.replaceAll("\n", "\r\n") }, schema);
  expect(markdown(result.document)).toBe(after);
  expect(recordBlockIndex(result.document).map(({ blockId }) => blockId)).toEqual(recordBlockIndex(document).map(({ blockId }) => blockId));
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("retains cell attrs and rich inline marks in a normal table edit and supports literal cell edits", async () => {
  const document = markdownDoc("| 姓名 | 日期 |\n| --- | --- |\n| 陈 | 今天 |");
  const cell = document.content![0].content![1].content![1];
  cell.attrs!.colwidth = [180];
  document.content![0].content![0].content![1].attrs!.colwidth = [180];
  cell.content![0].content![0].marks = [{ type: "underline" }];
  const before = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: before, afterMarkdown: before.replace("今天", "明天") }, schema);
  const updated = result.document.content![0].content![1].content![1];
  expect(updated.attrs).toEqual(cell.attrs);
  expect(updated.content![0].content![0]).toEqual({ type: "text", text: "明天", marks: [{ type: "underline" }] });
  const literal = await applyRecordTextEdit(result.document, { kind: "replace", oldText: "明天", newText: "后天" }, schema);
  expect(markdown(literal.document)).toContain("后天");
});

it("preserves fixed references and invisible styles when nearby text and visible Markdown marks change", async () => {
  const sourceRef = { object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "file", id: "51" },
    revision: `sha256:${"a".repeat(64)}`, fileVersion: 2, recordVersion: null, blockId: null, locator: null, title: "依据", excerpt: "引文" };
  const document = doc({ type: "paragraph", content: [
    { type: "text", text: "前面", marks: [{ type: "bold" }, { type: "underline" }] },
    { type: "internalReference", attrs: { refKind: "document", refId: 51, label: "来源", sourceRef } },
    { type: "text", text: "后面", marks: [{ type: "link", attrs: { href: "https://example.com", target: "_self", rel: "custom" } }] },
  ] });
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("**前面**", "新的前面").replace("后面", "新的后面") }, schema);
  expect(result.document.content![0].content![0]).toEqual({ type: "text", text: "新的前面", marks: [{ type: "underline" }] });
  expect(result.document.content![0].content![1]).toEqual(document.content![0].content![1]);
  expect(result.document.content![0].content![2].marks).toEqual(document.content![0].content![2].marks);
  expect(result.document.content![0].attrs).toEqual(document.content![0].attrs);
});

it("keeps stable IDs through list insertions, paragraph split and merge, and reports deleted IDs", async () => {
  const document = markdownDoc("## 标题\n\n* 第一\n* 最后\n\n结尾");
  const beforeMarkdown = markdown(document);
  const added = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("* 最后", "* 中间\n\n* 最后") }, schema);
  expect(added.document.content![1].content![0]).toEqual(document.content![1].content![0]);
  expect(added.document.content![1].content![2]).toEqual(document.content![1].content![1]);
  expect(added.document.content![1].attrs).toEqual(document.content![1].attrs);
  expect(added.createdBlockIds).toHaveLength(2);
  const single = doc(paragraph("第一 第二"));
  const split = await applyRecordTextEdit(single, { kind: "markdown", beforeMarkdown: markdown(single), afterMarkdown: "第一\n\n第二" }, schema);
  expect(split.document.content![0].attrs).toEqual(single.content![0].attrs);
  expect(split.createdBlockIds).toHaveLength(1);
  const merged = await applyRecordTextEdit(split.document, { kind: "markdown", beforeMarkdown: markdown(split.document), afterMarkdown: "第一 第二" }, schema);
  expect(merged.document.content![0].attrs).toEqual(single.content![0].attrs);
  expect(merged.deletedBlockIds).toEqual(split.createdBlockIds);
});

it("rejects a bad baseline and loss of structure in a modified complex table, leaving the original intact", async () => {
  const document = doc(paragraph("开头"), { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("第一段"), paragraph("第二段")] }] }] });
  const beforeMarkdown = markdown(document);
  const original = structuredClone(document);
  await expect(applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: "wrong", afterMarkdown: "改" }, schema)).rejects.toThrow(/baseline/);
  await expect(applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("第一段", "新第一段") }, schema)).rejects.toThrow(/structure.*replace/);
  expect(document).toEqual(original);
});

it("rejects ambiguous duplicate deletion and a split that would strip hidden styles", async () => {
  const duplicate = doc(paragraph("重复"), paragraph("重复"));
  await expect(applyRecordTextEdit(duplicate, { kind: "markdown", beforeMarkdown: markdown(duplicate), afterMarkdown: "重复" }, schema)).rejects.toThrow(/identity.*replace/);
  const rich = doc({ type: "paragraph", content: [{ type: "text", text: "第一 第二", marks: [{ type: "underline" }] }] });
  await expect(applyRecordTextEdit(rich, { kind: "markdown", beforeMarkdown: markdown(rich), afterMarkdown: "第一\n\n第二" }, schema)).rejects.toThrow(/structure.*replace/);
});

it("returns noChange for identical text, empty append and CRLF-only Markdown changes", async () => {
  const document = markdownDoc("## 中文\n\n正文");
  for (const edit of [
    { kind: "replace", oldText: "正文", newText: "正文" },
    { kind: "append", markdown: "\r\n  " },
    { kind: "markdown", beforeMarkdown: markdown(document).replaceAll("\n", "\r\n"), afterMarkdown: markdown(document) },
  ] as const) {
    const result = await applyRecordTextEdit(document, edit, schema);
    expect(result.document).toEqual(document);
    expect(result).toMatchObject({ noChange: true, createdBlockIds: [], deletedBlockIds: [], normalizations: [] });
  }
});

it("validates edit fields and size at the boundary and normalizes an explicitly emptied document", async () => {
  const document = doc(paragraph("正文"));
  for (const edit of [null, { kind: "replace", oldText: "正文", newText: "改", extra: true },
    { kind: "replace", oldText: "", newText: "改" }, { kind: "append", markdown: 123 },
    { kind: "append", markdown: "a".repeat(1024 * 1024) }]) {
    await expect(applyRecordTextEdit(document, edit as never, schema)).rejects.toThrow(/Invalid|empty|limit/);
  }
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: "正文", afterMarkdown: "" }, schema);
  expect(markdown(result.document)).toBe("");
  expect(result.document.content!.map((node) => node.type)).toEqual(["paragraph"]);
  expect(result.normalizations).toEqual([{ kind: "empty_document_paragraph", blockId: null }]);
  expect(result.deletedBlockIds).toEqual([document.content![0].attrs!.blockId]);
  expect(result.createdBlockIds).toHaveLength(1);
});

it("preserves invisible empty paragraphs when a neighboring paragraph changes", async () => {
  const document = doc(paragraph(""), paragraph("改前"), paragraph(""), paragraph("结尾"));
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("改前", "改后") }, schema);
  expect(result.document.content!.filter((node) => !node.content)).toEqual([document.content![0], document.content![2]]);
  expect(result.document.content![1].attrs).toEqual(document.content![1].attrs);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("retains IDs and attributes when exact uniquely projected blocks move", async () => {
  const document = doc({ type: "paragraph", content: [{ type: "text", text: "第一", marks: [{ type: "underline" }] }] }, paragraph("第二"), paragraph("第三"));
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: markdown(document), afterMarkdown: "第二\n\n第三\n\n第一" }, schema);
  expect(result.document.content).toEqual([document.content![1], document.content![2], document.content![0]]);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("retains rich nodes and their IDs when unique list items move within a list", async () => {
  const document = markdownDoc("* 第一\n* 第二\n* 第三");
  document.content![0].content![0].content![0].content![0].marks = [{ type: "underline" }];
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: "* 第二\n\n* 第三\n\n* 第一" }, schema);
  const items = document.content![0].content!;
  expect(result.document.content![0].content).toEqual([items[1], items[2], items[0]]);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("edits an existing task list without changing its kind or item identities", async () => {
  const document = doc({ type: "taskList", content: [
    { type: "taskItem", attrs: { checked: false }, content: [paragraph("准备")] },
    { type: "taskItem", attrs: { checked: true }, content: [paragraph("完成")] },
  ] });
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("[ ] 准备", "[x] 准备好了") }, schema);
  expect(result.document.content![0].type).toBe("taskList");
  expect(result.document.content![0].content![0].attrs).toEqual({ ...document.content![0].content![0].attrs, checked: true });
  expect(result.document.content![0].content![1]).toEqual(document.content![0].content![1]);
  expect(result.createdBlockIds).toEqual([]);
});

it("supports explicit heading and list-kind changes while preserving their existing identities", async () => {
  const document = markdownDoc("正文\n\n* 条目");
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: markdown(document), afterMarkdown: "## 正文\n\n1. 条目" }, schema);
  expect(result.document.content!.map((node) => node.type)).toEqual(["heading", "orderedList"]);
  expect(recordBlockIndex(result.document).map(({ blockId }) => blockId)).toEqual(recordBlockIndex(document).map(({ blockId }) => blockId));
});

it("rejects deletion of indistinguishable inline references with different hidden fixed citations", async () => {
  const citation = (version: number) => ({ object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "file", id: "51" },
    revision: `sha256:${"a".repeat(64)}`, fileVersion: version, recordVersion: null, blockId: null, locator: null, title: "依据", excerpt: "引文" });
  const document = doc({ type: "paragraph", content: [1, 2].map((version) => ({ type: "internalReference", attrs: { refKind: "document", refId: 51, label: "来源", sourceRef: citation(version) } })) });
  const beforeMarkdown = markdown(document);
  await expect(applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: "[[document:51|来源]]" }, schema)).rejects.toThrow(/identity.*replace/);
});

it("edits a long document without rebuilding thousands of unchanged blocks", async () => {
  const document = doc(...Array.from({ length: 2000 }, (_, i) => paragraph(`第${i}段：中文内容与排期`)));
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("第999段：中文内容与排期", "第999段：更新后的中文排期") }, schema);
  expect(result.document.content).toHaveLength(2000);
  expect(result.document.content![999].content![0].text).toBe("第999段：更新后的中文排期");
  expect(result.document.content!.slice(0, 999)).toEqual(document.content!.slice(0, 999));
  expect(result.document.content!.slice(1000)).toEqual(document.content!.slice(1000));
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("accepts a CRLF canonical baseline while retaining untouched code bytes", async () => {
  const document = doc({ type: "codeBlock", content: [{ type: "text", text: "甲\r\n乙" }] }, paragraph("改前"));
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("改前", "改后") }, schema);
  expect(result.document.content![0]).toEqual(document.content![0]);
  expect(result.document.content![1].content![0].text).toBe("改后");
});

it("rejects a simultaneous move and rewrite whose hidden styles cannot be mapped exactly", async () => {
  const document = doc({ type: "paragraph", content: [{ type: "text", text: "第一", marks: [{ type: "underline" }] }] }, paragraph("第二"), paragraph("第三"));
  await expect(applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: markdown(document), afterMarkdown: "第二\n\n第三\n\n第一改" }, schema)).rejects.toThrow(/structure.*replace/);
});

it("accepts independently valid UTF-8 Markdown fields whose combined input exceeds 1 MiB", async () => {
  const text = `${"界".repeat(200000)}旧`;
  const document = doc(paragraph(text));
  const beforeMarkdown = markdown(document);
  const afterMarkdown = `${"界".repeat(200000)}新`;
  expect(new TextEncoder().encode(beforeMarkdown).length).toBeLessThan(1024 * 1024);
  expect(new TextEncoder().encode(afterMarkdown).length).toBeLessThan(1024 * 1024);
  expect(new TextEncoder().encode(JSON.stringify({ beforeMarkdown, afterMarkdown })).length).toBeGreaterThan(1024 * 1024);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown }, schema);
  expect(markdown(result.document)).toBe(afterMarkdown);
  expect(result.document.content![0].attrs).toEqual(document.content![0].attrs);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it.each(["oldText", "newText", "markdown", "beforeMarkdown", "afterMarkdown"] as const)("rejects %s when that field exceeds 1 MiB in UTF-8", async (field) => {
  const oversized = "界".repeat(349526);
  expect(oversized.length).toBeLessThan(1024 * 1024);
  const edit = field === "oldText" || field === "newText"
    ? { kind: "replace", oldText: "正文", newText: "改", [field]: oversized }
    : field === "markdown" ? { kind: "append", markdown: oversized }
    : { kind: "markdown", beforeMarkdown: "正文", afterMarkdown: "改", [field]: oversized };
  await expect(applyRecordTextEdit(doc(paragraph("正文")), edit as never, schema)).rejects.toThrow(new RegExp(`${field}.*1 MiB`));
});

it("retains the final canonical document size limit for an individually valid replacement field", async () => {
  const text = "a".repeat(1024 * 1024);
  await expect(applyRecordTextEdit(doc(paragraph("正文")), { kind: "replace", oldText: "正文", newText: text }, schema)).rejects.toThrow(/document size.*1 MiB/);
});

it("changes visible marks and link attributes across multiple inline runs without treating them as block identities", async () => {
  const document = doc({ type: "paragraph", content: [
    { type: "text", text: "起 " },
    { type: "text", text: "重点", marks: [{ type: "bold" }, { type: "underline" }] },
    { type: "text", text: " 与 " },
    { type: "text", text: "链接", marks: [{ type: "link", attrs: { href: "https://example.com/a", title: "旧标题", target: "_self", rel: "custom" } }] },
    { type: "text", text: " 终" },
  ] });
  const beforeMarkdown = markdown(document);
  const afterMarkdown = beforeMarkdown.replace("**重点**", "*重点*").replace('https://example.com/a "旧标题"', 'https://example.com/b "新标题"');
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown }, schema);
  const runs = result.document.content![0].content!;
  expect(runs.find((node) => node.text === "重点")!.marks!.map((mark) => mark.type).sort()).toEqual(["italic", "underline"]);
  const originalLink = document.content![0].content![3].marks![0];
  expect(runs.find((node) => node.text === "链接")!.marks).toEqual([{ ...originalLink, attrs: { ...originalLink.attrs, href: "https://example.com/b", title: "新标题" } }]);
  expect(result.document.content![0].attrs).toEqual(document.content![0].attrs);
  expect(result.createdBlockIds).toEqual([]);
  expect(result.deletedBlockIds).toEqual([]);
});

it("adds a normal table column and changes an existing cell while retaining the old block identities", async () => {
  const document = markdownDoc("| A | B |\n| --- | --- |\n| 甲 | 乙 |\n| 丙 | 丁 |");
  const afterMarkdown = "| A | B | C |\n| --- | --- | --- |\n| 甲 | 新乙 | 新列一 |\n| 丙 | 丁 | 新列二 |";
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown: markdown(document), afterMarkdown }, schema);
  const oldRows = document.content![0].content!, newRows = result.document.content![0].content!;
  expect(markdown(result.document)).toBe(afterMarkdown);
  expect(newRows).toHaveLength(3);
  for (let i = 0; i < oldRows.length; i++) {
    expect(newRows[i].attrs).toEqual(oldRows[i].attrs);
    expect(newRows[i].content!.slice(0, 2).map((node) => node.attrs!.blockId)).toEqual(oldRows[i].content!.map((node) => node.attrs!.blockId));
  }
  expect(result.createdBlockIds).toHaveLength(6);
  expect(result.deletedBlockIds).toEqual([]);
});

it("honors an explicit new table-cell link while preserving its hidden target, rel and underline", async () => {
  const document = markdownDoc("| 名称 |\n| --- |\n| 资料 |");
  const leaf = document.content![0].content![1].content![0].content![0].content![0];
  leaf.marks = [{ type: "link", attrs: { href: "https://example.com/old", target: "_self", rel: "custom", title: "保留标题" } }, { type: "underline" }];
  const beforeMarkdown = markdown(document);
  const result = await applyRecordTextEdit(document, { kind: "markdown", beforeMarkdown, afterMarkdown: beforeMarkdown.replace("资料", "[资料](https://example.com/new)") }, schema);
  const updated = result.document.content![0].content![1].content![0].content![0].content![0];
  expect(updated.marks!.find((mark) => mark.type === "link")!.attrs).toMatchObject({ href: "https://example.com/new", target: "_self", rel: "custom", title: "保留标题" });
  expect(updated.marks!.some((mark) => mark.type === "underline")).toBe(true);
  expect(recordBlockIndex(result.document).map(({ blockId }) => blockId)).toEqual(recordBlockIndex(document).map(({ blockId }) => blockId));
});
