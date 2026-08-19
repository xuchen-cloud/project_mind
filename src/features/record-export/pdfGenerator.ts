import pdfMake from "pdfmake/build/pdfmake";
import type { Content, ContentImage, ContentTable, ContentText, TDocumentDefinitions } from "pdfmake/interfaces";

import type { ResolvedExportImage } from "./recordExport";
import type { ExportBlock, ExportInline, RecordExportDocument } from "./recordExportModel";

const A4_BODY_WIDTH_PT = 595.28 - 2 * 56.7;
const FONT_FILE_NAME = "NotoSansCJKsc-Regular.otf";
const PDF_FONT_NAME = "ProjectMindNoto";

export async function generatePdf(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fontBytes: Uint8Array,
) {
  pdfMake.addVirtualFileSystem({
    [FONT_FILE_NAME]: bytesToBase64(fontBytes),
  });
  pdfMake.addFonts({
    [PDF_FONT_NAME]: {
      normal: FONT_FILE_NAME,
      bold: FONT_FILE_NAME,
      italics: FONT_FILE_NAME,
      bolditalics: FONT_FILE_NAME,
    },
  });

  const content: Content[] = [];
  if (document.title) {
    content.push({
      text: document.title,
      style: "title",
      headlineLevel: 1,
      outline: true,
      outlineText: document.title,
    });
  }
  const metadata = [
    document.projectName ? `Project：${document.projectName}` : null,
    document.tags.length > 0 ? `Tags：${document.tags.map((tag) => `#${tag}`).join(" ")}` : null,
    document.updatedAt ? `最后更新：${formatVisualDate(document.updatedAt)}` : null,
  ].filter((line): line is string => Boolean(line));
  if (metadata.length > 0) content.push({ text: metadata.join("  ·  "), style: "metadata" });
  content.push(...document.blocks.flatMap((block) => renderBlock(block, images)));

  const definition: TDocumentDefinitions = {
    pageSize: "A4",
    pageOrientation: "portrait",
    pageMargins: [56.7, 56.7, 56.7, 64],
    tagged: true,
    displayTitle: true,
    info: {
      title: document.title ?? "Record Export",
      author: "Project Mind",
      creator: "Project Mind",
      producer: "Project Mind",
      subject: "A portable copy of committed Record content.",
    },
    defaultStyle: {
      font: PDF_FONT_NAME,
      fontSize: pxToPoints(document.style.body.fontSizePx),
      lineHeight: document.style.body.lineHeight,
      color: "#202124",
    },
    styles: {
      title: {
        font: PDF_FONT_NAME,
        fontSize: Math.max(20, pxToPoints(document.style.headings.h1SizePx) + 2),
        bold: true,
        margin: [0, 0, 0, 10],
      },
      metadata: { fontSize: Math.max(9, pxToPoints(document.style.body.fontSizePx) - 1), color: "#5f6368", margin: [0, 0, 0, 14] },
      h1: headingStyle(document.style.headings.h1SizePx, document),
      h2: headingStyle(document.style.headings.h2SizePx, document),
      h3: headingStyle(document.style.headings.h3SizePx, document),
      quote: { color: "#3c4043", italics: true, margin: [12, 4, 0, 8] },
      code: { fontSize: Math.max(8, pxToPoints(document.style.body.fontSizePx) - 1), background: "#f4f6f8", margin: [8, 6, 8, 8], preserveLeadingSpaces: true },
    },
    footer: (currentPage, pageCount) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: "center",
      color: "#777777",
      fontSize: 9,
      margin: [0, 18, 0, 0],
    }),
    content,
  };

  const buffer = await pdfMake.createPdf(definition).getBuffer();
  return new Uint8Array(buffer);
}

