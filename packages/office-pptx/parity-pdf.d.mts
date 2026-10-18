/** Structural declarations for the extracted pure helper, independent of Electron IPC types. */
type ExportPdfPage={svg:string}|{png:string};
type ExportPdfLink={x:number;y:number;w:number;h:number;href:string};
export function buildPdfExportHtml(pages:ExportPdfPage[],widthIn:number,heightIn:number,links?:ExportPdfLink[][],fontCss?:string):string;
export function exportPageWidthIn(widthPx:number,heightPx:number):number;
