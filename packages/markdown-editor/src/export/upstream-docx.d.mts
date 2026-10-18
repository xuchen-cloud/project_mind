import type { JSONContent } from '@tiptap/core';
export interface ExportImage {base64:string;mime:'image/png'|'image/jpeg'|'image/gif';widthPx:number;heightPx:number;align?:string}
export declare function exportDocxBytes(doc:JSONContent,loadImage:(source:string)=>Promise<ExportImage|null>,renderDiagram?:(source:string,language:'mermaid'|'wavedrom')=>Promise<ExportImage|null>):Promise<Uint8Array>;
