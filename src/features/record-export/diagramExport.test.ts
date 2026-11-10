import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import { renderSafeDiagram } from "../../../packages/markdown-editor/src/adapters/diagramPreviewSafety";
import { diagramSvgToPng, renderDiagram } from "../../../packages/markdown-editor/src/genoffice/editor/diagrams";
import { prepareExportDiagrams } from "./diagramExport";
import { generateMarkdown } from "./markdownGenerator";
import { createRecordExportCoordinator, type RecordExportPlatform } from "./recordExport";
import type { ExportBlock, RecordExportDocument } from "./recordExportModel";

vi.mock("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety", () => ({ renderSafeDiagram: vi.fn() }));
vi.mock("../../../packages/markdown-editor/src/genoffice/editor/diagrams", () => ({ diagramSvgToPng: vi.fn(), renderDiagram: vi.fn() }));

const code: ExportBlock = { type: "codeBlock", language: "mermaid", code: "flowchart LR\n  A[开始] --> B[完成]" };
const svg = '<svg viewBox="0 0 200 100"><text>开始</text></svg>';
const png = { base64: "AQID", mime: "image/png", widthPx: 200, heightPx: 100, align: "center" };

function documentWith(blocks: ExportBlock[]): RecordExportDocument {
  return { tags: [], style: DEFAULT_RICH_TEXT_STYLE_SETTINGS, blocks };
}

