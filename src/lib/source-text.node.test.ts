// @vitest-environment node
import { expect, it } from "vitest";
import { extractSourceText } from "./source-text";

const bytes = (text: string) => new TextEncoder().encode(text);
const extracted = (source: ReturnType<typeof extractSourceText>) => source.chunks.map((chunk) => chunk.text).join("\n");

it("decodes UTF-8 BOM and keeps separate paragraph locations across CRLF", () => {
  const result = extractSourceText(bytes("\uFEFF中文 😀\r\n\r\n第二段 english"), "text");
  expect(result.state).toBe("ready");
  expect(result.chunks.map((chunk) => chunk.text)).toEqual(["中文 😀", "第二段 english"]);
  expect(result.chunks.map((chunk) => chunk.locator)).toEqual([
    { kind: "paragraph", start: 1, end: 1 }, { kind: "paragraph", start: 2, end: 2 },
  ]);
  expect(result.coverage).toEqual({ chars: 15, paragraphs: 2, complete: true });
});

it("rejects invalid UTF-8 and NUL-interleaved UTF-16 without indexing replacement text", () => {
  for (const input of [new Uint8Array([0xff, 0xfe, 0x61, 0]), new Uint8Array([0xc3, 0x28]), bytes("a\0b\0")]) {
    const result = extractSourceText(input, "text");
    expect(result.state).toBe("unsupported_encoding");
    expect(result.chunks).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  }
});

it("extracts Markdown headings, lists, tables, code and application reference labels", () => {
  const result = extractSourceText(bytes("# 项目目标\n\n- 第一项\n- 第二项\n\n| 名称 | 状态 |\n| --- | --- |\n| 来源 | 已确认 |\n\n```ts\n  const x = 1;\n  const y = 2;\n```\n\n[可信资料](https://example.test/source) [[note:7|来源材料]]"), "markdown");
  expect(result.state).toBe("ready");
  for (const value of ["项目目标", "第一项", "第二项", "名称", "状态", "已确认", "const x = 1;", "const y = 2;", "可信资料", "来源材料"]) expect(extracted(result)).toContain(value);
  expect(extracted(result)).not.toContain("https://example.test");
  expect(result.chunks.some((chunk) => chunk.text.startsWith("  const x"))).toBe(true);
});

it("reads HTML text without executing or indexing script, style and inactive containers", () => {
  const result = extractSourceText(bytes('<p>可见 <strong>内容</strong> &amp; 引用 <a href="https://example.test">链接文本</a></p><script>fetch("private.test"); globalThis.exfiltrate = true;</script><style>.secret { content: "hidden" }</style><template>隐藏模板</template><iframe>隐藏框架</iframe><p>后续正文</p>'), "html");
  expect(result.chunks.map((chunk) => chunk.text)).toEqual(["可见 内容 & 引用 链接文本", "后续正文"]);
  expect(result.coverage.complete).toBe(true);
});

it("bounds Unicode chunks to 1800 characters with 200 overlap inside each paragraph", () => {
  const result = extractSourceText(bytes("😀".repeat(4000) + "\n\n后续段落"), "text");
  expect(result.chunks.map((chunk) => Array.from(chunk.text).length)).toEqual([1800, 1800, 800, 4]);
  expect(result.chunks.slice(0, 3).map((chunk) => chunk.range)).toEqual([{ start: 0, end: 1800 }, { start: 1600, end: 3400 }, { start: 3200, end: 4000 }]);
  expect(result.chunks[3].locator).toEqual({ kind: "paragraph", start: 2, end: 2 });
  expect(result.coverage).toEqual({ chars: 4004, paragraphs: 2, complete: true });
});

it("reports incomplete coverage at the character and chunk budget instead of claiming a complete source", () => {
  const clipped = extractSourceText(bytes("中文".repeat(20) + "\n\n未读段落"), "text", { maxChars: 18 });
  expect(clipped.state).toBe("partial");
  expect(clipped.coverage).toEqual({ chars: 18, paragraphs: 1, complete: false });
  expect(clipped.reason).toBe("character_limit");
  expect(Array.from(extracted(clipped)).length).toBe(18);
  const chunked = extractSourceText(bytes("第一段\n\n第二段"), "text", { maxChunks: 1 });
  expect(chunked.state).toBe("partial");
  expect(chunked.reason).toBe("chunk_limit");
  expect(chunked.chunks.map((chunk) => chunk.text)).toEqual(["第一段"]);
});

it("rejects over-limit input and handles an empty source without false text", () => {
  expect(extractSourceText(new Uint8Array(10 * 1024 * 1024 + 1), "text").state).toBe("too_large");
  expect(extractSourceText(new Uint8Array(), "text")).toEqual({ state: "ready", chunks: [], coverage: { chars: 0, paragraphs: 0, complete: true }, reason: null });
});
