const IMAGE_ANNOTATION_VERSION = 1;
const DEFAULT_IMAGE_WIDTH = 1600;
const DEFAULT_IMAGE_HEIGHT = 900;
const DEFAULT_STROKE_WIDTH = 6;
const DEFAULT_FONT_SIZE = 26;
const MIN_SCALE = 0.2;
const MAX_SCALE = 12;
const VIEWPORT_PADDING = 24;
const TEXT_LINE_HEIGHT = 1.35;
const PREVIEW_STROKE = "rgba(212, 76, 71, 0.95)";
const PREVIEW_FILL = "rgba(212, 76, 71, 0.12)";
const PREVIEW_TEXT = "rgba(157, 54, 49, 0.98)";

export type ImageAnnotationTool = "select" | "ink" | "rect" | "ellipse" | "text";

export interface ImageAnnotationImageSize {
  width: number;
  height: number;
}

interface ImageAnnotationItemBase {
  id: string;
  rotation: number;
}

export interface ImageAnnotationInkItem extends ImageAnnotationItemBase {
  type: "ink";
  points: number[];
  strokeWidth: number;
}

export interface ImageAnnotationRectItem extends ImageAnnotationItemBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageAnnotationEllipseItem extends ImageAnnotationItemBase {
  type: "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageAnnotationTextItem extends ImageAnnotationItemBase {
  type: "text";
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
}

export type ImageAnnotationItem =
  | ImageAnnotationInkItem
  | ImageAnnotationRectItem
  | ImageAnnotationEllipseItem
  | ImageAnnotationTextItem;

export interface ImageAnnotationDocument {
  version: 1;
  image: ImageAnnotationImageSize;
  items: ImageAnnotationItem[];
}

export interface ImageAnnotationViewport {
  scale: number;
  x: number;
  y: number;
}

export interface ImageAnnotationViewportSize {
  width: number;
  height: number;
}

