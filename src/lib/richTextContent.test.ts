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

  it("keeps an AI answer table inside its quote with surrounding prose", () => {
    const html = renderMarkdownToHtml([
      "> 说明", ">", "> | 名称 | 状态 |", "> | --- | --- |",
      "> | Alpha | **完成** |", ">", "> 后续说明",
    ].join("\n"));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const quote = doc.body.querySelector("blockquote");
    expect(quote?.querySelectorAll("table")).toHaveLength(1);
    expect(quote?.querySelectorAll("th")).toHaveLength(2);
    expect(quote?.querySelector("td strong")?.textContent).toBe("完成");
    expect(quote?.firstElementChild?.textContent).toBe("说明");
    expect(quote?.lastElementChild?.textContent).toBe("后续说明");
    expect(doc.body.children).toHaveLength(1);
  });

  it("renders nested quoted tables while leaving fenced table examples as code", () => {
    const html = renderMarkdownToHtml([
      "> 外层", ">", "> > | Name | Value |", "> > | --- | ---: |", "> > | A | 2 |",
      "", "```md", "| Literal | Code |", "| --- | --- |", "| B | 3 |", "```",
    ].join("\n"));
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("blockquote blockquote table")).toHaveLength(1);
    expect(doc.querySelectorAll("table")).toHaveLength(1);
    expect(doc.querySelector("td[style='text-align:right']")?.textContent).toBe("2");
    expect(doc.querySelector("pre code")?.textContent).toContain("| Literal | Code |");
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
  it("renders both Record scopes without changing historical note tokens", () => {
    const html = renderMarkdownToHtml("[[note:42|项目资料]] 和 [[workspace_record:42|个人方法]]");
    expect(html).toContain('data-ref-kind="note"');
    expect(html).toContain('data-ref-kind="workspace_record"');
    expect(richTextHtmlToPlainText(html)).toBe("记录 项目资料 和 记录 个人方法");
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
