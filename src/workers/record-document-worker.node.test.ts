// @vitest-environment node
import { expect, it } from "vitest";
import { handleRecordDocumentRequest } from "./record-document-worker";

it("derives contact name and alias pinyin using the shared GUI pronunciation rules", async () => {
  expect(await handleRecordDocumentRequest({ requestId: "contact", method: "contact.pinyin", data: {
    name: "张三", nicknames: " 老张；重庆;老张 ",
  } })).toEqual({ requestId: "contact", ok: true, data: {
    pinyinFull: "zhangsan", pinyinAbbr: "zs", nicknamePinyin: "laozhang lz chongqing cq",
  } });
});

it("derives aliases for a partial nickname update without requiring a contact name", async () => {
  expect(await handleRecordDocumentRequest({ requestId: "nickname-only", method: "contact.pinyin", data: {
    name: "", nicknames: "小李",
  } })).toEqual({ requestId: "nickname-only", ok: true, data: {
    pinyinFull: "", pinyinAbbr: "", nicknamePinyin: "xiaoli xl",
  } });
});

it("counts contact limits as Unicode characters, accepting Chinese and supplementary characters at the boundary", async () => {
  for (const name of ["张".repeat(64), "𠮷".repeat(64)]) {
    const result = await handleRecordDocumentRequest({ requestId: "contact-boundary", method: "contact.pinyin", data: {
      name, nicknames: "界".repeat(1000),
    } });
    expect(result.ok).toBe(true);
  }
  expect(await handleRecordDocumentRequest({ requestId: "contact-empty-aliases", method: "contact.pinyin", data: { name: "张三", nicknames: "" } }))
    .toMatchObject({ ok: true, data: { pinyinFull: "zhangsan", pinyinAbbr: "zs", nicknamePinyin: "" } });
});

it.each([
  { nicknames: "", field: "name" },
  { name: "张".repeat(65), nicknames: "", field: "name" },
  { name: "𠮷".repeat(65), nicknames: "", field: "name" },
  { name: "张三", nicknames: "界".repeat(1001), field: "nicknames" },
  { name: "张三", nicknames: "𠮷".repeat(1001), field: "nicknames" },
  { name: "张三", field: "nicknames" },
])("rejects invalid contact $field inputs before deriving pinyin", async ({ field, ...data }) => {
  expect(await handleRecordDocumentRequest({ requestId: "contact-invalid", method: "contact.pinyin", data }))
    .toMatchObject({ ok: false, error: { code: "INVALID_PATCH", message: expect.stringContaining(field) } });
});

it("converts staged Markdown with the existing canonical whitelist and preserves references", async () => {
  const result = await handleRecordDocumentRequest({ requestId: "stage", method: "record.initialize", data: {
    markdown: "## 成果\n\n**正文** [[workspace_record:42|来源]]\n\n- 步骤\n\n```ts\nconst x = 1;\n```",
  } });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data || !("document" in result.data)) throw new Error("Missing projection");
  expect(result.data.bodyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(result.data.markdown).toContain("[[workspace_record:42|来源]]");
  expect(result.data.document.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "bulletList", "codeBlock"]);
  const validated = await handleRecordDocumentRequest({ requestId: "validate", method: "record.validate", data: { document: result.data.document } });
  expect(validated.ok).toBe(true);
  if (!validated.ok || !validated.data || !("bodyHash" in validated.data)) throw new Error("Missing validation");
  expect(validated.data.bodyHash).toBe(result.data.bodyHash);
});

it("rejects ambiguous initialization inputs and leaves unsafe Markdown links as text", async () => {
  const ambiguous = await handleRecordDocumentRequest({ requestId: "bad", method: "record.initialize", data: { html: "<p>A</p>", markdown: "B" } });
  expect(ambiguous.ok).toBe(false);
  const unsafe = await handleRecordDocumentRequest({ requestId: "bad", method: "record.initialize", data: { markdown: "[unsafe](javascript:alert)" } });
  expect(unsafe.ok).toBe(true);
  if (!unsafe.ok || !unsafe.data || !("html" in unsafe.data)) throw new Error("Missing projection");
  expect(unsafe.data.html).not.toContain("href=");
  expect(unsafe.data.html).toContain("[unsafe](javascript:alert)");
});

