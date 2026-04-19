import type { InternalReferenceTarget } from "../../lib/internalReferences";
import type { InternalReferenceContext } from "../../lib/types";

export type RichEditorVariant = "toolbar" | "bare" | "page";

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
  insertPastedImage?: (file: File) => Promise<RichEditorAsset>;
  insertFile?: (sourcePath: string) => Promise<RichEditorAsset>;
}

export interface RichEditorInternalReferenceOptions {
  context: InternalReferenceContext;
  onOpenReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
}
