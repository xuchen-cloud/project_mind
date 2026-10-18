import type { DocxModel, Edit } from './types';
/** Fixed upstream @genoffice/font-metrics FaceVerticalMetrics contract. */
export interface FaceVerticalMetrics {
  unitsPerEm:number;hheaAscender:number;hheaDescender:number;hheaLineGap:number;
  typoAscender:number|null;typoDescender:number|null;typoLineGap:number|null;
  winAscent:number|null;winDescent:number|null;useTypoMetrics:boolean;
}
export interface EditorRemoteImage {mime:'image/png'|'image/jpeg'|'image/gif';base64:string;}
export interface EditorOptions {
  model: DocxModel;
  edits: Edit[];
  onChange(edits: Edit[]): void;
  readOnly?: boolean;
  onError?(message: string): void;
  onPendingChange?(pending: boolean): void;
  onSaveRequest?(): void | Promise<void>;
  onExport?(file:{name:string;mime:string;bytes:Uint8Array}):Promise<boolean>;
  onPrint?(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}):Promise<void>;
  onRenderPdf?(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}}):Promise<Uint8Array>;
  onConvertAltChunkHtml?(html:string):Promise<Uint8Array|null>;
  onGetSystemFonts?():Promise<string[]>;
  onFontMetrics?(family:string):Promise<FaceVerticalMetrics|null>;
  onFetchImage?(url:string):Promise<EditorRemoteImage>;
}
export interface EditorController {
  update(options: EditorOptions): void;
  destroy(): void;
  undo(): void;
  redo(): void;
  beforeSave?(): Promise<void>;
}
export declare function mountEditor(element: HTMLElement, options: EditorOptions): EditorController;

export declare function mountFullEditor(element: HTMLElement, options: EditorOptions): EditorController;
