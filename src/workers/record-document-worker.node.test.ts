// @vitest-environment node
import { expect, it } from "vitest";
import { handleRecordDocumentRequest } from "./record-document-worker";

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
