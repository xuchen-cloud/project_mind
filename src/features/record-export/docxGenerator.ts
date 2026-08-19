import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ParagraphChild,
} from "docx";

import type { ResolvedExportImage } from "./recordExport";
import type { ExportBlock, ExportInline, RecordExportDocument } from "./recordExportModel";

const A4_WIDTH_TWIPS = 11_906;
const PAGE_MARGIN_TWIPS = convertMillimetersToTwip(20);
const BODY_WIDTH_TWIPS = A4_WIDTH_TWIPS - PAGE_MARGIN_TWIPS * 2;

export async function generateDocx(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
) {
  const bodyFont = fontName(document.style.body.fontFamily);
  const headingFont = fontName(document.style.headings.fontFamily);
  const listFont = fontName(document.style.list.fontFamily);
  const children: Array<Paragraph | Table> = [];

  if (document.title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: document.title, font: headingFont })],
    }));
  }
  const metadata = [
    document.projectName ? `Project：${document.projectName}` : null,
    document.tags.length > 0 ? `Tags：${document.tags.map((tag) => `#${tag}`).join(" ")}` : null,
    document.updatedAt ? `最后更新：${formatVisualDate(document.updatedAt)}` : null,
  ].filter((line): line is string => Boolean(line));
  if (metadata.length > 0) {
    children.push(new Paragraph({
      style: "RecordMetadata",
      children: [new TextRun({ text: metadata.join("  ·  "), font: bodyFont })],
    }));
  }
  children.push(...document.blocks.flatMap((block) => renderBlock(block, images, { bodyFont, headingFont, listFont })));

  const file = new Document({
    title: document.title,
    subject: "Project Mind Record Export",
    creator: "Project Mind",
    lastModifiedBy: "Project Mind",
    description: "A portable copy of committed Record content.",
    styles: buildStyles(document, { bodyFont, headingFont, listFont }),
    numbering: {
      config: [
        {
          reference: "record-bullets",
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
        {
          reference: "record-decimal",
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: A4_WIDTH_TWIPS, height: 16_839 },
          margin: {
            top: PAGE_MARGIN_TWIPS,
            right: PAGE_MARGIN_TWIPS,
            bottom: PAGE_MARGIN_TWIPS,
            left: PAGE_MARGIN_TWIPS,
          },
        },
      },
      children,
    }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(file));
}

function renderBlock(
  block: ExportBlock,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fonts: { bodyFont: string; headingFont: string; listFont: string },
): Array<Paragraph | Table> {
  switch (block.type) {
    case "paragraph":
      return [new Paragraph({ children: inlineChildren(block.content, fonts.bodyFont) })];
    case "heading":
      return [new Paragraph({
        heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][block.level - 1],
        children: inlineChildren(block.content, fonts.headingFont),
      })];
    case "bulletList":
    case "orderedList":
    case "taskList":
      return block.items.flatMap((item) => {
        const inline = item.blocks[0]?.type === "paragraph" ? item.blocks[0].content : [{ text: plainBlocks(item.blocks) }];
        const prefix = block.type === "taskList" ? `${item.checked ? "☒" : "☐"} ` : "";
        const paragraph = new Paragraph({
          numbering: {
            reference: block.type === "orderedList" ? "record-decimal" : "record-bullets",
            level: 0,
          },
          children: [new TextRun({ text: prefix, font: fonts.listFont }), ...inlineChildren(inline, fonts.listFont)],
        });
        return [paragraph, ...item.blocks.slice(1).flatMap((nested) => renderBlock(nested, images, fonts))];
      });
    case "blockquote":
      return block.blocks.map((nested) => new Paragraph({
        style: "RecordQuote",
        children: [new TextRun({ text: plainBlocks([nested]), font: fonts.bodyFont })],
      }));
    case "codeBlock":
      return [new Paragraph({
        style: "RecordCode",
        children: [
          ...(block.language ? [new TextRun({ text: `${block.language}\n`, bold: true, font: "Courier New" })] : []),
          new TextRun({ text: block.code, font: "Courier New" }),
        ],
      })];
    case "attachment":
      return [new Paragraph({ children: [new TextRun({ text: `[附件：${block.title}]`, font: fonts.bodyFont })] })];
    case "image": {
      const image = images.get(block.id);
      if (!image) return [new Paragraph({ text: imagePlaceholder(block) })];
      const width = Math.min(640, Math.max(80, Math.round((block.widthPx ?? image.widthPx ?? 640) * 0.9)));
      const aspect = image.widthPx && image.heightPx ? image.heightPx / image.widthPx : 0.75;
      const height = Math.max(1, Math.round(width * aspect));
      return [new Paragraph({
        children: [new ImageRun({
          type: docxImageType(image.extension),
          data: image.bytes,
          transformation: { width, height },
          altText: {
            title: block.title ?? block.alt ?? "图片",
            description: block.alt ?? block.title ?? "Record 图片",
            name: block.alt ?? block.title ?? "Record 图片",
          },
        })],
      })];
    }
    case "table": {
      const columnCount = Math.max(1, ...block.rows.map((row) => row.cells.length));
      const columnWidth = Math.floor(BODY_WIDTH_TWIPS / columnCount);
      return [new Table({
        width: { size: BODY_WIDTH_TWIPS, type: WidthType.DXA },
        columnWidths: Array.from({ length: columnCount }, () => columnWidth),
        layout: TableLayoutType.FIXED,
        margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
        rows: block.rows.map((row, rowIndex) => new TableRow({
          tableHeader: rowIndex === 0 && row.cells.some((cell) => cell.header),
          cantSplit: true,
          children: Array.from({ length: columnCount }, (_, columnIndex) => {
            const cell = row.cells[columnIndex];
            return new TableCell({
              width: { size: columnWidth, type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              shading: rowIndex === 0 && cell?.header ? { type: ShadingType.CLEAR, fill: "F2F4F7" } : undefined,
              children: cell
                ? cell.blocks.flatMap((nested) => renderBlock(nested, images, fonts))
                : [new Paragraph("")],
            });
          }),
        })),
      })];
    }
  }
}

