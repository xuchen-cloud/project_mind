/** Public JSON DTOs are independent of SDK code and the host's TS target. */
export interface PptxPageSize { widthPt: number; heightPt: number }
export interface PptxOutputDocument { html: string; title?: string; pageSize?: PptxPageSize }
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
export type PptxJson = null | boolean | number | string | PptxJson[] | { [key: string]: PptxJson };
/** Pinned upstream editing IPC, replayed through its original ops and patch saver. */
export interface PptxCommand { kind: 'command'; name: string; args: PptxJson[] }
/** A bounded, upstream-generated package candidate tied to the exact native source. */
export interface PptxCandidateEdit {kind:'candidate';sourceHash:string;base64:string;changedParts:string[]}
export type PptxEdit =
  | PptxCandidateEdit
  | PptxCommand
  | (PptxTarget & { kind: 'text'; paragraphIndex: number; runIndex: number; text: string })
  | (PptxTarget & { kind: 'move-image'; x: number; y: number });

export interface PptxTextElement extends PptxTarget {
  text: string;
  originalRichText: PptxTextBody;
  /** Compatibility run-patch support; the full editor uses upstream ops instead. */
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
  /** Baseline bytes for the isolated browser editing session. Host retains CAS authority. */
  sourceBase64?: string;
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