export function createImageAnnotationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `annotation-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyImageAnnotationDocument(
  image?: Partial<ImageAnnotationImageSize> | null,
): ImageAnnotationDocument {
  return {
    version: IMAGE_ANNOTATION_VERSION,
    image: normalizeImageSize(image),
    items: [],
  };
}

export function parseImageAnnotationState(
  raw: string | null | undefined,
  image?: Partial<ImageAnnotationImageSize> | null,
): ImageAnnotationDocument {
  if (!raw || raw.trim().length === 0) {
    return createEmptyImageAnnotationDocument(image);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeImageAnnotationDocument(parsed, image);
  } catch {
    return createEmptyImageAnnotationDocument(image);
  }
}

export function normalizeImageAnnotationDocument(
  value: unknown,
  image?: Partial<ImageAnnotationImageSize> | null,
): ImageAnnotationDocument {
  const fallbackImage = normalizeImageSize(image);

  if (!value || typeof value !== "object") {
    return createEmptyImageAnnotationDocument(fallbackImage);
  }

  const candidate = value as {
    version?: number;
    image?: Partial<ImageAnnotationImageSize>;
    items?: unknown[];
  };

  return {
    version: IMAGE_ANNOTATION_VERSION,
    image: normalizeImageSize(candidate.image ?? fallbackImage),
    items: Array.isArray(candidate.items)
      ? candidate.items
          .map((item) => normalizeImageAnnotationItem(item))
          .filter((item): item is ImageAnnotationItem => item !== null)
      : [],
  };
}

export function serializeImageAnnotationState(
  value: ImageAnnotationDocument | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeImageAnnotationDocument(value, value.image);

  if (normalized.items.length === 0) {
    return null;
  }

  return JSON.stringify(normalized);
}

export function commitTextAnnotation(
  item: ImageAnnotationTextItem,
  nextText: string,
): ImageAnnotationTextItem | null {
  const normalizedText = nextText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  if (!normalizedText) {
    return null;
  }

  return {
    ...item,
    text: normalizedText,
  };
}

export function fitImageAnnotationViewport(
  image: ImageAnnotationImageSize,
  viewport: ImageAnnotationViewportSize,
): ImageAnnotationViewport {
  const width = Math.max(1, viewport.width - VIEWPORT_PADDING * 2);
  const height = Math.max(1, viewport.height - VIEWPORT_PADDING * 2);
  const scale = clampScale(Math.min(width / image.width, height / image.height));
  const renderedWidth = image.width * scale;
  const renderedHeight = image.height * scale;

  return {
    scale,
    x: (viewport.width - renderedWidth) / 2,
    y: (viewport.height - renderedHeight) / 2,
  };
}

export function zoomViewportAtPoint({
  viewport,
  nextScale,
  pointer,
}: {
  viewport: ImageAnnotationViewport;
  nextScale: number;
  pointer: { x: number; y: number };
}): ImageAnnotationViewport {
  const clampedScale = clampScale(nextScale);
  const imagePointX = (pointer.x - viewport.x) / viewport.scale;
  const imagePointY = (pointer.y - viewport.y) / viewport.scale;

  return {
    scale: clampedScale,
    x: pointer.x - imagePointX * clampedScale,
    y: pointer.y - imagePointY * clampedScale,
  };
}

export function buildImageAnnotationPreviewMarkup(
  raw: string | null | undefined,
  image?: Partial<ImageAnnotationImageSize> | null,
): string {
  const document = parseImageAnnotationState(raw, image);

  if (document.items.length === 0) {
    return "";
  }

  const body = document.items
    .map((item) => buildItemMarkup(item))
    .filter(Boolean)
    .join("");

  return [
    `<svg viewBox="0 0 ${document.image.width} ${document.image.height}"`,
    ` preserveAspectRatio="none"`,
    ` aria-hidden="true"`,
    ` class="rich-editor__annotation-preview-svg"`,
    ` xmlns="http://www.w3.org/2000/svg">`,
    body,
    `</svg>`,
  ].join("");
}

export function imagePointFromViewportPoint(
  viewport: ImageAnnotationViewport,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

export function normalizeDraggedShape(start: { x: number; y: number }, end: { x: number; y: number }) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return { x, y, width, height };
}

function normalizeImageAnnotationItem(value: unknown): ImageAnnotationItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeNonEmptyString(candidate.id) ?? createImageAnnotationId();
  const rotation = normalizeFiniteNumber(candidate.rotation, 0);

  switch (candidate.type) {
    case "ink": {
      const points = Array.isArray(candidate.points)
        ? candidate.points
            .map((point) => normalizeFiniteNumber(point, Number.NaN))
            .filter((point) => Number.isFinite(point))
        : [];

      if (points.length < 4) {
        return null;
      }

      return {
        id,
        type: "ink",
        rotation,
        points,
        strokeWidth: Math.max(1, normalizeFiniteNumber(candidate.strokeWidth, DEFAULT_STROKE_WIDTH)),
      };
    }
    case "rect":
    case "ellipse": {
      const x = normalizeFiniteNumber(candidate.x, 0);
      const y = normalizeFiniteNumber(candidate.y, 0);
      const width = Math.max(0, normalizeFiniteNumber(candidate.width, 0));
      const height = Math.max(0, normalizeFiniteNumber(candidate.height, 0));

      if (width === 0 || height === 0) {
        return null;
      }

      return {
        id,
        type: candidate.type,
        rotation,
        x,
        y,
        width,
        height,
      };
    }
    case "text": {
      const text = normalizeNonEmptyString(candidate.text);
      const width = Math.max(80, normalizeFiniteNumber(candidate.width, 220));
      const fontSize = Math.max(12, normalizeFiniteNumber(candidate.fontSize, DEFAULT_FONT_SIZE));

      if (!text) {
        return null;
      }

      return {
        id,
        type: "text",
        rotation,
        x: normalizeFiniteNumber(candidate.x, 0),
        y: normalizeFiniteNumber(candidate.y, 0),
        width,
        text,
        fontSize,
      };
    }
    default:
      return null;
  }
}

function normalizeImageSize(image?: Partial<ImageAnnotationImageSize> | null): ImageAnnotationImageSize {
  return {
    width: Math.max(1, Math.round(normalizeFiniteNumber(image?.width, DEFAULT_IMAGE_WIDTH))),
    height: Math.max(1, Math.round(normalizeFiniteNumber(image?.height, DEFAULT_IMAGE_HEIGHT))),
  };
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function normalizeFiniteNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildItemMarkup(item: ImageAnnotationItem) {
  switch (item.type) {
    case "ink":
      return `<polyline points="${pairsFromPoints(item.points)
        .map(([x, y]) => `${x},${y}`)
        .join(" ")}" fill="none" stroke="${PREVIEW_STROKE}" stroke-width="${item.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
    case "rect":
      return wrapTransform(
        item.rotation,
        item.x + item.width / 2,
        item.y + item.height / 2,
        `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="8" fill="${PREVIEW_FILL}" stroke="${PREVIEW_STROKE}" stroke-width="4" />`,
      );
    case "ellipse":
      return wrapTransform(
        item.rotation,
        item.x + item.width / 2,
        item.y + item.height / 2,
        `<ellipse cx="${item.x + item.width / 2}" cy="${item.y + item.height / 2}" rx="${item.width / 2}" ry="${item.height / 2}" fill="${PREVIEW_FILL}" stroke="${PREVIEW_STROKE}" stroke-width="4" />`,
      );
    case "text":
      return wrapTransform(
        item.rotation,
        item.x,
        item.y,
        buildTextMarkup(item),
      );
  }
}

function buildTextMarkup(item: ImageAnnotationTextItem) {
  const lines = wrapTextLines(item.text, item.width, item.fontSize);
  const lineHeight = item.fontSize * TEXT_LINE_HEIGHT;
  const segments = lines
    .map(
      (line, index) =>
        `<tspan x="${item.x}" dy="${index === 0 ? item.fontSize : lineHeight}">${escapeHtml(line)}</tspan>`,
    )
    .join("");

  return `<text x="${item.x}" y="${item.y}" font-size="${item.fontSize}" font-weight="600" fill="${PREVIEW_TEXT}" stroke="rgba(255,255,255,0.84)" stroke-width="1.6" paint-order="stroke">${segments}</text>`;
}

function wrapTextLines(text: string, width: number, fontSize: number) {
  const maxChars = Math.max(1, Math.floor(width / Math.max(fontSize * 0.62, 8)));
  const rawLines = text.split("\n");
  const result: string[] = [];

  for (const rawLine of rawLines) {
    const line = rawLine.trim();

    if (!line) {
      result.push("");
      continue;
    }

    let remaining = line;

    while (remaining.length > maxChars) {
      result.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }

    result.push(remaining);
  }

  return result.length > 0 ? result : [text];
}

function wrapTransform(rotation: number, x: number, y: number, markup: string) {
  if (!rotation) {
    return markup;
  }

  return `<g transform="rotate(${rotation} ${x} ${y})">${markup}</g>`;
}

function pairsFromPoints(points: number[]) {
  const pairs: Array<[number, number]> = [];

  for (let index = 0; index < points.length - 1; index += 2) {
    pairs.push([points[index], points[index + 1]]);
  }

  return pairs;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
