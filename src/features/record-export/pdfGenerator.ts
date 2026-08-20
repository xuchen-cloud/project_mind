import PDFDocument from "pdfkit/js/pdfkit.standalone.js";

import type { ResolvedExportImage } from "./recordExport";
import type { ExportBlock, ExportInline, RecordExportDocument } from "./recordExportModel";
import { exportImagePlaceholder, formatExportVisualDate, plainExportBlocks } from "./exportPresentation";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56.7;
const BOTTOM_MARGIN = 64;
const BODY_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT_NAME = "ProjectMindNoto";
const MONO_FONT_NAME = "ProjectMindNotoMono";

export async function generatePdf(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fontBytes: { sans: Uint8Array; mono: Uint8Array },
  signal?: AbortSignal,
) {
  if (typeof Worker === "undefined") return generatePdfInCurrentThread(document, images, fontBytes, signal);
  return runPdfWorker(document, images, fontBytes, signal);
}

export async function generatePdfInCurrentThread(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fontBytes: { sans: Uint8Array; mono: Uint8Array },
  signal?: AbortSignal,
) {
  ensureNotCancelled(signal);
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, right: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN },
    bufferPages: true,
    tagged: true,
    displayTitle: true,
    info: {
      Title: document.title ?? "Record Export",
      Author: "ProjectMind",
      Creator: "ProjectMind",
      Producer: "ProjectMind",
      Subject: "A portable copy of committed Record content.",
    },
  });
  pdf.registerFont(FONT_NAME, exactArrayBuffer(fontBytes.sans));
  pdf.registerFont(MONO_FONT_NAME, exactArrayBuffer(fontBytes.mono));
  pdf.font(FONT_NAME);
  const root = pdf.struct("Document");
  pdf.addStructure(root);

  if (document.title) {
    addHeading(pdf, root, document.title, "H1", Math.max(20, pxToPoints(document.style.headings.h1SizePx) + 2), 10);
  }
  const metadata = [
    document.projectName ? `Project：${document.projectName}` : null,
    document.tags.length > 0 ? `Tags：${document.tags.map((tag) => `#${tag}`).join(" ")}` : null,
    document.updatedAt ? `最后更新：${formatExportVisualDate(document.updatedAt)}` : null,
  ].filter((line): line is string => Boolean(line));
  if (metadata.length > 0) {
    addText(pdf, root, metadata.join("  ·  "), "P", {
      fontSize: Math.max(9, pxToPoints(document.style.body.fontSizePx) - 1),
      color: "#5f6368",
      after: 14,
    });
  }
  for (const block of document.blocks) {
    await yieldForCancellation(signal);
    await renderBlock(pdf, root, block, images, document, signal);
  }
  root.end();

  const range = pdf.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    pdf.switchToPage(range.start + index);
    const bottomMargin = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.markContent("Artifact");
    pdf.font(FONT_NAME).fontSize(9).fillColor("#777777");
    pdf.text(`${index + 1} / ${range.count}`, MARGIN, PAGE_HEIGHT - 40, {
      width: BODY_WIDTH,
      align: "center",
      lineBreak: false,
    });
    pdf.endMarkedContent();
    pdf.page.margins.bottom = bottomMargin;
  }

  const result = new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const abort = () => pdf.destroy(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    pdf.on("data", (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
    pdf.on("error", (error: Error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    pdf.on("end", () => {
      signal?.removeEventListener("abort", abort);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(bytes);
    });
  });
  pdf.end();
  return result;
}

function runPdfWorker(
  document: RecordExportDocument,
  images: ReadonlyMap<string, ResolvedExportImage>,
  fontBytes: { sans: Uint8Array; mono: Uint8Array },
  signal?: AbortSignal,
) {
  ensureNotCancelled(signal);
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL("./pdfExportWorker.ts", import.meta.url), { type: "module" });
    const abort = () => {
      worker.terminate();
      reject(abortError());
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
      reject(new Error(event.message || "PDF 生成失败"));
    };
    worker.postMessage({ document, images: Array.from(images.entries()), fontBytes });
  });
}

