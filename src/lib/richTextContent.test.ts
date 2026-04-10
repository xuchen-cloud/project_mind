import { describe, expect, it } from "vitest";

import {
  EMPTY_RICH_TEXT_HTML,
  getRenderableRichTextHtml,
  renderMarkdownToHtml,
  richTextHtmlToPlainText,
} from "./richTextContent";

describe("renderMarkdownToHtml", () => {
  it("renders markdown tables alongside surrounding prose", () => {
    expect(
      renderMarkdownToHtml(
        [
          "结论概览",
          "",
          "| 客户 | 状态 |",
          "| --- | --- |",
          "| ACME | 跟进中 |",
        ].join("\n"),
      ),
    ).toContain("<table>");
  });

  it("returns the empty editor html for blank markdown", () => {
    expect(renderMarkdownToHtml("   ")).toBe(EMPTY_RICH_TEXT_HTML);
  });
});

describe("getRenderableRichTextHtml", () => {
  it("prefers canonical html when tags are already present", () => {
    expect(
      getRenderableRichTextHtml({
        html: "<table><tbody><tr><td>ACME</td></tr></tbody></table>",
        markdown: "| 客户 |\n| --- |\n| ACME |",
      }),
    ).toBe("<table><tbody><tr><td>ACME</td></tr></tbody></table>");
  });
});

describe("richTextHtmlToPlainText", () => {
  it("extracts readable text from rich table html", () => {
    expect(
      richTextHtmlToPlainText(
        "<table><thead><tr><th>客户</th><th>状态</th></tr></thead><tbody><tr><td>ACME</td><td>跟进中</td></tr></tbody></table>",
      ),
    ).toBe("客户 | 状态 / ACME | 跟进中");
  });
});
