import { describe, expect, it } from "vitest";

import {
  EMPTY_RICH_TEXT_HTML,
  getRenderableRichTextHtml,
  renderMarkdownToHtml,
  richTextHtmlToPlainText,
  trimTrailingCodeBlockNewline,
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

  it("restores contacts alongside internal references", () => {
    const html = renderMarkdownToHtml(
      "联系 @[contact:7|张三]，查看 [[note:12|访谈记录]]，标签 #[tag:5|客户|blue]。",
    );

    expect(html).toContain('data-type="contact-mention"');
    expect(html).toContain('data-contact-id="7"');
    expect(html).toContain('data-type="internal-reference"');
    expect(html).toContain('data-ref-id="12"');
    expect(html).toContain('data-type="tag-mention"');
    expect(html).toContain('data-tag-id="5"');
  });

  it("does not keep the fence-closing newline inside code blocks", () => {
    const html = renderMarkdownToHtml(["```ts", "const value = 1;", "```"].join("\n"));

    expect(html).toContain('class="language-ts"');
    expect(html).toContain(">const value = 1;</code></pre>");
  });
});

describe("trimTrailingCodeBlockNewline", () => {
  it("removes one pasted html code-block trailing newline", () => {
    expect(trimTrailingCodeBlockNewline("<pre><code>const value = 1;\n</code></pre>")).toBe(
      "<pre><code>const value = 1;</code></pre>",
    );
  });

  it("keeps internal code-block blank lines intact", () => {
    expect(trimTrailingCodeBlockNewline("<pre><code>const a = 1;\n\nconst b = 2;\n</code></pre>")).toBe(
      "<pre><code>const a = 1;\n\nconst b = 2;</code></pre>",
    );
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

  it("preserves ordered and nested list structure when requested", () => {
    expect(
      richTextHtmlToPlainText(
        [
          '<ol start="3">',
          "<li><p>第一步</p></li>",
          '<li data-type="taskItem" data-checked="true">',
          "<div><p>核对结果</p><ul><li><p>补一条说明</p></li></ul></div>",
          "</li>",
          "</ol>",
        ].join(""),
        { preserveStructure: true },
      ),
    ).toBe(["3. 第一步", "4. 核对结果", "  - 补一条说明"].join("\n"));
  });

  it("avoids stray spacing while keeping plain-text line breaks", () => {
    expect(
      richTextHtmlToPlainText(
        "<p>  Alpha <strong>Beta</strong> </p><p>Gamma<br />Delta</p>",
        { preserveStructure: true },
      ),
    ).toBe(["Alpha Beta", "Gamma", "Delta"].join("\n"));
  });
});