async function renderList(
  pdf: PDFKit.PDFDocument,
  parent: PDFKit.PDFStructureElement,
  block: Extract<ExportBlock, { type: "bulletList" | "orderedList" | "taskList" }>,
  images: ReadonlyMap<string, ResolvedExportImage>,
  document: RecordExportDocument,
  signal: AbortSignal | undefined,
  width: number,
) {
  const list = pdf.struct("L");
  parent.add(list);
  const fontSize = pxToPoints(document.style.list.fontSizePx);
  for (const [index, item] of block.items.entries()) {
    await yieldForCancellation(signal);
    ensureSpace(pdf, fontSize * document.style.list.lineHeight + 6);
    const itemStructure = pdf.struct("LI");
    const label = pdf.struct("Lbl");
    const body = pdf.struct("LBody");
    list.add(itemStructure);
    itemStructure.add(label);
    itemStructure.add(body);
    const startX = pdf.x;
    const startY = pdf.y;
    const marker = block.type === "orderedList"
      ? `${index + 1}.`
      : block.type === "taskList"
        ? item.checked ? "[x]" : "[ ]"
        : "•";
    label.add(pdf.markStructureContent("Lbl"));
    pdf.font(FONT_NAME).fontSize(fontSize).fillColor("#202124").text(marker, startX, startY, {
      lineBreak: false,
    });
    pdf.endMarkedContent();
    label.end();
    pdf.x = startX + 24;
    pdf.y = startY;
    if (item.blocks.length === 0) {
      addText(pdf, body, " ", "P", { fontSize, width: width - 24 });
    } else {
      for (const nested of item.blocks) {
        await renderBlock(pdf, body, nested, images, document, signal, width - 24);
      }
    }
    body.end();
    itemStructure.end();
    pdf.x = startX;
    pdf.y = Math.max(pdf.y, startY + fontSize * document.style.list.lineHeight) + 2;
  }
  list.end();
  pdf.moveDown(0.2);
}

async function renderTable(
  pdf: PDFKit.PDFDocument,
  parent: PDFKit.PDFStructureElement,
  block: Extract<ExportBlock, { type: "table" }>,
  images: ReadonlyMap<string, ResolvedExportImage>,
  document: RecordExportDocument,
  signal: AbortSignal | undefined,
  width: number,
) {
  if (block.rows.length === 0) return;
  const table = pdf.struct("Table");
  parent.add(table);
  const columnCount = Math.max(1, ...block.rows.map((row) => row.cells.length));
  const columnWidth = width / columnCount;
  const padding = 6;
  for (const row of block.rows) {
    await yieldForCancellation(signal);
    const rowHeight = Math.max(28, ...Array.from({ length: columnCount }, (_, index) => (
      measureBlocks(pdf, row.cells[index]?.blocks ?? [], images, document, Math.max(24, columnWidth - padding * 2)) + padding * 2
    )));
    ensureSpace(pdf, rowHeight);
    const startX = pdf.x;
    const startY = pdf.y;
    pdf.markContent("Artifact");
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row.cells[index];
      pdf.save();
      if (cell?.header) pdf.fillColor("#f2f4f7").rect(startX + index * columnWidth, startY, columnWidth, rowHeight).fill();
      pdf.strokeColor("#dadce0").lineWidth(0.6).rect(startX + index * columnWidth, startY, columnWidth, rowHeight).stroke();
      pdf.restore();
    }
    pdf.endMarkedContent();
    const rowStructure = pdf.struct("TR");
    table.add(rowStructure);
    for (let index = 0; index < columnCount; index += 1) {
      const cell = row.cells[index];
      const cellStructure = pdf.struct(cell?.header ? "TH" : "TD");
      rowStructure.add(cellStructure);
      pdf.x = startX + index * columnWidth + padding;
      pdf.y = startY + padding;
      if (!cell || cell.blocks.length === 0) {
        addText(pdf, cellStructure, " ", "P", { fontSize: Math.max(8, pxToPoints(document.style.body.fontSizePx) - 1), width: columnWidth - padding * 2 });
      } else {
        for (const nested of cell.blocks) {
          await renderBlock(pdf, cellStructure, nested, images, document, signal, columnWidth - padding * 2);
        }
      }
      cellStructure.end();
    }
    rowStructure.end();
    pdf.x = startX;
    pdf.y = startY + rowHeight;
  }
  table.end();
  pdf.moveDown(0.5);
}

