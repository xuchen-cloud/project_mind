import { expect, it } from "vitest";
import { readRecordCutClipboard, recordCutClipboardHtml } from "./recordCutClipboard";
const descriptor = { version: 1 as const, recordKey: "workspace:项目--记录", token: "11111111-1111-4111-8111-111111111111" };
it("keeps a bounded cut identity in standard HTML when native clipboard transport drops custom MIME types", () => {
  const html = recordCutClipboardHtml("<p>Body</p>", descriptor);
  expect(readRecordCutClipboard("", `<html><body><!--StartFragment-->${html}</body></html>`)).toEqual(descriptor);
  expect(html.slice(0, html.indexOf("-->"))).not.toContain("--记录");
  expect(html).toContain("<p>Body</p>");
});
it("treats malformed or oversized foreign metadata as an ordinary copy", () => {
  for (const raw of ["{", JSON.stringify({ ...descriptor, token: "not-a-token" }), JSON.stringify({ ...descriptor, recordKey: "x".repeat(300) }), JSON.stringify({ ...descriptor, version: 2 })]) {
    expect(readRecordCutClipboard(raw, "")).toBeNull();
  }
  expect(readRecordCutClipboard("", "<!--project-mind-record-cut:%xx--><p>Body</p>")).toBeNull();
});
