import notoSansCjkUrl from "../../assets/fonts/NotoSansCJKsc-Regular.otf?url";
import notoSansMonoCjkUrl from "../../assets/fonts/NotoSansMonoCJKsc-Regular.otf?url";
import { getErrorMessage } from "../../lib/errors";
import { parseImageAnnotationState } from "../../components/rich-editor/image-annotations";
import { desktopApi } from "../../services/desktopApi";
import type {
  RecordExportPlatform,
  RecordExportRequest,
  RecordExportResult,
  RecordExportSource,
  ResolvedExportImage,
} from "./recordExport";
import { createRecordExportCoordinator } from "./recordExport";
import type { ExportBlock } from "./recordExportModel";

export function createDesktopRecordExporter(
  saveCommittedContent: () => Promise<RecordExportSource>,
): (request: RecordExportRequest) => Promise<RecordExportResult> {
  const coordinator = createRecordExportCoordinator(
    createDesktopRecordExportPlatform(saveCommittedContent),
  );
  return (request) => coordinator.export(request);
}

export function createDesktopRecordExportPlatform(
  saveCommittedContent: () => Promise<RecordExportSource>,
): RecordExportPlatform {
  return {
    saveCommittedContent,
    async resolveImage(image, format, signal) {
      const requestId = createExportImageRequestId();
      const cancelNativeRequest = () => {
        void desktopApi.cancelExportImage(requestId).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancelNativeRequest, { once: true });
      try {
        ensureNotCancelled(signal);
        const native = await desktopApi.resolveExportImage({
          source: image.source || undefined,
          path: image.path,
          mimeType: image.mimeType,
          requestId,
        });
        ensureNotCancelled(signal);
        const resolved: ResolvedExportImage = {
          kind: "resolved",
          bytes: base64ToBytes(native.dataBase64),
          extension: native.extension,
          mimeType: native.mimeType,
          widthPx: native.widthPx ?? undefined,
          heightPx: native.heightPx ?? undefined,
        };
        if (needsRasterCopy(image, resolved, format)) {
          return await rasterizeExportImage(resolved, image.annotationState, signal);
        }
        return resolved;
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          throw new DOMException("导出已取消", "AbortError");
        }
        return {
          kind: "missing",
          label: image.alt ?? image.title ?? "图片",
          reason: getErrorMessage(error, "图片无法读取"),
        };
      } finally {
        signal?.removeEventListener("abort", cancelNativeRequest);
      }
    },
    availableBytes: (targetPath) => desktopApi.exportAvailableBytes(targetPath),
    loadPdfFonts: async () => {
      const [sansResponse, monoResponse] = await Promise.all([
        fetch(notoSansCjkUrl),
        fetch(notoSansMonoCjkUrl),
      ]);
      if (!sansResponse.ok || !monoResponse.ok) throw new Error("无法加载 PDF 中文回退字体");
      return {
        sans: new Uint8Array(await sansResponse.arrayBuffer()),
        mono: new Uint8Array(await monoResponse.arrayBuffer()),
      };
    },
    writeAtomically: async ({ targetPath, bytes, overwrite, signal }) => {
      ensureNotCancelled(signal);
      const requestId = createExportImageRequestId();
      const cancelNativeWrite = () => {
        void desktopApi.cancelExportWrite(requestId).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancelNativeWrite, { once: true });
      try {
        return await desktopApi.writeExportFile({
          targetPath,
          dataBase64: await bytesToBase64Cancellable(bytes, signal),
          overwrite,
          requestId,
        });
      } finally {
        signal?.removeEventListener("abort", cancelNativeWrite);
      }
    },
  };
}

function createExportImageRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `record-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function needsRasterCopy(
  image: Extract<ExportBlock, { type: "image" }>,
  resolved: ResolvedExportImage,
  format: RecordExportRequest["format"],
) {
  if (image.annotationState) return true;
  if (format === "markdown") {
    return !["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(resolved.extension.toLowerCase());
  }
  return !["png", "jpg", "jpeg"].includes(resolved.extension.toLowerCase());
}

async function rasterizeExportImage(
  source: ResolvedExportImage,
  annotationState: string | undefined,
  signal?: AbortSignal,
): Promise<ResolvedExportImage> {
  const bitmap = await abortableOperation(
    decodeBitmap(source.bytes, source.mimeType),
    signal,
    (lateBitmap) => lateBitmap.close?.(),
  );
  ensureNotCancelled(signal);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前系统无法创建图片导出画布");
  context.drawImage(bitmap.image, 0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  if (annotationState) drawAnnotations(context, annotationState, bitmap.width, bitmap.height);
  ensureNotCancelled(signal);
  const blob = await abortableOperation(canvasToBlob(canvas), signal);
  return {
    kind: "resolved",
    bytes: new Uint8Array(await blob.arrayBuffer()),
    extension: "png",
    mimeType: "image/png",
    widthPx: canvas.width,
    heightPx: canvas.height,
  };
}

async function decodeBitmap(bytes: Uint8Array, mimeType: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  if (typeof createImageBitmap === "function") {
    const image = await createImageBitmap(blob);
    return { image, width: image.width, height: image.height, close: () => image.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片无法解码"));
      element.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawAnnotations(
  context: CanvasRenderingContext2D,
  raw: string,
  width: number,
  height: number,
) {
  const annotation = parseImageAnnotationState(raw, { width, height });
  const scaleX = width / annotation.image.width;
  const scaleY = height / annotation.image.height;
  context.save();
  context.scale(scaleX, scaleY);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(212, 76, 71, 0.95)";
  context.fillStyle = "rgba(212, 76, 71, 0.12)";
  for (const item of annotation.items) {
    context.save();
    if (item.type === "ink") {
      context.lineWidth = item.strokeWidth;
      context.beginPath();
      for (let index = 0; index + 1 < item.points.length; index += 2) {
        const operation = index === 0 ? "moveTo" : "lineTo";
        context[operation](item.points[index], item.points[index + 1]);
      }
      context.stroke();
    } else if (item.type === "rect" || item.type === "ellipse") {
      rotateContext(context, item.rotation, item.x + item.width / 2, item.y + item.height / 2);
      context.lineWidth = 4;
      context.beginPath();
      if (item.type === "rect") context.roundRect(item.x, item.y, item.width, item.height, 8);
      else context.ellipse(item.x + item.width / 2, item.y + item.height / 2, item.width / 2, item.height / 2, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    } else {
      rotateContext(context, item.rotation, item.x, item.y);
      context.font = `600 ${item.fontSize}px "Noto Sans SC", sans-serif`;
      context.textBaseline = "top";
      context.lineWidth = 1.6;
      context.strokeStyle = "rgba(255, 255, 255, 0.84)";
      context.fillStyle = "rgba(157, 54, 49, 0.98)";
      wrapAnnotationText(item.text, item.width, item.fontSize).forEach((line, index) => {
        const y = item.y + index * item.fontSize * 1.35;
        context.strokeText(line, item.x, y, item.width);
        context.fillText(line, item.x, y, item.width);
      });
    }
    context.restore();
  }
  context.restore();
}

function rotateContext(context: CanvasRenderingContext2D, rotation: number, x: number, y: number) {
  if (!rotation) return;
  context.translate(x, y);
  context.rotate(rotation * Math.PI / 180);
  context.translate(-x, -y);
}

function wrapAnnotationText(text: string, width: number, fontSize: number) {
  const maxChars = Math.max(1, Math.floor(width / Math.max(fontSize * 0.62, 8)));
  return text.split("\n").flatMap((line) => {
    const result: string[] = [];
    let remaining = line;
    while (remaining.length > maxChars) {
      result.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    result.push(remaining);
    return result;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片批注副本生成失败"));
    }, "image/png");
  });
}

function abortableOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onLateResult?: (value: T) => void,
) {
  if (!signal) return operation;
  ensureNotCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      reject(new DOMException("导出已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (aborted) onLateResult?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (!aborted) reject(error);
      },
    );
  });
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function bytesToBase64Cancellable(bytes: Uint8Array, signal?: AbortSignal) {
  const parts: string[] = [];
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    ensureNotCancelled(signal);
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    if (offset > 0 && offset % (chunkSize * 16) === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  ensureNotCancelled(signal);
  return btoa(parts.join(""));
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("导出已取消", "AbortError");
}