it("returns the canonical projection and patch metadata for a text edit without exposing operations", async () => {
  const initial = await handleRecordDocumentRequest({ requestId: "init-text", method: "record.initialize", data: { markdown: "## 原标题\n\n正文" } });
  if (!initial.ok || !initial.data || !("document" in initial.data)) throw new Error("Missing initial document");
  const document = initial.data.document;
  const result = await handleRecordDocumentRequest({ requestId: "text", method: "record.text.patch", data: {
    document, codeLanguage: " TS ", edit: { kind: "replace", oldText: "正文", newText: "新正文" },
  } });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data || !("document" in result.data)) throw new Error("Missing text projection");
  expect(result.data.codeLanguage).toBe("ts");
  expect(result.data.markdown).toBe("## 原标题\n\n新正文");
  expect(result.data.document.content![1].attrs!.blockId).toBe(document.content![1].attrs!.blockId);
  expect(result.data.patch).toEqual({ createdBlockIds: [], deletedBlockIds: [], normalizations: [], noChange: false });
  expect(result.data).not.toHaveProperty("operations");
  const validated = await handleRecordDocumentRequest({ requestId: "validate-text", method: "record.validate", data: { document: result.data.document, codeLanguage: "ts" } });
  expect(validated.ok && validated.data && "bodyHash" in validated.data && validated.data.bodyHash).toBe(result.data.bodyHash);
});

it("serves append and full Markdown edits through record.text.patch and returns useful INVALID_PATCH errors", async () => {
  const initial = await handleRecordDocumentRequest({ requestId: "init", method: "record.initialize", data: { markdown: "正文" } });
  if (!initial.ok || !initial.data || !("document" in initial.data)) throw new Error("Missing document");
  const appended = await handleRecordDocumentRequest({ requestId: "append", method: "record.text.patch", data: {
    document: initial.data.document, edit: { kind: "append", markdown: "## 新标题" },
  } });
  expect(appended.ok).toBe(true);
  if (!appended.ok || !appended.data || !("document" in appended.data)) throw new Error("Missing append result");
  expect(appended.data.patch?.createdBlockIds).toHaveLength(1);
  const modified = await handleRecordDocumentRequest({ requestId: "markdown", method: "record.text.patch", data: {
    document: appended.data.document, edit: { kind: "markdown", beforeMarkdown: appended.data.markdown, afterMarkdown: appended.data.markdown.replace("正文", "新的正文") },
  } });
  expect(modified.ok).toBe(true);
  if (!modified.ok || !modified.data || !("document" in modified.data)) throw new Error("Missing Markdown result");
  expect(modified.data.markdown).toBe("新的正文\n\n## 新标题");
  expect(modified.data.patch).toEqual({ createdBlockIds: [], deletedBlockIds: [], normalizations: [], noChange: false });
  const bad = await handleRecordDocumentRequest({ requestId: "bad-text", method: "record.text.patch", data: {
    document: initial.data.document, edit: { kind: "markdown", beforeMarkdown: "旧的正文", afterMarkdown: "改" },
  } });
  expect(bad).toMatchObject({ requestId: "bad-text", ok: false, error: { code: "INVALID_PATCH", message: expect.stringContaining("baseline") } });
});

it("accepts a text patch whose valid before and after fields together exceed 1 MiB", async () => {
  const beforeMarkdown = `${"界".repeat(200000)}旧`;
  const afterMarkdown = `${"界".repeat(200000)}新`;
  const initial = await handleRecordDocumentRequest({ requestId: "large-init", method: "record.initialize", data: { markdown: beforeMarkdown } });
  if (!initial.ok || !initial.data || !("document" in initial.data)) throw new Error("Missing initial document");
  const result = await handleRecordDocumentRequest({ requestId: "large-text", method: "record.text.patch", data: {
    document: initial.data.document, edit: { kind: "markdown", beforeMarkdown, afterMarkdown },
  } });
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data || !("document" in result.data)) throw new Error("Missing large text patch");
  expect(result.data.markdown).toBe(afterMarkdown);
  expect(result.data.document.content![0].attrs!.blockId).toBe(initial.data.document.content![0].attrs!.blockId);
  expect(result.data.patch).toEqual({ createdBlockIds: [], deletedBlockIds: [], normalizations: [], noChange: false });
});
