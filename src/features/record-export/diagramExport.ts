import type { ResolvedExportImage } from "./recordExport";
import type { ExportBlock, RecordExportDocument } from "./recordExportModel";

// This runs at the public generator boundary, before posting to a worker.
// Only the derived model contains images; the committed model keeps its source.
export async function prepareExportDiagrams(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  signal?: AbortSignal,
) {
  ensureNotCancelled(signal);
  const preparedImages = new Map(images);
  const reservedIds = new Set(images.keys());
  const reserveImageIds = (blocks: ExportBlock[]) => {
    for (const block of blocks) {
      if (block.type === "image") reservedIds.add(block.id);
      else if (block.type === "blockquote") reserveImageIds(block.blocks);
      else if (block.type === "table") block.rows.forEach((row) => row.cells.forEach((cell) => reserveImageIds(cell.blocks)));
      else if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
        block.items.forEach((item) => reserveImageIds(item.blocks));
      }
    }
  };
  reserveImageIds(document.blocks);
  let index = 0;
  const prepareBlocks = async (blocks: ExportBlock[]): Promise<ExportBlock[]> => {
    const prepared: ExportBlock[] = [];
    for (const block of blocks) {
      ensureNotCancelled(signal);
      if (block.type === "codeBlock" && block.language?.trim().toLowerCase() === "mermaid") {
        const { renderSafeDiagram } = await import("../../../packages/markdown-editor/src/adapters/diagramPreviewSafety");
        ensureNotCancelled(signal);
        const rendered = await renderSafeDiagram("mermaid", block.code, "light");
        ensureNotCancelled(signal);
        if (rendered.ok) {
          const { diagramSvgToPng } = await import("../../../packages/markdown-editor/src/genoffice/editor/diagrams");
          ensureNotCancelled(signal);
          const png = await diagramSvgToPng(rendered.svg, 620);
          ensureNotCancelled(signal);
          if (png) {
            let id: string;
            do { id = `record-diagram-${++index}`; } while (reservedIds.has(id));
            reservedIds.add(id);
            preparedImages.set(id, {
              kind: "resolved",
              bytes: Uint8Array.from(atob(png.base64), (character) => character.charCodeAt(0)),
              extension: "png",
              mimeType: png.mime,
              widthPx: png.widthPx,
              heightPx: png.heightPx,
            });
            prepared.push({ type: "image", id, source: "", alt: "Mermaid 图表", widthPx: png.widthPx });
            continue;
          }
        }
        // Syntax errors, safety rejections and unavailable rasters retain code.
        prepared.push(block);
      } else if (block.type === "blockquote") {
        prepared.push({ ...block, blocks: await prepareBlocks(block.blocks) });
      } else if (block.type === "table") {
        const rows: typeof block.rows = [];
        for (const row of block.rows) {
          const cells: typeof row.cells = [];
          for (const cell of row.cells) cells.push({ ...cell, blocks: await prepareBlocks(cell.blocks) });
          rows.push({ ...row, cells });
        }
        prepared.push({ ...block, rows });
      } else if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
        const items: typeof block.items = [];
        for (const item of block.items) items.push({ ...item, blocks: await prepareBlocks(item.blocks) });
        prepared.push({ ...block, items });
      } else prepared.push(block);
    }
    return prepared;
  };
  const blocks = await prepareBlocks(document.blocks);
  ensureNotCancelled(signal);
  return { document: { ...document, blocks }, images: preparedImages };
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
}
