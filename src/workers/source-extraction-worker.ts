import { Buffer } from "node:buffer";
import { extractSourceText, SOURCE_TEXT_MAX_BYTES } from "../lib/source-text";
import { extractSourcePdf, SOURCE_PDF_MAX_BYTES } from "../lib/source-pdf";

export async function handleSourceExtractionRequest(request: unknown) {
  const id = request && typeof request === "object" && "requestId" in request && typeof request.requestId === "string" ? request.requestId : "";
  const invalid = () => ({ requestId: id, ok: false, error: { code: "INVALID_ARGUMENT", message: "Invalid source extraction request" } });
  if (!request || typeof request !== "object" || Array.isArray(request) || !id || id.length > 128) return invalid();
  if (Object.keys(request).some(key => !["requestId", "format", "base64"].includes(key))) return invalid();
  if (!("format" in request) || typeof request.format !== "string" || !["text", "markdown", "html", "pdf"].includes(String(request.format)) || !("base64" in request) || typeof request.base64 !== "string") return invalid();
  const encoded = request.base64;
  const maxBytes = request.format === "pdf" ? SOURCE_PDF_MAX_BYTES : SOURCE_TEXT_MAX_BYTES;
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4 || /[^A-Za-z0-9+/=]/u.test(encoded)) return invalid();
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (encoded.indexOf("=") !== (padding ? encoded.length - padding : -1)) return invalid();
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (bytes.byteLength > maxBytes || (encoded && Buffer.from(bytes.subarray(Math.max(0, bytes.length - (padding ? 3 - padding : 3)))).toString("base64") !== encoded.slice(-4))) return invalid();
  try {
    const data = request.format === "pdf" ? await extractSourcePdf(bytes) : extractSourceText(bytes, request.format === "markdown" ? "markdown" : request.format === "html" ? "html" : "text");
    return { requestId: id, ok: true, data };
  } catch {
    return { requestId: id, ok: false, error: { code: "EXTRACTION_FAILED", message: "Cannot extract source snapshot" } };
  }
}