function inlineChildren(inlines: ExportInline[], font: string): ParagraphChild[] {
  return inlines.map((inline) => {
    const run = new TextRun({
      text: inline.text,
      bold: inline.bold,
      italics: inline.italic,
      strike: inline.strike,
      font: inline.code ? "Courier New" : font,
      shading: inline.code ? { type: ShadingType.CLEAR, fill: "F2F4F7" } : undefined,
    });
    return inline.href ? new ExternalHyperlink({ link: inline.href, children: [run] }) : run;
  });
}

function buildStyles(
  document: RecordExportDocument,
  fonts: { bodyFont: string; headingFont: string; listFont: string },
) {
  const bodySize = document.style.body.fontSizePx * 1.5;
  return {
    default: {
      document: {
        run: { font: fonts.bodyFont, size: bodySize, color: "202124" },
        paragraph: {
          spacing: {
            before: pxToTwips(document.style.body.paragraphSpacingBeforePx),
            after: pxToTwips(document.style.body.paragraphSpacingAfterPx),
            line: Math.round(document.style.body.lineHeight * 240),
          },
        },
      },
      title: {
        run: { font: fonts.headingFont, size: Math.max(36, document.style.headings.h1SizePx * 1.7), bold: true, color: "202124" },
        paragraph: { spacing: { before: 0, after: 160 } },
      },
      heading1: headingStyle(fonts.headingFont, document.style.headings.h1SizePx, document),
      heading2: headingStyle(fonts.headingFont, document.style.headings.h2SizePx, document),
      heading3: headingStyle(fonts.headingFont, document.style.headings.h3SizePx, document),
    },
    paragraphStyles: [
      {
        id: "RecordMetadata",
        name: "Record Metadata",
        basedOn: "Normal",
        run: { font: fonts.bodyFont, size: Math.max(18, bodySize - 2), color: "5F6368" },
        paragraph: { spacing: { before: 0, after: 200 } },
      },
      {
        id: "RecordQuote",
        name: "Record Quote",
        basedOn: "Normal",
        run: { font: fonts.bodyFont, italics: true, color: "3C4043" },
        paragraph: { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, color: "DADCE0", size: 12, space: 8 } } },
      },
      {
        id: "RecordCode",
        name: "Record Code",
        basedOn: "Normal",
        run: { font: "Courier New", size: Math.max(18, bodySize - 2) },
        paragraph: { shading: { type: ShadingType.CLEAR, fill: "F4F6F8" }, spacing: { before: 120, after: 120 } },
      },
    ],
  } as const;
}

function headingStyle(font: string, sizePx: number, document: RecordExportDocument) {
  return {
    run: { font, size: sizePx * 1.5, bold: true, color: "202124" },
    paragraph: {
      spacing: {
        before: pxToTwips(document.style.headings.paragraphSpacingBeforePx),
        after: pxToTwips(document.style.headings.paragraphSpacingAfterPx),
        line: Math.round(document.style.headings.lineHeight * 240),
      },
      keepNext: true,
    },
  };
}

function fontName(selection: RecordExportDocument["style"]["body"]["fontFamily"]) {
  if (selection.source === "system" && selection.value.trim()) return selection.value.trim();
  if (selection.value === "work_sans") return "Work Sans";
  if (selection.value === "source_serif") return "Source Serif 4";
  return "Noto Sans SC";
}

function docxImageType(extension: string): "png" | "jpg" | "gif" | "bmp" {
  const normalized = extension.toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "jpg";
  if (normalized === "gif" || normalized === "bmp") return normalized;
  return "png";
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

function pxToTwips(px: number) {
  return Math.round(px * 15);
}

function formatVisualDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
