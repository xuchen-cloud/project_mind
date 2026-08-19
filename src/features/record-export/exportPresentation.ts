import type { ExportBlock } from "./recordExportModel";

export function plainExportBlocks(blocks: ExportBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph" || block.type === "heading") return block.content.map((inline) => inline.text).join("");
    if (block.type === "codeBlock") return block.code;
    if (block.type === "attachment") return `[附件：${block.title}]`;
    if (block.type === "image") return exportImagePlaceholder(block);
    if (block.type === "blockquote") return plainExportBlocks(block.blocks);
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      return block.items.map((item) => plainExportBlocks(item.blocks)).join("；");
    }
    if ("rows" in block) {
      return block.rows.map((row) => row.cells.map((cell) => plainExportBlocks(cell.blocks)).join(" | ")).join("；");
    }
    return "";
  }).join("\n");
}

export function exportImagePlaceholder(block: Extract<ExportBlock, { type: "image" }>) {
  const label = block.alt ?? block.title;
  return label ? `[图片未导出：${label}]` : "[图片未导出]";
}

export function formatExportVisualDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
