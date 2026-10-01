import { parse, type DefaultTreeAdapterMap } from "parse5";
import { renderMarkdownToHtml } from "./richTextContent";

/** Pure text extraction only; callers own file access, identity and authorization.
 * Offsets count Unicode characters in each extracted paragraph, not UTF-16 units.
 * Extraction text is an index projection and must never replace original bytes. */
export type SourceTextFormat = "text" | "markdown" | "html";
export interface SourceTextChunk {
  ordinal: number;
  text: string;
  locator: { kind: "paragraph"; start: number; end: number };
  range: { start: number; end: number };
}
export interface SourceTextExtraction {
  state: "ready" | "partial" | "unsupported_encoding" | "too_large";
  chunks: SourceTextChunk[];
  coverage: { chars: number; paragraphs: number; complete: boolean };
  reason: "character_limit" | "chunk_limit" | "structure_limit" | null;
}
export const SOURCE_TEXT_MAX_BYTES = 10 * 1024 * 1024;
export const SOURCE_TEXT_MAX_CHARS = 2 * 1024 * 1024;
export const SOURCE_TEXT_MAX_CHUNKS = 10000;
const CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 200;

export function sourceExtractionBudget(value: number | undefined, maximum: number) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid source extraction budget");
  return Math.min(value, maximum);
}

function noText(state: "unsupported_encoding" | "too_large"): SourceTextExtraction {
  return { state, chunks: [], coverage: { chars: 0, paragraphs: 0, complete: false }, reason: null };
}

export function extractSourceText(bytes: Uint8Array, format: SourceTextFormat, limits: { maxChars?: number; maxChunks?: number } = {}): SourceTextExtraction {
  sourceExtractionBudget(limits.maxChars, SOURCE_TEXT_MAX_CHARS);
  sourceExtractionBudget(limits.maxChunks, SOURCE_TEXT_MAX_CHUNKS);
  if (bytes.byteLength > SOURCE_TEXT_MAX_BYTES) return noText("too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return noText("unsupported_encoding"); }
  if (text.includes("\0")) return noText("unsupported_encoding");
  text = text.replace(/\r\n?/gu, "\n");
  let paragraphs: string[];
  let structureComplete = true;
  if (format === "text") paragraphs = text.split(/\n[\t ]*\n/gu).map((part) => part.trim()).filter(Boolean);
  else if (format === "html" || format === "markdown") {
    const extracted = htmlParagraphs(format === "markdown" ? renderMarkdownToHtml(text) : text);
    paragraphs = extracted.paragraphs;
    structureComplete = extracted.complete;
  } else throw new TypeError("Unsupported source text format");
  return chunkSourceParagraphs(paragraphs, limits, structureComplete);
}

/** Reused by page-based PDF extraction after parsing the page text layer. */
export function chunkSourceParagraphs(paragraphs: readonly string[], limits: { maxChars?: number; maxChunks?: number } = {}, structureComplete = true): SourceTextExtraction {
  const maxChars = sourceExtractionBudget(limits.maxChars, SOURCE_TEXT_MAX_CHARS);
  const maxChunks = sourceExtractionBudget(limits.maxChunks, SOURCE_TEXT_MAX_CHUNKS);
  const chunks: SourceTextChunk[] = [];
  let chars = 0;
  let processedParagraphs = 0;
  const result = (reason: SourceTextExtraction["reason"]): SourceTextExtraction => ({
    state: reason ? "partial" : "ready", chunks,
    coverage: { chars, paragraphs: processedParagraphs, complete: reason === null }, reason,
  });
  for (const [index, paragraph] of paragraphs.entries()) {
    const points = Array.from(paragraph);
    const allowed = Math.min(points.length, maxChars - chars);
    if (allowed === 0) return result("character_limit");
    let start = 0;
    let covered = 0;
    while (start < allowed) {
      if (chunks.length >= maxChunks) return result("chunk_limit");
      const end = Math.min(start + CHUNK_CHARS, allowed);
      chunks.push({ ordinal: chunks.length, text: points.slice(start, end).join(""),
        locator: { kind: "paragraph", start: index + 1, end: index + 1 }, range: { start, end } });
      if (covered === 0) processedParagraphs += 1;
      chars += end - covered;
      covered = end;
      if (end === allowed) break;
      start = end - OVERLAP_CHARS;
    }
    if (allowed < points.length) return result("character_limit");
  }
  return result(structureComplete ? null : "structure_limit");
}

type HtmlNode = DefaultTreeAdapterMap["node"];
const inactive = new Set(["head", "script", "style", "template", "noscript", "iframe", "object", "embed"]);
const blocks = new Set(["p", "div", "section", "article", "aside", "nav", "header", "footer", "main", "address",
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "blockquote", "pre", "table", "tr", "td", "th", "hr"]);

function htmlParagraphs(html: string) {
  const root = parse(html);
  const paragraphs: string[] = [];
  let fragments: string[] = [];
  let preDepth = 0;
  let visited = 0;
  let complete = true;
  const flush = () => {
    const value = fragments.join("");
    const text = preDepth ? value.replace(/^\n+|\n+$/gu, "") : value.trim();
    if (text.trim()) paragraphs.push(text);
    fragments = [];
  };
  const stack: Array<{ node: HtmlNode; depth: number; exit: boolean }> = [{ node: root, depth: 0, exit: false }];
  while (stack.length) {
    const { node, depth, exit } = stack.pop()!;
    const tag = "tagName" in node ? node.tagName : null;
    if (exit) {
      if (tag && blocks.has(tag)) flush();
      if (tag === "pre") preDepth -= 1;
      continue;
    }
    if (depth > 64 || ++visited > 50000) { complete = false; break; }
    if (tag && inactive.has(tag)) continue;
    if (node.nodeName === "#text" && "value" in node) fragments.push(preDepth ? node.value : node.value.replace(/\s+/gu, " "));
    if (tag === "br") fragments.push("\n");
    if (tag === "img" && "attrs" in node) {
      const alt = node.attrs.find((attr) => attr.name === "alt")?.value;
      if (alt) fragments.push(alt);
    }
    if (tag && blocks.has(tag)) flush();
    if (tag === "pre") preDepth += 1;
    if ("childNodes" in node) {
      stack.push({ node, depth, exit: true });
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) stack.push({ node: node.childNodes[index], depth: depth + 1, exit: false });
    }
  }
  flush();
  return { paragraphs, complete };
}