function measureBlocks(
  pdf: PDFKit.PDFDocument,
  blocks: ExportBlock[],
  images: ReadonlyMap<string, ResolvedExportImage>,
  document: RecordExportDocument,
  width: number,
): number {
  const bodySize = pxToPoints(document.style.body.fontSizePx);
  return blocks.reduce((total, block) => {
    if (block.type === "image") {
      const image = images.get(block.id);
      if (!image) return total + bodySize * 1.5 + 8;
      const imageWidth = Math.min(width, (block.widthPx ?? image.widthPx ?? 640) * 0.75);
      const aspect = image.widthPx && image.heightPx ? image.heightPx / image.widthPx : 0.75;
      return total + imageWidth * aspect + 24;
    }
    if (block.type === "paragraph" || block.type === "heading") {
      const text = block.content.map((inline) => inline.text).join("") || " ";
      const fontSize = block.type === "heading"
        ? pxToPoints([document.style.headings.h1SizePx, document.style.headings.h2SizePx, document.style.headings.h3SizePx][block.level - 1])
        : bodySize;
      pdf.font(FONT_NAME).fontSize(fontSize);
      return total + pdf.heightOfString(text, { width, lineGap: 2 }) + 8;
    }
    if (block.type === "codeBlock") {
      const text = `${block.language ? `${block.language}\n` : ""}${block.code}`;
      pdf.font(codeFontFor(text)).fontSize(Math.max(8, bodySize - 1));
      return total + pdf.heightOfString(text || " ", { width: width - 16, lineGap: 2 }) + 20;
    }
    if (block.type === "blockquote") return total + measureBlocks(pdf, block.blocks, images, document, width - 12);
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      return total + block.items.reduce((sum, item) => sum + Math.max(bodySize * document.style.list.lineHeight, measureBlocks(pdf, item.blocks, images, document, width - 24)), 0);
    }
    if (block.type === "table") {
      return total + block.rows.reduce((sum, row) => sum + Math.max(28, ...row.cells.map((cell) => measureBlocks(pdf, cell.blocks, images, document, Math.max(24, width / Math.max(1, row.cells.length) - 12)) + 12)), 0);
    }
    return total + pdf.heightOfString(plainExportBlocks([block]), { width }) + 8;
  }, 0);
}

