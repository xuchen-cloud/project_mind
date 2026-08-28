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
import { exportImagePlaceholder, formatExportVisualDate } from "./exportPresentation";

const A4_WIDTH_TWIPS = 11_906;
const PAGE_MARGIN_TWIPS = convertMillimetersToTwip(20);
const BODY_WIDTH_TWIPS = A4_WIDTH_TWIPS - PAGE_MARGIN_TWIPS * 2;

export async function generateDocx(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  signal?: AbortSignal,
) {
  if (typeof Worker === "undefined") return generateDocxInCurrentThread(document, images, signal);
  return runDocxWorker(document, images, signal);
}

export async function generateDocxInCurrentThread(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  signal?: AbortSignal,
) {
  ensureNotCancelled(signal);
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
    document.updatedAt ? `最后更新：${formatExportVisualDate(document.updatedAt)}` : null,
  ].filter((line): line is string => Boolean(line));
  if (metadata.length > 0) {
    children.push(new Paragraph({
      style: "RecordMetadata",
      children: [new TextRun({ text: metadata.join("  ·  "), font: bodyFont })],
    }));
  }
  for (const block of document.blocks) {
    await yieldForCancellation(signal);
    children.push(...await renderBlock(block, images, { bodyFont, headingFont, listFont }, signal));
  }

  const file = new Document({
    title: document.title,
    subject: "ProjectMind Record Export",
    creator: "ProjectMind",
    lastModifiedBy: "ProjectMind",
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
  return new Uint8Array(await abortable(Packer.toArrayBuffer(file), signal));
}

function runDocxWorker(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  signal?: AbortSignal,
) {
  ensureNotCancelled(signal);
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL("./docxExportWorker.ts", import.meta.url), { type: "module" });
    const abort = () => {
      worker.terminate();
      reject(new DOMException("导出已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(new Uint8Array(event.data.bytes ?? []));
    };
    worker.onerror = (event) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "DOCX 生成失败"));
    };
    worker.postMessage({ document, images: Array.from(images.entries()) });
  });
}

async function renderBlock(
  block: ExportBlock,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fonts: { bodyFont: string; headingFont: string; listFont: string },
  signal?: AbortSignal,
): Promise<Array<Paragraph | Table>> {
  ensureNotCancelled(signal);
  switch (block.type) {
    case "paragraph":
      return [new Paragraph({ children: inlineChildren(block.content, fonts.bodyFont) })];
    case "heading":
      return [new Paragraph({
        heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][block.level - 1],
        children: inlineChildren(block.content, fonts.headingFont),
      })];
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const rendered: Array<Paragraph | Table> = [];
      for (const item of block.items) {
        await yieldForCancellation(signal);
        const primaryIndex = item.blocks.findIndex((nested) => nested.type === "paragraph");
        const primary = primaryIndex >= 0 ? item.blocks[primaryIndex] : null;
        const inline = primary?.type === "paragraph" ? primary.content : [];
        const prefix = block.type === "taskList"
          ? `${String.fromCodePoint(item.checked ? 0x2612 : 0x2610)} `
          : "";
        const paragraph = new Paragraph({
          numbering: {
            reference: block.type === "orderedList" ? "record-decimal" : "record-bullets",
            level: 0,
          },
          children: [new TextRun({ text: prefix, font: fonts.listFont }), ...inlineChildren(inline, fonts.listFont)],
        });
        rendered.push(paragraph);
        for (const [index, nested] of item.blocks.entries()) {
          if (index !== primaryIndex) rendered.push(...await renderBlock(nested, images, fonts, signal));
        }
      }
      return rendered;
    }
    case "blockquote": {
      const rendered: Array<Paragraph | Table> = [];
      for (const nested of block.blocks) {
        await yieldForCancellation(signal);
        rendered.push(...(nested.type === "paragraph"
          ? [new Paragraph({ style: "RecordQuote", children: inlineChildren(nested.content, fonts.bodyFont) })]
          : await renderBlock(nested, images, fonts, signal)));
      }
      return rendered;
    }
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
      if (!image) return [new Paragraph({ text: exportImagePlaceholder(block) })];
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
      const rows: TableRow[] = [];
      for (const [rowIndex, row] of block.rows.entries()) {
        await yieldForCancellation(signal);
        const cells: TableCell[] = [];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
          const cell = row.cells[columnIndex];
          const cellChildren: Array<Paragraph | Table> = [];
          if (cell) {
            for (const nested of cell.blocks) cellChildren.push(...await renderBlock(nested, images, fonts, signal));
          }
          cells.push(new TableCell({
            width: { size: columnWidth, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            shading: rowIndex === 0 && cell?.header ? { type: ShadingType.CLEAR, fill: "F2F4F7" } : undefined,
            children: cellChildren.length > 0 ? cellChildren : [new Paragraph("")],
          }));
        }
        rows.push(new TableRow({
          tableHeader: rowIndex === 0 && row.cells.some((cell) => cell.header),
          cantSplit: true,
          children: cells,
        }));
      }
      return [new Table({
        width: { size: BODY_WIDTH_TWIPS, type: WidthType.DXA },
        columnWidths: Array.from({ length: columnCount }, () => columnWidth),
        layout: TableLayoutType.FIXED,
        margins: { top: 100, bottom: 100, left: 120, right: 120, marginUnitType: WidthType.DXA },
        rows,
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
      heading4: headingStyle(fonts.headingFont, document.style.headings.h4SizePx, document),
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

function pxToTwips(px: number) {
  return Math.round(px * 15);
}

async function yieldForCancellation(signal?: AbortSignal) {
  ensureNotCancelled(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  ensureNotCancelled(signal);
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) return operation;
  ensureNotCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("导出已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
}