function renderBlock(block: ExportBlock, images: ReadonlyMap<string, ResolvedExportImage>): Content[] {
  switch (block.type) {
    case "paragraph": return [{ text: inlineContent(block.content), margin: [0, 0, 0, 8] }];
    case "heading": {
      const text = inlineContent(block.content);
      return [{
        text,
        style: `h${block.level}`,
        headlineLevel: Math.min(6, block.level + 1),
        outline: true,
        outlineText: block.content.map((inline) => inline.text).join(""),
      }];
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const items = block.items.map((item) => {
        const text = plainBlocks(item.blocks);
        return block.type === "taskList" ? `${item.checked ? "[x]" : "[ ]"} ${text}` : text;
      });
      return [{
        [block.type === "orderedList" ? "ol" : "ul"]: items,
        margin: [12, 0, 0, 8],
      } as unknown as Content];
    }
    case "blockquote": return [{ text: plainBlocks(block.blocks), style: "quote" }];
    case "codeBlock": return [{ text: `${block.language ? `${block.language}\n` : ""}${block.code}`, style: "code" }];
    case "attachment": return [{ text: `[附件：${block.title}]`, margin: [0, 0, 0, 8] }];
    case "image": {
      const image = images.get(block.id);
      if (!image) return [{ text: imagePlaceholder(block), color: "#5f6368", margin: [0, 4, 0, 8] }];
      const requestedWidth = Math.max(80, Math.min(A4_BODY_WIDTH_PT, (block.widthPx ?? 640) * 0.75));
      const content: ContentImage = {
        image: bytesToDataUrl(image.bytes, image.mimeType),
        width: requestedWidth,
        margin: [0, 4, 0, block.alt || block.title ? 2 : 8],
      };
      const alternative = block.alt ?? block.title;
      return alternative
        ? [content, { text: `图片：${alternative}`, color: "#5f6368", fontSize: 8, margin: [0, 0, 0, 8] }]
        : [content];
    }
    case "table": return [renderTable(block, images)];
  }
}

function renderTable(
  block: Extract<ExportBlock, { type: "table" }>,
  images: ReadonlyMap<string, ResolvedExportImage>,
): ContentTable {
  const columnCount = Math.max(1, ...block.rows.map((row) => row.cells.length));
  return {
    table: {
      headerRows: block.rows[0]?.cells.some((cell) => cell.header) ? 1 : 0,
      widths: Array.from({ length: columnCount }, () => "*"),
      dontBreakRows: true,
      body: block.rows.map((row, rowIndex) => Array.from({ length: columnCount }, (_, index) => {
        const cell = row.cells[index];
        return {
          stack: cell ? cell.blocks.flatMap((nested) => renderBlock(nested, images)) : [{ text: "" }],
          bold: rowIndex === 0 && Boolean(cell?.header),
          fillColor: rowIndex === 0 && cell?.header ? "#f2f4f7" : undefined,
          margin: [5, 4, 5, 4],
        };
      })),
    },
    layout: {
      hLineColor: () => "#dadce0",
      vLineColor: () => "#dadce0",
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
    },
    margin: [0, 4, 0, 10],
  };
}

function inlineContent(inlines: ExportInline[]): Content {
  return inlines.map((inline): ContentText => ({
    text: inline.text,
    bold: inline.bold,
    italics: inline.italic,
    decoration: inline.strike ? "lineThrough" : undefined,
    font: inline.code ? PDF_FONT_NAME : undefined,
    background: inline.code ? "#f2f4f7" : undefined,
    link: inline.href,
    color: inline.href ? "#1a73e8" : undefined,
  }));
}

function headingStyle(sizePx: number, document: RecordExportDocument) {
  return {
    font: PDF_FONT_NAME,
    fontSize: pxToPoints(sizePx),
    bold: true,
    lineHeight: document.style.headings.lineHeight,
    margin: [
      0,
      pxToPoints(document.style.headings.paragraphSpacingBeforePx),
      0,
      Math.max(4, pxToPoints(document.style.headings.paragraphSpacingAfterPx)),
    ] as [number, number, number, number],
  };
}

function plainBlocks(blocks: ExportBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph" || block.type === "heading") return block.content.map((inline) => inline.text).join("");
    if (block.type === "codeBlock") return block.code;
    if (block.type === "attachment") return `[附件：${block.title}]`;
    if (block.type === "image") return imagePlaceholder(block);
    if (block.type === "blockquote") return plainBlocks(block.blocks);
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") return block.items.map((item) => plainBlocks(item.blocks)).join("；");
    if (block.type === "table") return block.rows.map((row) => row.cells.map((cell) => plainBlocks(cell.blocks)).join(" | ")).join("；");
    return "";
  }).join("\n");
}

function imagePlaceholder(block: Extract<ExportBlock, { type: "image" }>) {
  const label = block.alt ?? block.title;
  return label ? `[图片未导出：${label}]` : "[图片未导出]";
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function pxToPoints(px: number) {
  return px * 0.75;
}

function formatVisualDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