async function renderBlock(
  pdf: PDFKit.PDFDocument,
  parent: PDFKit.PDFStructureElement,
  block: ExportBlock,
  images: ReadonlyMap<string, ResolvedExportImage>,
  document: RecordExportDocument,
  signal?: AbortSignal,
  width = BODY_WIDTH,
) {
  ensureNotCancelled(signal);
  const bodySize = pxToPoints(document.style.body.fontSizePx);
  switch (block.type) {
    case "paragraph":
      addInlines(pdf, parent, block.content, bodySize, document.style.body.lineHeight, width);
      return;
    case "heading": {
      const sizes = [document.style.headings.h1SizePx, document.style.headings.h2SizePx, document.style.headings.h3SizePx];
      addHeading(pdf, parent, block.content.map((inline) => inline.text).join(""), `H${block.level}`, pxToPoints(sizes[block.level - 1]), 6, width);
      return;
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      await renderList(pdf, parent, block, images, document, signal, width);
      return;
    }
    case "blockquote": {
      const quote = pdf.struct("BlockQuote");
      parent.add(quote);
      const startX = pdf.x;
      pdf.x += 12;
      for (const nested of block.blocks) {
        await yieldForCancellation(signal);
        await renderBlock(pdf, quote, nested, images, document, signal, width - 12);
      }
      pdf.x = startX;
      quote.end();
      return;
    }
    case "codeBlock": {
      const text = `${block.language ? `${block.language}\n` : ""}${block.code}`;
      const fontSize = Math.max(8, bodySize - 1);
      const codeFont = codeFontFor(text);
      pdf.font(codeFont).fontSize(fontSize);
      const height = pdf.heightOfString(text, { width: width - 16, lineGap: 2 }) + 12;
      ensureSpace(pdf, height);
      const top = pdf.y;
      pdf.save().fillColor("#f4f6f8").rect(pdf.x, top, width, height).fill().restore();
      addText(pdf, parent, text, "Code", { fontSize, font: codeFont, x: pdf.x + 8, width: width - 16, after: 8, lineGap: 2 });
      return;
    }
    case "attachment":
      addText(pdf, parent, `[附件：${block.title}]`, "P", { fontSize: bodySize, after: 8, width });
      return;
    case "image": {
      const image = images.get(block.id);
      if (!image) {
        addText(pdf, parent, exportImagePlaceholder(block), "P", { fontSize: bodySize, color: "#5f6368", after: 8, width });
        return;
      }
      const imageWidth = Math.max(Math.min(60, width), Math.min(width, (block.widthPx ?? image.widthPx ?? 640) * 0.75));
      const aspect = image.widthPx && image.heightPx ? image.heightPx / image.widthPx : 0.75;
      const height = Math.min(PAGE_HEIGHT - MARGIN - BOTTOM_MARGIN, imageWidth * aspect);
      ensureSpace(pdf, height + 18);
      const alternative = block.alt ?? block.title ?? "Record 图片";
      const figure = pdf.struct("Figure", { alt: alternative });
      parent.add(figure);
      figure.add(pdf.markStructureContent("Figure"));
      pdf.image(exactArrayBuffer(image.bytes), { width: imageWidth, height });
      pdf.endMarkedContent();
      figure.end();
      addText(pdf, parent, `图片：${alternative}`, "Caption", { fontSize: 8, color: "#5f6368", after: 8, width });
      return;
    }
    case "table": {
      await renderTable(pdf, parent, block, images, document, signal, width);
      return;
    }
  }
}

function addHeading(pdf: PDFKit.PDFDocument, parent: PDFKit.PDFStructureElement, text: string, type: string, fontSize: number, after: number, width = BODY_WIDTH) {
  ensureSpace(pdf, fontSize * 1.8 + after);
  pdf.font(FONT_NAME).fontSize(fontSize).fillColor("#202124");
  pdf.text(text, { width, lineGap: 2, structParent: parent, structType: type });
  pdf.y += after;
}

