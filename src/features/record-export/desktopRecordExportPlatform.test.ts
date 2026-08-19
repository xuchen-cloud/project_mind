import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { desktopApi } from "../../services/desktopApi";
import { createDesktopRecordExportPlatform } from "./desktopRecordExportPlatform";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop Record Export image boundary", () => {
  it("can cancel while a large output is being encoded before native writing", async () => {
    const write = vi.spyOn(desktopApi, "writeExportFile").mockResolvedValue("/tmp/record.pdf");
    const cancel = vi.spyOn(desktopApi, "cancelExportWrite").mockResolvedValue(undefined);
    const platform = createDesktopRecordExportPlatform(async () => { throw new Error("not used"); });
    const controller = new AbortController();
    const operation = platform.writeAtomically({
      targetPath: "/tmp/record.pdf",
      bytes: new Uint8Array(20 * 1024 * 1024),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(write).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rasterizes saved annotations into a private PNG copy", async () => {
    const sourceBytes = whitePng();
    installRasterCanvas();
    vi.spyOn(desktopApi, "resolveExportImage").mockResolvedValue({
      dataBase64: Buffer.from(sourceBytes).toString("base64"),
      mimeType: "image/png",
      extension: "png",
      widthPx: 64,
      heightPx: 64,
    });
    const platform = createDesktopRecordExportPlatform(async () => { throw new Error("not used"); });

    const result = await platform.resolveImage({
      type: "image",
      id: "image-001",
      source: "asset:///managed.png",
      path: "/managed.png",
      mimeType: "image/png",
      alt: "批注图片",
      annotationState: JSON.stringify({
        version: 1,
        image: { width: 64, height: 64 },
        items: [{ id: "rect-1", type: "rect", rotation: 0, x: 8, y: 8, width: 40, height: 32 }],
      }),
    }, "markdown");

    if (result.kind !== "resolved") throw new Error(result.reason);
    expect(result.extension).toBe("png");
    expect(result.bytes).not.toEqual(sourceBytes);
    const rendered = await loadImage(Buffer.from(result.bytes));
    const canvas = createCanvas(64, 64);
    const context = canvas.getContext("2d");
    context.drawImage(rendered, 0, 0);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    let redPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 150 && pixels[offset + 1] < 150) redPixels += 1;
    }
    expect(redPixels).toBeGreaterThan(20);
  });

  it("converts a target-unstable image to PNG for DOCX and PDF", async () => {
    const sourceBytes = whitePng();
    installRasterCanvas();
    vi.spyOn(desktopApi, "resolveExportImage").mockResolvedValue({
      dataBase64: Buffer.from(sourceBytes).toString("base64"),
      mimeType: "image/webp",
      extension: "webp",
      widthPx: 64,
      heightPx: 64,
    });
    const platform = createDesktopRecordExportPlatform(async () => { throw new Error("not used"); });

    const result = await platform.resolveImage({
      type: "image",
      id: "image-001",
      source: "asset:///managed.webp",
      path: "/managed.webp",
      mimeType: "image/webp",
    }, "docx");

    if (result.kind !== "resolved") throw new Error(result.reason);
    expect(result).toMatchObject({ kind: "resolved", extension: "png", mimeType: "image/png" });
  });
});

function whitePng() {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 64, 64);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

function installRasterCanvas() {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
    Object.defineProperty(image, "close", { value: () => undefined });
    return image;
  });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
    if (tagName.toLowerCase() !== "canvas") return createElement(tagName, options);
    const canvas = createCanvas(1, 1);
    Object.defineProperty(canvas, "toBlob", {
      value: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(canvas.toBuffer("image/png"))], { type: "image/png" })),
    });
    return canvas as unknown as HTMLCanvasElement;
  });
}
