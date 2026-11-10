// @vitest-environment node

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "./richTextContent";

describe("renderMarkdownToHtml security and semantics", () => {
  it("resolves a multiline reference label, destination and title", () => {
    const html = renderMarkdownToHtml([
      "See [the source][release notes].",
      "",
      "[release",
      "notes]:",
      "  /releases",
      '  "First line',
      'second line"',
    ].join("\n"));

    expect(html).toBe(
      '<p>See <a href="/releases" title="First line\nsecond line">the source</a>.</p>',
    );
  });

  it("keeps CommonMark links, code spans and HTML escaping in pasted text", () => {
    const html = renderMarkdownToHtml([
      '[a *link*](/guide "Guide") and `<b>&</b>`.',
      "",
      String.raw`\*literal\* &amp; <script>alert(1)</script>`,
    ].join("\n"));

    expect(html).toBe([
      '<p><a href="/guide" title="Guide">a <em>link</em></a> and <code>&lt;b&gt;&amp;&lt;/b&gt;</code>.</p>',
      "<p>*literal* &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    ].join("\n"));
  });

  it("keeps an AI answer table inside a list and nested quote", () => {
    const html = renderMarkdownToHtml([
      "1. Summary",
      "",
      "   > > | Item | Status |",
      "   > > | --- | ---: |",
      "   > > | [Guide](/guide) | **Ready** |",
      "",
      "   Follow up.",
    ].join("\n"));

    expect(html).toContain(
      "<ol>\n<li>\n<p>Summary</p>\n<blockquote>\n<blockquote>\n<table>",
    );
    expect(html).toContain('<td><a href="/guide">Guide</a></td>');
    expect(html).toContain('<td style="text-align:right"><strong>Ready</strong></td>');
    expect(html).toContain(
      "</table>\n</blockquote>\n</blockquote>\n<p>Follow up.</p>\n</li>\n</ol>",
    );
  });

  it("leaves fenced table and HTML examples as escaped code", () => {
    const code = ["| Item | Status |", "| --- | --- |", "| A | <b>Ready</b> |"].join("\n");

    // Node has no DOMParser: the renderer deliberately retains the code newline.
    expect(renderMarkdownToHtml(`\`\`\`md\n${code}\n\`\`\``)).toBe(
      '<pre><code class="language-md">' +
        code.replace("<b>Ready</b>", "&lt;b&gt;Ready&lt;/b&gt;") +
        "\n</code></pre>",
    );
  });

  // Upstream PoCs: https://github.com/advisories/GHSA-gfr2-rv44-r23c
  // ASCII samples are 360,009 / 360,001 bytes, each below 400 KB. Many short
  // continuation lines expose repeated cons-string flattening in 14.3.2.
  // 2 s allows ample headroom for the linear fix in 14.3.3 without accepting
  // the vulnerable multi-second scan. Measure only the real synchronous render;
  // a Vitest timeout alone cannot interrupt a blocked JavaScript event loop.
  it.each([
    { kind: "title", prefix: '[a]: /u "', escapedPrefix: "[a]: /u &quot;", line: "x\n" },
    { kind: "label", prefix: "[", escapedPrefix: "[", line: "a\n" },
  ])("preserves an unclosed multiline $kind as literal prose within 2 s", ({ prefix, escapedPrefix, line }) => {
    const continuation = line.repeat(180_000);
    const markdown = prefix + continuation;
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(400_000);

    const started = performance.now();
    const html = renderMarkdownToHtml(markdown);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs, "GHSA-gfr2-rv44-r23c render budget (ms)").toBeLessThan(2_000);
    expect(html).toBe(`<p>${escapedPrefix}${continuation.trimEnd()}</p>`);
  }, 30_000);
});