function addInlines(pdf: PDFKit.PDFDocument, parent: PDFKit.PDFStructureElement, inlines: ExportInline[], fontSize: number, lineHeight: number, width = BODY_WIDTH) {
  if (inlines.length === 0) {
    addText(pdf, parent, "", "P", { fontSize, after: 8 });
    return;
  }
  ensureSpace(pdf, fontSize * lineHeight + 8);
  const paragraph = pdf.struct("P");
  parent.add(paragraph);
  const startX = pdf.x;
  pdf.font(FONT_NAME).fontSize(fontSize);
  const renderedLineHeight = Math.max(pdf.currentLineHeight(), fontSize * lineHeight);
  let cursorX = startX;
  let cursorY = pdf.y;
  const nextLine = () => {
    cursorX = startX;
    cursorY += renderedLineHeight;
  };
  for (const inline of inlines) {
    const inlineFont = inline.code ? codeFontFor(inline.text) : FONT_NAME;
    pdf.font(inlineFont).fontSize(fontSize).fillColor(inline.href ? "#1a73e8" : inline.code ? "#3c4043" : "#202124");
    pdf.lineWidth(inline.bold ? 0.25 : 1);
    const structure = pdf.struct(inline.href ? "Link" : "Span", inline.href ? { alt: inline.text } : undefined);
    paragraph.add(structure);
    let remaining = inline.text;
    while (remaining.length > 0) {
      if (remaining.startsWith("\n")) {
        remaining = remaining.slice(1);
        nextLine();
        continue;
      }
      const newline = remaining.indexOf("\n");
      const beforeNewline = newline >= 0 ? remaining.slice(0, newline) : remaining;
      const available = Math.max(0, startX + width - cursorX);
      const segment = fittingPrefix(pdf, beforeNewline, available);
      if (!segment && cursorX > startX) {
        nextLine();
        continue;
      }
      const drawn = segment || Array.from(beforeNewline)[0] || "";
      if (!drawn) {
        remaining = remaining.slice(1);
        nextLine();
        continue;
      }
      const segmentWidth = pdf.widthOfString(drawn);
      if (inline.code) {
        pdf.markContent("Artifact");
        pdf.save().fillColor("#f2f4f7").rect(cursorX - 1.5, cursorY - 1, segmentWidth + 3, renderedLineHeight).fill().restore();
        pdf.endMarkedContent();
        pdf.fillColor(inline.href ? "#1a73e8" : "#3c4043");
      }
      structure.add(pdf.markStructureContent(inline.href ? "Link" : "Span"));
      pdf.text(drawn, cursorX, cursorY, {
        lineBreak: false,
        underline: false,
        strike: false,
        oblique: inline.italic,
        stroke: inline.bold,
        fill: true,
      });
      pdf.endMarkedContent();
      if (inline.href || inline.strike) {
        pdf.markContent("Artifact");
        const lineY = inline.strike ? cursorY + renderedLineHeight / 2 : cursorY + renderedLineHeight - 1;
        pdf.save().strokeColor(inline.href ? "#1a73e8" : "#202124").lineWidth(0.6)
          .moveTo(cursorX, lineY).lineTo(cursorX + segmentWidth, lineY).stroke().restore();
        pdf.endMarkedContent();
      }
      if (inline.href) {
        pdf.link(cursorX, cursorY, segmentWidth, renderedLineHeight, inline.href, { structParent: structure });
      }
      cursorX += segmentWidth;
      remaining = remaining.slice(drawn.length);
      if (remaining.startsWith("\n")) {
        remaining = remaining.slice(1);
        nextLine();
      } else if (remaining.length > 0 && cursorX >= startX + width - 0.5) {
        nextLine();
      }
    }
    structure.end();
  }
  paragraph.end();
  pdf.x = startX;
  pdf.y = cursorY + renderedLineHeight + 8;
}

function fittingPrefix(pdf: PDFKit.PDFDocument, value: string, available: number) {
  if (!value || available <= 0) return "";
  if (pdf.widthOfString(value) <= available) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (pdf.widthOfString(characters.slice(0, middle).join("")) <= available) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function addText(pdf: PDFKit.PDFDocument, parent: PDFKit.PDFStructureElement, text: string, type: string, options: {
  fontSize: number;
  font?: string;
  color?: string;
  after?: number;
  x?: number;
  width?: number;
  lineGap?: number;
}) {
  const width = options.width ?? BODY_WIDTH;
  pdf.font(options.font ?? FONT_NAME).fontSize(options.fontSize).fillColor(options.color ?? "#202124");
  const height = pdf.heightOfString(text || " ", { width, lineGap: options.lineGap ?? 1 });
  ensureSpace(pdf, height + (options.after ?? 0));
  pdf.text(text || " ", options.x ?? pdf.x, pdf.y, {
    width,
    lineGap: options.lineGap ?? 1,
    structParent: parent,
    structType: type,
  });
  pdf.y += options.after ?? 0;
}

function ensureSpace(pdf: PDFKit.PDFDocument, height: number) {
  if (pdf.y + height > PAGE_HEIGHT - BOTTOM_MARGIN) pdf.addPage();
}

function exactArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pxToPoints(px: number) {
  return px * 0.75;
}

function codeFontFor(value: string) {
  return /^[\u0000-\u00ff]*$/u.test(value) ? "Courier" : MONO_FONT_NAME;
}

async function yieldForCancellation(signal?: AbortSignal) {
  ensureNotCancelled(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  ensureNotCancelled(signal);
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException("导出已取消", "AbortError");
}
