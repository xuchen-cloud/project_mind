/** Public JSON DTOs are independent of SDK code and the host's TS target. */
export interface PptxTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  fontSize?: number;
  field?: string;
  rawXml?: string;
}
export interface PptxTextBody { paragraphs: { runs: PptxTextRun[] }[] }
export interface PptxTransform {
  offset: { x: number; y: number; cx: number; cy: number };
  rot: number;
  flipH: boolean;
  flipV: boolean;
}
export interface PptxSlideModel {
  path: string;
  /** Complete serializable SDK shape payload, consumed only by package renderer. */
  elements: unknown[];
}
export interface PptxRenderSlide {
  widthPx: number;
  heightPx: number;
  scale: number;
  /** Opaque rendering payload: the browser bundle owns its interpretation. */
  background: unknown;
  nodes: unknown[];
}

/** Indexes are zero based; cNvPrId is the original OOXML shape ID. */
export interface PptxTarget { slideIndex: number; cNvPrId: string }
export type PptxEdit =
  | (PptxTarget & { kind: 'text'; paragraphIndex: number; runIndex: number; text: string })
  | (PptxTarget & { kind: 'move-image'; x: number; y: number });

export interface PptxTextElement extends PptxTarget {
  text: string;
  originalRichText: PptxTextBody;
  /** Structural edits, fields, math and grouped objects are explicitly read only. */
  editable: boolean;
  unsupportedReason?: string;
}
export interface PptxPictureElement extends PptxTarget {
  transform: PptxTransform;
  editable: boolean;
  unsupportedReason?: string;
}
export interface PptxModel {
  format: 'pptx';
  originalHash: string;
  size: { cx: number; cy: number };
  /** IDs in the exported deck and render tree are stable, never parse-time IDs. */
  slides: PptxSlideModel[];
  renderSlides: PptxRenderSlide[];
  media: Record<string, string>;
  textElements: PptxTextElement[];
  pictureElements: PptxPictureElement[];
  limitations: string[];
}
export type Model = PptxModel;
export type Edit = PptxEdit;
