import { describe, expect, it } from "vitest";

import { ensureRecordExportExtension, recordExportExtension, sanitizeRecordExportStem } from "./recordExportTarget";

describe("record export portable targets", () => {
  it("creates safe cross-platform names and a dated unnamed fallback", () => {
    expect(sanitizeRecordExportStem('  Road/map:*?<>|.  ')).toBe("Road-map------");
    expect(sanitizeRecordExportStem("CON")).toBe("_CON");
    expect(sanitizeRecordExportStem("", new Date(2026, 7, 9))).toBe("未命名记录-20260809");
    expect(Array.from(sanitizeRecordExportStem("字".repeat(200))).length).toBe(120);
  });

  it("uses zip only when Markdown includes images", () => {
    expect(recordExportExtension("markdown", true, true)).toBe("zip");
    expect(recordExportExtension("markdown", false, true)).toBe("md");
    expect(recordExportExtension("markdown", true, false)).toBe("md");
    expect(recordExportExtension("docx", true, true)).toBe("docx");
    expect(recordExportExtension("pdf", true, true)).toBe("pdf");
  });

  it("keeps the chosen filename portable while enforcing the selected format", () => {
    expect(ensureRecordExportExtension("/tmp/记录", "pdf")).toBe("/tmp/记录.pdf");
    expect(ensureRecordExportExtension("C:\\Docs\\记录.PDF", "pdf")).toBe("C:\\Docs\\记录.PDF");
    expect(ensureRecordExportExtension("/tmp/记录.txt", "docx")).toBe("/tmp/记录.txt.docx");
  });
});
