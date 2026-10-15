// @vitest-environment node
import { expect, it } from "vitest";
import PDFDocument from "pdfkit";
import { extractSourcePdf } from "./source-pdf";

async function fixture(pages: Array<string | null>, encrypted = false) {
  const pdf = new PDFDocument({ autoFirstPage: false, ...(encrypted ? { userPassword: "fixture-secret", ownerPassword: "fixture-owner" } : {}) });
  const parts: Uint8Array[] = [];
  const result = new Promise<Uint8Array>((resolve, reject) => {
    pdf.on("data", (part: Uint8Array) => parts.push(part));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
  });
  for (const text of pages) { pdf.addPage(); if (text) pdf.font("Helvetica").fontSize(12).text(text); }
  pdf.end();
  return result;
}

it("extracts real PDF text with page anchors and preserves the caller's bytes", async () => {
  const input = await fixture(["First page evidence", "Second page decision"]);
  const original = input.slice();
  const result = await extractSourcePdf(input);
  expect(result.state).toBe("ready");
  expect(result.chunks.map(chunk => chunk.text)).toEqual(["First page evidence", "Second page decision"]);
  expect(result.chunks.map(chunk => chunk.locator)).toEqual([{ kind: "page", page: 1, start: 0, end: 19 }, { kind: "page", page: 2, start: 0, end: 20 }]);
  expect(result.coverage).toMatchObject({ pagesRead: 2, totalPages: 2, textPages: [1, 2], complete: true });
  expect(input).toEqual(original);
});

it("reports scan-only and password PDFs without claiming readable evidence", async () => {
  const scan = await extractSourcePdf(await fixture([null]));
  expect(scan.state).toBe("needs_ocr");
  expect(scan.chunks).toEqual([]);
  expect(scan.coverage.complete).toBe(false);
  const encrypted = await extractSourcePdf(await fixture(["Protected text"], true));
  expect(encrypted.state).toBe("encrypted");
  expect(encrypted.chunks).toEqual([]);
  expect(encrypted.coverage.complete).toBe(false);
});

it("marks mixed text and missing text pages partial with explicit coverage", async () => {
  const result = await extractSourcePdf(await fixture(["Readable evidence", null, "Later text"]));
  expect(result.state).toBe("partial");
  expect(result.reason).toBe("missing_text");
  expect(result.coverage).toMatchObject({ pagesRead: 3, totalPages: 3, textPages: [1, 3], complete: false });
});

it("limits page and character extraction without implying complete coverage", async () => {
  const pages = await extractSourcePdf(await fixture(["Page one", "Page two", "Unread page"]), { maxPages: 2 });
  expect(pages.state).toBe("partial");
  expect(pages.reason).toBe("page_limit");
  expect(pages.coverage).toMatchObject({ pagesRead: 2, totalPages: 3, complete: false });
  expect(pages.chunks.map(chunk => chunk.locator.page)).toEqual([1, 2]);
  const clipped = await extractSourcePdf(await fixture(["ABCDEFGHIJKLMNOPQRSTUVWXYZ"]), { maxChars: 12 });
  expect(clipped.reason).toBe("character_limit");
  expect(clipped.chunks.map(chunk => chunk.text).join("")).toBe("ABCDEFGHIJKL");
  expect(clipped.coverage).toMatchObject({ chars: 12, complete: false });
});

it("rejects excessive bytes and malformed PDF with an explicit failure state", async () => {
  expect((await extractSourcePdf(new Uint8Array(50 * 1024 * 1024 + 1))).state).toBe("too_large");
  const invalid = await extractSourcePdf(new TextEncoder().encode("not a PDF"));
  expect(invalid.state).toBe("failed");
  expect(invalid.reason).toBe("invalid_pdf");
  expect(invalid.chunks).toEqual([]);
});
