import { generateMarkdown } from "./markdownGenerator";
import { projectRecordExportDocument, type ExportBlock, type RecordExportSource } from "./recordExportModel";

export type { RecordExportSource } from "./recordExportModel";

export type RecordExportStage = "preparing" | "images" | "generating" | "writing" | "completed";

export interface RecordExportPlatform {
  saveCommittedContent: () => Promise<RecordExportSource>;
  resolveImage: (
    input: Extract<ExportBlock, { type: "image" }>,
    format: RecordExportRequest["format"],
    signal?: AbortSignal,
  ) => Promise<ResolvedExportImage | MissingExportImage>;
  availableBytes: (targetPath: string) => Promise<number>;
  loadPdfFont: () => Promise<Uint8Array>;
  writeAtomically: (input: { targetPath: string; bytes: Uint8Array; overwrite?: boolean; signal?: AbortSignal }) => Promise<string>;
}

export interface ResolvedExportImage {
  kind: "resolved";
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
  widthPx?: number;
  heightPx?: number;
}

export interface MissingExportImage {
  kind: "missing";
  label: string;
  reason: string;
}

export interface RecordExportRequest {
  format: "markdown" | "docx" | "pdf";
  includeImages?: boolean;
  missingImageBehavior?: "ask" | "placeholder";
  targetPath: string;
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: { stage: RecordExportStage }) => void;
}

export type RecordExportResult =
  | {
      kind: "success";
      path: string;
      warnings: string[];
      fontSubstituted: boolean;
    }
  | {
      kind: "missing-images";
      missing: Array<{ label: string; reason: string }>;
    };

export function createRecordExportCoordinator(platform: RecordExportPlatform) {
  return {
    async export(request: RecordExportRequest): Promise<RecordExportResult> {
      ensureNotCancelled(request.signal);
      request.onProgress?.({ stage: "preparing" });
      const source = await platform.saveCommittedContent();
      ensureNotCancelled(request.signal);
      const document = projectRecordExportDocument(source);
      if (!document.title && !document.projectName && !document.updatedAt && document.tags.length === 0 && document.blocks.every(isEmptyBlock)) {
        throw new Error("没有可导出的内容");
      }
      const generated = request.format === "markdown"
        ? await generateMarkdownOutput(document, platform, request)
        : request.format === "docx"
          ? await generateDocxOutput(document, platform, request)
          : await generatePdfOutput(document, platform, request);
      if (generated.missing.length > 0 && request.missingImageBehavior !== "placeholder") {
        return { kind: "missing-images", missing: generated.missing };
      }
      const { bytes } = generated;
      await validateGeneratedArtifact(bytes, request);
      ensureNotCancelled(request.signal);
      const availableBytes = await platform.availableBytes(request.targetPath);
      if (availableBytes < bytes.byteLength * 2) {
        throw new Error("可用磁盘空间不足，无法完成导出");
      }
      ensureNotCancelled(request.signal);
      request.onProgress?.({ stage: "writing" });
      const path = await platform.writeAtomically({
        targetPath: request.targetPath,
        bytes,
        overwrite: request.overwrite,
        signal: request.signal,
      });
      request.onProgress?.({ stage: "completed" });
      return {
        kind: "success",
        path,
        warnings: [
          ...(generated.missing.length > 0 ? [`${generated.missing.length} 张图片未能导出`] : []),
          ...(generated.fontSubstituted ? ["所选字体不可嵌入，已使用 Noto Sans CJK SC"] : []),
        ],
        fontSubstituted: generated.fontSubstituted ?? false,
      };
    },
  };
}

async function validateGeneratedArtifact(bytes: Uint8Array, request: RecordExportRequest) {
  if (bytes.byteLength === 0) throw new Error("导出产物为空");
  if (request.format === "pdf") {
    const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
    const suffix = new TextDecoder("ascii").decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
    if (!prefix.startsWith("%PDF-") || !suffix.includes("%%EOF")) throw new Error("PDF 完整性验证失败");
    return;
  }
  const markdownArchive = request.format === "markdown" && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (request.format === "docx" || markdownArchive) {
    const { unzipSync } = await import("fflate");
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error(request.format === "docx" ? "DOCX 完整性验证失败" : "ZIP 完整性验证失败");
    }
    if (request.format === "docx") {
      if (!entries["[Content_Types].xml"] || !entries["word/document.xml"]) throw new Error("DOCX 结构不完整");
    } else if (!Object.keys(entries).some((name) => name.endsWith(".md"))) {
      throw new Error("ZIP 中缺少 Markdown 文件");
    }
  }
}

async function generateMarkdownOutput(
  document: ReturnType<typeof projectRecordExportDocument>,
  platform: RecordExportPlatform,
  request: RecordExportRequest,
) {
  const withImages = request.includeImages && collectImages(document.blocks).length > 0;
  if (!withImages) request.onProgress?.({ stage: "generating" });
  return withImages
    ? generateMarkdownArchive(document, platform, request)
    : { bytes: new TextEncoder().encode(generateMarkdown(document)), missing: [], fontSubstituted: false };
}

