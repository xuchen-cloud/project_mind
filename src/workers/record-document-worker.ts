import type { JSONContent } from "@tiptap/core";
import type { AttributeSpec } from "@tiptap/pm/model";
import { recordDocumentSchema } from "../components/rich-editor/extensions";
import { parseRecordHtml } from "../lib/record-document-html";
import { serializeRecordDocument } from "../lib/record-document-format";
import { canonicalDocumentJson, RECORD_DOCUMENT_SCHEMA_VERSION, RecordDocumentError, validateRecordDocument } from "../lib/record-document";
import { applyRecordPatch, type RecordPatchOperation, type RecordPatchPreview } from "../lib/record-patch";
import { compareRecordDocuments } from "../lib/record-version-compare";

interface DocumentWorkerRequest {
  requestId: string;
  method: "record.initialize" | "record.validate" | "record.patch" | "record.compare" | "record.schema";
  data?: { html?: string; assetBasePath?: string | null; document?: JSONContent; otherDocument?: JSONContent; codeLanguage?: string | null; operations?: RecordPatchOperation[] };
}

export async function handleRecordDocumentRequest(request: DocumentWorkerRequest) {
  try {
    if (typeof request?.requestId !== "string" || !request.requestId || request.requestId.length > 128) throw new RecordDocumentError("Invalid request ID");
    if (request.method === "record.schema") {
      const types = (source: typeof recordDocumentSchema.nodes | typeof recordDocumentSchema.marks) => Object.entries(source).map(([name, type]) => {
        const attrs: Record<string, AttributeSpec> = type.spec.attrs ?? {};
        return { name, attrs: Object.fromEntries(Object.entries(attrs).map(([key, attr]) => [key, attr.default ?? null])),
          ...("content" in type.spec ? { content: type.spec.content ?? null } : {}),
          ...("group" in type.spec ? { group: type.spec.group ?? null } : {}) };
      });
      return { requestId: request.requestId, ok: true, data: { schemaVersion: RECORD_DOCUMENT_SCHEMA_VERSION,
        nodes: types(recordDocumentSchema.nodes), marks: types(recordDocumentSchema.marks) } };
    }
    const data = request.data;
    if (!data || (data.codeLanguage !== undefined && data.codeLanguage !== null && typeof data.codeLanguage !== "string")) throw new RecordDocumentError("Invalid document payload");
    if (request.method === "record.compare" && data.document && data.otherDocument) {
      const before = validateRecordDocument(data.document, recordDocumentSchema);
      const after = validateRecordDocument(data.otherDocument, recordDocumentSchema);
      return { requestId: request.requestId, ok: true, data: compareRecordDocuments(before, after) };
    }
    let document: JSONContent;
    let patch: Omit<RecordPatchPreview, "document"> | undefined;
    if (request.method === "record.initialize" && typeof data.html === "string") document = parseRecordHtml(data.html, recordDocumentSchema, { assetBasePath: data.assetBasePath });
    else if (request.method === "record.validate" && data.document) document = data.document;
    else if (request.method === "record.patch" && data.document && data.operations) {
      const preview = await applyRecordPatch(data.document, data.operations, recordDocumentSchema);
      document = preview.document;
      const { document: _document, ...metadata } = preview;
      patch = metadata;
    }
    else throw new RecordDocumentError("Invalid document operation");
    const projection = serializeRecordDocument(document, recordDocumentSchema);
    const codeLanguage = data.codeLanguage?.trim().toLowerCase() || null;
    if (codeLanguage && codeLanguage.length > 64) throw new RecordDocumentError("Invalid code language length");
    const canonical = JSON.parse(canonicalDocumentJson(projection.document));
    const body = JSON.stringify({ codeLanguage, document: canonical });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const bodyHash = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return { requestId: request.requestId, ok: true,
      data: { ...projection, document: canonical, codeLanguage, schemaVersion: RECORD_DOCUMENT_SCHEMA_VERSION, bodyHash,
        ...(patch ? { patch } : {}) } };
  } catch (error) {
    return { requestId: typeof request?.requestId === "string" ? request.requestId : "", ok: false,
      error: { code: "INVALID_PATCH", message: error instanceof RecordDocumentError ? error.message : "Cannot convert Record document" } };
  }
}
