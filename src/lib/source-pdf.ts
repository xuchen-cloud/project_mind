import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkSourceParagraphs, sourceExtractionBudget, SOURCE_TEXT_MAX_CHARS, SOURCE_TEXT_MAX_CHUNKS } from "./source-text";

export const SOURCE_PDF_MAX_BYTES = 50 * 1024 * 1024;
export const SOURCE_PDF_MAX_PAGES = 500;
export interface SourcePdfExtraction {
  state: "ready" | "partial" | "needs_ocr" | "encrypted" | "too_large" | "failed";
  chunks: Array<{ ordinal: number; text: string; locator: { kind: "page"; page: number; start: number; end: number }; range: { start: number; end: number } }>;
  coverage: { chars: number; pagesRead: number; totalPages: number | null; textPages: number[]; complete: boolean };
  reason: "character_limit" | "chunk_limit" | "page_limit" | "missing_text" | "invalid_pdf" | null;
}

/** Node utility only. Reads a supplied snapshot; never opens a URL or executes
 * PDF actions/forms. The hosting process enforces the 60s hard deadline. */
export async function extractSourcePdf(bytes: Uint8Array, limits: { maxChars?: number; maxPages?: number; maxChunks?: number } = {}): Promise<SourcePdfExtraction> {
  const maxChars = sourceExtractionBudget(limits.maxChars, SOURCE_TEXT_MAX_CHARS);
  const maxPages = sourceExtractionBudget(limits.maxPages, SOURCE_PDF_MAX_PAGES);
  const maxChunks = sourceExtractionBudget(limits.maxChunks, SOURCE_TEXT_MAX_CHUNKS);
  const chunks: SourcePdfExtraction["chunks"] = [];
  const coverage: SourcePdfExtraction["coverage"] = { chars: 0, pagesRead: 0, totalPages: null, textPages: [], complete: false };
  const result = (state: SourcePdfExtraction["state"], reason: SourcePdfExtraction["reason"] = null): SourcePdfExtraction => ({ state, chunks, coverage: { ...coverage, complete: state === "ready" }, reason });
  if (bytes.byteLength > SOURCE_PDF_MAX_BYTES) return result("too_large");
  // A real JS matrix implementation removes the native canvas dependency for
  // extraction. No page rendering or operator list execution occurs here.
  if (typeof globalThis.DOMMatrix === "undefined") {
    const { default: Matrix } = await import("@thednp/dommatrix");
    Object.defineProperty(globalThis, "DOMMatrix", { value: Matrix, configurable: true });
  }
  if (!("pdfjsWorker" in globalThis)) {
    const handler = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    Object.defineProperty(globalThis, "pdfjsWorker", { value: handler, configurable: true });
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // PDF.js transfers the buffer to its parser; callers keep their original
  // bytes for hash verification and registration as the exact File Version.
  const resourceDirectory = (name: string) => join(dirname(fileURLToPath(import.meta.url)), name).replaceAll("\\", "/") + "/";
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, useWorkerFetch: false,
    cMapUrl: resourceDirectory("pdf-cmaps"), cMapPacked: true, standardFontDataUrl: resourceDirectory("pdf-fonts"),
    disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    enableXfa: false, stopAtErrors: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    coverage.totalPages = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, maxPages); pageNumber += 1) {
      if (coverage.chars >= maxChars) return result("partial", "character_limit");
      if (chunks.length >= maxChunks) return result("partial", "chunk_limit");
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const fragments: string[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          fragments.push(item.str);
          if (item.hasEOL) fragments.push("\n");
        }
        const text = fragments.join("").trim();
        coverage.pagesRead += 1;
        if (!text) continue;
        const pageText = chunkSourceParagraphs([text], { maxChars: maxChars - coverage.chars, maxChunks: maxChunks - chunks.length });
        if (pageText.chunks.length) coverage.textPages.push(pageNumber);
        for (const chunk of pageText.chunks) chunks.push({ ...chunk, ordinal: chunks.length, locator: { kind: "page", page: pageNumber, start: chunk.range.start, end: chunk.range.end } });
        coverage.chars += pageText.coverage.chars;
        if (pageText.reason) return result("partial", pageText.reason === "chunk_limit" ? "chunk_limit" : "character_limit");
      } finally { page.cleanup(); }
    }
    if (pdf.numPages > maxPages) return result("partial", "page_limit");
    if (!chunks.length) return result("needs_ocr");
    if (coverage.textPages.length < pdf.numPages) return result("partial", "missing_text");
    return result("ready");
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") return result("encrypted");
    return result("failed", "invalid_pdf");
  } finally { await task.destroy(); }
}
