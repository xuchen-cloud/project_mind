import { describe, expect, it } from "vitest";

import {
  buildImageAnnotationPreviewMarkup,
  commitTextAnnotation,
  createEmptyImageAnnotationDocument,
  normalizeImageAnnotationDocument,
  serializeImageAnnotationState,
  zoomViewportAtPoint,
} from "./image-annotations";

describe("image annotations", () => {
  it("falls back to an empty document when the annotation payload is invalid", () => {
    const documentState = normalizeImageAnnotationDocument("nope", {
      width: 320,
      height: 180,
    });

    expect(documentState.image).toEqual({ width: 320, height: 180 });
    expect(documentState.items).toEqual([]);
  });

  it("serializes and normalizes annotation documents", () => {
    const serialized = serializeImageAnnotationState({
      version: 1,
      image: { width: 1200, height: 800 },
      items: [
        {
          id: "rect-1",
          type: "rect",
          rotation: 0,
          x: 30,
          y: 48,
          width: 180,
          height: 96,
        },
      ],
    });

    expect(serialized).toContain('"type":"rect"');
    expect(serialized).toContain('"width":1200');
  });

  it("returns null when there are no saved annotation items", () => {
    expect(
      serializeImageAnnotationState(createEmptyImageAnnotationDocument({ width: 640, height: 360 })),
    ).toBeNull();
  });

  it("keeps the same image point under the cursor when zooming", () => {
    const nextViewport = zoomViewportAtPoint({
      viewport: {
        scale: 1,
        x: 80,
        y: 40,
      },
      nextScale: 2,
      pointer: {
        x: 180,
        y: 140,
      },
    });

    expect(nextViewport).toEqual({
      scale: 2,
      x: -20,
      y: -60,
    });
  });

  it("drops empty text annotations and keeps trimmed content", () => {
    const trimmed = commitTextAnnotation(
      {
        id: "text-1",
        type: "text",
        rotation: 0,
        x: 20,
        y: 30,
        width: 220,
        fontSize: 28,
        text: "",
      },
      "  需要重点查看这个区域  ",
    );

    expect(trimmed?.text).toBe("需要重点查看这个区域");
    expect(
      commitTextAnnotation(
        {
          id: "text-1",
          type: "text",
          rotation: 0,
          x: 20,
          y: 30,
          width: 220,
          fontSize: 28,
          text: "",
        },
        "   ",
      ),
    ).toBeNull();
  });

  it("builds preview markup for ink, rect, ellipse, and text annotations", () => {
    const markup = buildImageAnnotationPreviewMarkup(
      JSON.stringify({
        version: 1,
        image: { width: 1200, height: 800 },
        items: [
          {
            id: "ink-1",
            type: "ink",
            rotation: 0,
            points: [10, 10, 40, 40, 80, 50],
            strokeWidth: 6,
          },
          {
            id: "rect-1",
            type: "rect",
            rotation: 0,
            x: 120,
            y: 80,
            width: 200,
            height: 100,
          },
          {
            id: "ellipse-1",
            type: "ellipse",
            rotation: 8,
            x: 420,
            y: 120,
            width: 180,
            height: 110,
          },
          {
            id: "text-1",
            type: "text",
            rotation: 0,
            x: 200,
            y: 260,
            width: 220,
            fontSize: 28,
            text: "放大查看",
          },
        ],
      }),
    );

    expect(markup).toContain("<polyline");
    expect(markup).toContain("<rect");
    expect(markup).toContain("<ellipse");
    expect(markup).toContain("<text");
    expect(markup).toContain("放大查看");
  });
});