beforeEach(() => {
  vi.mocked(renderSafeDiagram).mockReset().mockResolvedValue({ ok: true, svg });
  vi.mocked(diagramSvgToPng).mockReset().mockResolvedValue(png);
  vi.mocked(renderDiagram).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Record Export diagram preparation", () => {
  it("renders safely with an explicit paper theme and leaves the source model and image map intact", async () => {
    const document = documentWith([code, { type: "image", id: "record-diagram-1", source: "existing" }]);
    const images = new Map();
    const prepared = await prepareExportDiagrams(document, images);

    expect(renderSafeDiagram).toHaveBeenCalledWith("mermaid", code.code, "light");
    expect(diagramSvgToPng).toHaveBeenCalledWith(svg, 620);
    expect(prepared.document.blocks[0]).toMatchObject({ type: "image", id: "record-diagram-2", widthPx: 200 });
    expect(prepared.images.get("record-diagram-2")).toEqual({
      kind: "resolved", bytes: new Uint8Array([1, 2, 3]), extension: "png", mimeType: "image/png", widthPx: 200, heightPx: 100,
    });
    expect(document.blocks[0]).toBe(code);
    expect(images.size).toBe(0);
    expect(generateMarkdown(document)).toContain(`\`\`\`mermaid\n${code.code}\n\`\`\``);
  });

  it("prepares diagrams in quotes, lists, task lists and table cells", async () => {
    const prepared = await prepareExportDiagrams(documentWith([
      { type: "blockquote", blocks: [code] },
      { type: "bulletList", items: [{ blocks: [code] }] },
      { type: "orderedList", items: [{ blocks: [code] }] },
      { type: "taskList", items: [{ checked: true, blocks: [code] }] },
      { type: "table", rows: [{ cells: [{ header: true, blocks: [code] }] }] },
    ]), new Map());
    expect(prepared.images.size).toBe(5);
    expect(JSON.stringify(prepared.document.blocks)).not.toContain('"type":"codeBlock"');
    expect(JSON.stringify(prepared.document.blocks)).toContain('"checked":true');
  });

  it.each(["syntax error", "safety rejection"])("retains source after %s without rasterizing", async (error) => {
    vi.mocked(renderSafeDiagram).mockResolvedValue({ ok: false, error });
    const prepared = await prepareExportDiagrams(documentWith([code]), new Map());
    expect(prepared.document.blocks).toEqual([code]);
    expect(prepared.images.size).toBe(0);
    expect(diagramSvgToPng).not.toHaveBeenCalled();
  });

  it("retains source when the safe SVG cannot be rasterized", async () => {
    vi.mocked(diagramSvgToPng).mockResolvedValue(null);
    const prepared = await prepareExportDiagrams(documentWith([code]), new Map());
    expect(prepared.document.blocks).toEqual([code]);
    expect(prepared.images.size).toBe(0);
  });

  it("uses the real safety gate to reject active source before rendering", async () => {
    const actual = await vi.importActual<typeof import("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety")>("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety");
    vi.mocked(renderSafeDiagram).mockImplementation(actual.renderSafeDiagram);
    const unsafe: ExportBlock = { type: "codeBlock", language: "mermaid", code: 'flowchart LR\nA["<img src=https://example.com/tracker>"]' };
    const prepared = await prepareExportDiagrams(documentWith([unsafe]), new Map());
    expect(prepared.document.blocks).toEqual([unsafe]);
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(diagramSvgToPng).not.toHaveBeenCalled();
  });

  it("passes only sanitized SVG to the raster boundary", async () => {
    const actual = await vi.importActual<typeof import("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety")>("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety");
    vi.mocked(renderSafeDiagram).mockImplementation(actual.renderSafeDiagram);
    vi.mocked(renderDiagram).mockResolvedValue({ ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><script>alert(1)</script><image href="https://example.com/tracker"/><text onclick="alert(1)">开始</text></svg>' });
    const prepared = await prepareExportDiagrams(documentWith([code]), new Map());
    expect(prepared.images.size).toBe(1);
    const sanitized = vi.mocked(diagramSvgToPng).mock.calls[0][0];
    expect(sanitized).toContain("开始");
    expect(sanitized).not.toMatch(/script|<image|onclick|https:\/\/example.com/);
  });

  it("does not render ordinary code blocks", async () => {
    const document = documentWith([{ type: "codeBlock", language: "ts", code: "const n = 1;" }]);
    expect((await prepareExportDiagrams(document, new Map())).document).toEqual(document);
    expect(renderSafeDiagram).not.toHaveBeenCalled();
  });

  it.each(["before", "render", "raster"])("rejects cancellation at the %s boundary", async (boundary) => {
    const controller = new AbortController();
    if (boundary === "before") controller.abort();
    if (boundary === "render") vi.mocked(renderSafeDiagram).mockImplementation(async () => {
      controller.abort();
      return { ok: false, error: "rejected" };
    });
    if (boundary === "raster") vi.mocked(diagramSvgToPng).mockImplementation(async () => {
      controller.abort();
      return null;
    });
    await expect(prepareExportDiagrams(documentWith([code]), new Map(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    if (boundary === "before") expect(renderSafeDiagram).not.toHaveBeenCalled();
    if (boundary !== "raster") expect(diagramSvgToPng).not.toHaveBeenCalled();
  });

  it("keeps fenced Markdown source including blank lines, trailing newlines and embedded fences", () => {
    const source = "flowchart LR\n\n\nA[```] --> B\n\n";
    expect(generateMarkdown(documentWith([{ type: "codeBlock", language: "mermaid", code: source }]))).toContain(`\`\`\`\`mermaid\n${source}\n\`\`\`\``);
    expect(renderSafeDiagram).not.toHaveBeenCalled();
  });
});

describe("Record Export generator integration", () => {
  it.each(["docx", "pdf"] as const)("sends prepared images to the %s worker even with includeImages=false", async (format) => {
    const messages: Array<{ document: RecordExportDocument; images: Array<[string, unknown]> }> = [];
    const bytes = format === "docx"
      ? zipSync({ "[Content_Types].xml": new TextEncoder().encode("<Types/>"), "word/document.xml": new TextEncoder().encode("<document/>") })
      : new TextEncoder().encode("%PDF-1.7\n%%EOF");
    class ExportWorker {
      onmessage?: (event: { data: { bytes: Uint8Array } }) => void;
      terminate() {}
      postMessage(message: typeof messages[number]) {
        messages.push(message);
        queueMicrotask(() => this.onmessage?.({ data: { bytes } }));
      }
    }
    vi.stubGlobal("Worker", ExportWorker);
    const platform: RecordExportPlatform = {
      saveCommittedContent: async () => ({
        recordKind: "workspace", tags: [], style: DEFAULT_RICH_TEXT_STYLE_SETTINGS,
        committedHtml: `<pre><code class="language-mermaid">${code.code}</code></pre>`,
      }),
      resolveImage: vi.fn(),
      availableBytes: async () => 1024 * 1024 * 1024,
      loadPdfFonts: async () => ({ sans: new Uint8Array(), mono: new Uint8Array() }),
      writeAtomically: vi.fn(async ({ targetPath }) => targetPath),
    };
    const result = await createRecordExportCoordinator(platform).export({ format, includeImages: false, targetPath: `record.${format}` });
    expect(result.kind).toBe("success");
    expect(messages).toHaveLength(1);
    expect(messages[0].document.blocks[0]).toMatchObject({ type: "image", alt: "Mermaid 图表" });
    expect(messages[0].images[0][1]).toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    expect(renderSafeDiagram).toHaveBeenCalledWith("mermaid", code.code, "light");
    expect(platform.resolveImage).not.toHaveBeenCalled();
  });
});
