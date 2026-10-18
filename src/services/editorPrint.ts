import { desktopApi } from "./desktopApi";

/** A complete format-generated print document, including CSS and data assets. */
export interface EditorPrintInput {
  html: string;
  title?: string;
  /** Physical paper in points (1/72 inch), independent of screen zoom. */
  pageSize?: {widthPt: number; heightPt: number};
}

/** Waits for native completion. macOS rejects on cancellation or print failure;
 * WebView2's afterprint reports dialog completion, not successful paper output. */
export function printEditorHtml(input: EditorPrintInput): Promise<void> {
  return desktopApi.printEditorHtml(input);
}

/** Native layout returns PDF bytes; choosing and writing an export is separate. */
export async function renderEditorPdf(input: EditorPrintInput): Promise<Uint8Array> {
  const encoded = await desktopApi.renderEditorPdf(input);
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}
