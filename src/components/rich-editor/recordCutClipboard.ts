export const RECORD_CUT_CLIPBOARD_TYPE = "application/x-project-mind-record-cut";
export interface RecordCutDescriptor { version: 1; recordKey: string; token: string }
const marker = /<!--project-mind-record-cut:([^>]{1,2048})-->/;

export function recordCutClipboardHtml(html: string, descriptor: RecordCutDescriptor) {
  // Standard HTML survives native clipboard transfers which may discard custom
  // MIME types. Percent-encoding also keeps the comment terminator out of IDs.
  return `<!--project-mind-record-cut:${encodeURIComponent(JSON.stringify(descriptor)).replaceAll("-", "%2D")}-->${html}`;
}

export function readRecordCutClipboard(raw: string, html: string): RecordCutDescriptor | null {
  try {
    if (!raw) {
      const encoded = html.match(marker)?.[1];
      if (!encoded) return null;
      raw = decodeURIComponent(encoded);
    }
    if (raw.length > 512) return null;
    const value = JSON.parse(raw);
    return value?.version === 1 && typeof value.recordKey === "string" && value.recordKey.length <= 256
      && typeof value.token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.token)
      ? value : null;
  } catch { return null; }
}

export function recordCutPasteEvent(html: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], items: [], getData: (type: string) => type === "text/html" ? html : "" } });
  return event as ClipboardEvent;
}
