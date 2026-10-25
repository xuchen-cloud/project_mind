/** Serializable GenOffice ProseMirror JSON. Keep attrs/marks from inspect intact. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface PmMark { type: string; attrs?: Record<string, JsonValue> }
export interface PmNode {
  type: string;
  attrs?: Record<string, JsonValue>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
}
export interface PmJSON extends PmNode { type: 'doc'; content: PmNode[] }
export interface TextNode {
  /** Stable for content-only edits to the same baseline; re-inspect after save. */
  id: string;
  docxIndex: number;
  path: number[];
  type: string;
  text: string;
}
export interface DocxModel {
  format: 'docx';
  authoring?: AuthoringSummary;
  baselineHash: string;
  /** Original DOCX bytes for the complete browser renderer. */
  sourceBase64?: string;
  document: PmJSON;
  /** Original GenOffice styles.xml rendering rules; display only, scoped by editor. */
  documentCss: string;
  nodes: TextNode[];
  assets: { id: string; dataUrl: string }[];
  readOnly: boolean;
  /** First section's display geometry, in CSS pixels; saves retain all sections. */
  page: {
    width: number; height: number;
    margins: { top: number; right: number; bottom: number; left: number };
    fontFamily: string | null; eastAsianFontFamily: string | null; fontSizePt: number | null;
  };
}
export type Model = DocxModel;
export type Edit =
  | { type: 'operations'; ops: Record<string, unknown>[] }
  | { type: 'snapshot'; baselineHash: string; base64: string }
  | { type: 'document'; document: PmJSON }
  | { type: 'text'; nodeId: string; text: string; expectedText?: string };
export type DocxEdit = Edit;
/** Reserved host context; this in-memory engine does not read caller file paths. */
export interface Context { binaryPath?: string; tempRoot?: string }
export type ErrorCode = 'INVALID_UTF' | 'INVALID_JSON' | 'INVALID_EDIT' | 'UNSUPPORTED_EDIT' | 'READ_ONLY' | 'INVALID_ARGUMENT' | 'BUDGET_EXCEEDED';
export class DocxError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = 'DocxError'; }
}
export declare function inspect(bytes: Uint8Array, context?: Context): Promise<DocxModel>;
export declare function edit(bytes: Uint8Array, edits: Edit[], context?: Context): Promise<Uint8Array>;

/** Create from restricted HTML, at most 2 MiB UTF-8; unsupported markup is rejected. */
export declare function create(content: CreateContent): Promise<Uint8Array>;

export interface AuthoringSummary { blocks: Record<string, unknown>[]; styles: Record<string, unknown>[]; tableStyles: {id:string;name:string}[]; sections: Record<string,unknown>[]; headersFooters: Record<string,unknown>; notes: Record<string,unknown>[] }
export type CreateContent = string | { html?: string; ops?: Record<string, unknown>[] };
export declare function catalog(): Promise<unknown>;
