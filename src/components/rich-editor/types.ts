export type RichEditorVariant = "toolbar" | "bare";

export type RichEditorPersistState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface RichEditorValue {
  html: string;
  text: string;
  markdown: string;
}

export interface RichEditorAsset {
  kind: "image" | "file";
  title: string;
  path?: string;
  href?: string;
  src?: string;
  mimeType?: string;
  documentId?: number;
  meta?: string;
}

export interface RichEditorAssetHandlers {
  insertImage?: (sourcePath: string) => Promise<RichEditorAsset>;
  insertFile?: (sourcePath: string) => Promise<RichEditorAsset>;
}
