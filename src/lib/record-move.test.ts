import { describe, expect, it } from "vitest";

import { appendMarkdownSection, appendRichTextSection } from "./record-move";

describe("appendMarkdownSection", () => {
  it("separates appended markdown from existing content", () => {
    expect(appendMarkdownSection("原内容", "追加内容")).toBe("原内容\n\n---\n\n追加内容");
  });

  it("uses appended markdown directly when the existing record is empty", () => {
    expect(appendMarkdownSection("", "追加内容")).toBe("追加内容");
  });

  it("keeps existing markdown when the appended selection is empty", () => {
    expect(appendMarkdownSection("原内容", "  ")).toBe("原内容");
  });

  it("appends rich text without rebuilding or dropping structured nodes", () => {
    const existingHtml = '<p>原内容 <a href="https://example.com">链接</a></p>';
    const selectedHtml = [
      '<p><span data-type="contact-mention" data-contact-id="7" data-label="张三">@张三</span></p>',
      '<p><span data-type="internal-reference" data-ref-kind="note" data-ref-id="12" data-label="访谈">访谈</span></p>',
      '<p><img src="asset:///images/demo.png" data-path="/images/demo.png" data-mime-type="image/png" width="360" data-annotation-state="{}"></p>',
      '<div data-type="attachment" data-path="/files/brief.pdf" data-document-id="9">brief.pdf</div>',
      '<table><tbody><tr><td>表格内容</td></tr></tbody></table>',
    ].join("");

    const result = appendRichTextSection(
      { html: existingHtml, markdown: "原内容 [链接](https://example.com)" },
      selectedHtml,
    );

    expect(result).toBe(`${existingHtml}<hr>${selectedHtml}`);
    expect(result).toContain('data-path="/images/demo.png"');
    expect(result).toContain('data-annotation-state="{}"');
    expect(result).toContain('data-type="contact-mention"');
    expect(result).toContain('data-type="internal-reference"');
    expect(result).toContain('data-type="attachment"');
  });

  it("uses selected rich text directly for an empty record", () => {
    const selectedHtml = '<p><img data-path="/images/only.png"></p>';

    expect(appendRichTextSection({ html: "<p></p>", markdown: "" }, selectedHtml)).toBe(
      selectedHtml,
    );
  });
});