async function generateDocxOutput(
  document: ReturnType<typeof projectRecordExportDocument>,
  platform: RecordExportPlatform,
  request: RecordExportRequest,
) {
  const { images, missing } = await resolveImages(document.blocks, platform, request);
  request.onProgress?.({ stage: "generating" });
  const { generateDocx } = await import("./docxGenerator");
  return { bytes: await generateDocx(document, images), missing, fontSubstituted: false };
}

async function generatePdfOutput(
  document: ReturnType<typeof projectRecordExportDocument>,
  platform: RecordExportPlatform,
  request: RecordExportRequest,
) {
  const { images, missing } = await resolveImages(document.blocks, platform, request);
  request.onProgress?.({ stage: "generating" });
  const [fontBytes, { generatePdf }] = await Promise.all([
    platform.loadPdfFont(),
    import("./pdfGenerator"),
  ]);
  const requestedFonts = [document.style.body.fontFamily, document.style.headings.fontFamily, document.style.list.fontFamily];
  const fontSubstituted = requestedFonts.some((selection) => selection.source === "system" || selection.value === "work_sans" || selection.value === "source_serif");
  return { bytes: await generatePdf(document, images, fontBytes), missing, fontSubstituted };
}

async function resolveImages(
  blocks: ExportBlock[],
  platform: RecordExportPlatform,
  request: RecordExportRequest,
) {
  const images = new Map<string, ResolvedExportImage>();
  const missing: Array<{ label: string; reason: string }> = [];
  const imageBlocks = collectImages(blocks);
  if (imageBlocks.length > 0) request.onProgress?.({ stage: "images" });
  for (const image of imageBlocks) {
    ensureNotCancelled(request.signal);
    const resolved = await platform.resolveImage(image, request.format, request.signal);
    if (resolved.kind === "missing") missing.push({ label: resolved.label, reason: resolved.reason });
    else images.set(image.id, resolved);
  }
  return { images, missing };
}

async function generateMarkdownArchive(
  document: ReturnType<typeof projectRecordExportDocument>,
  platform: RecordExportPlatform,
  request: RecordExportRequest,
) {
  request.onProgress?.({ stage: "images" });
  const images = collectImages(document.blocks);
  const references = new Map<string, string>();
  const resources = new Map<string, { name: string; bytes: Uint8Array }>();
  const missing: Array<{ label: string; reason: string }> = [];
  for (const image of images) {
    ensureNotCancelled(request.signal);
    const resolved = await platform.resolveImage(image, request.format, request.signal);
    if (resolved.kind === "missing") {
      missing.push({ label: resolved.label, reason: resolved.reason });
      continue;
    }
    const visualKey = bytesKey(resolved.bytes);
    let resource = resources.get(visualKey);
    if (!resource) {
      const name = `images/image-${String(resources.size + 1).padStart(3, "0")}.${safeExtension(resolved.extension)}`;
      resource = { name, bytes: resolved.bytes };
      resources.set(visualKey, resource);
    }
    references.set(image.id, resource.name);
  }
  request.onProgress?.({ stage: "generating" });
  const stem = portableStem(request.targetPath);
  const markdown = new TextEncoder().encode(generateMarkdown(document, { imageReferences: references }));
  const { zipSync } = await import("fflate");
  return {
    bytes: zipSync({
      [`${stem}.md`]: markdown,
      ...Object.fromEntries(Array.from(resources.values()).map((resource) => [resource.name, resource.bytes])),
    }),
    missing,
    fontSubstituted: false,
  };
}

function collectImages(blocks: ExportBlock[]): Array<Extract<ExportBlock, { type: "image" }>> {
  return blocks.flatMap((block): Array<Extract<ExportBlock, { type: "image" }>> => {
    if (block.type === "image") return [block];
    if (block.type === "blockquote") return collectImages(block.blocks);
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      return block.items.flatMap((item) => collectImages(item.blocks));
    }
    if (block.type === "table") return block.rows.flatMap((row) => row.cells.flatMap((cell) => collectImages(cell.blocks)));
    return [];
  });
}

function bytesKey(bytes: Uint8Array) {
  let key = `${bytes.byteLength}:`;
  for (const byte of bytes) key += byte.toString(16).padStart(2, "0");
  return key;
}

function portableStem(path: string) {
  const parts = path.split(/[\\/]/u);
  const fileName = parts[parts.length - 1] ?? "未命名记录";
  const stem = fileName.replace(/\.[^.]+$/u, "").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").trim();
  return stem || "未命名记录";
}

function safeExtension(extension: string) {
  const normalized = extension.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized || "png";
}

function isEmptyBlock(block: ReturnType<typeof projectRecordExportDocument>["blocks"][number]) {
  return block.type === "paragraph" && block.content.every((inline) => inline.text.trim().length === 0);
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
}
