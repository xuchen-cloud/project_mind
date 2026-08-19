import type { ResolvedExportImage } from "./recordExport";
import type { RecordExportDocument } from "./recordExportModel";
import { generatePdfInCurrentThread } from "./pdfGenerator";

type Request = {
  document: RecordExportDocument;
  images: Array<[string, ResolvedExportImage]>;
  fontBytes: { sans: Uint8Array; mono: Uint8Array };
};

globalThis.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const bytes = await generatePdfInCurrentThread(
      event.data.document,
      new Map(event.data.images),
      event.data.fontBytes,
    );
    globalThis.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
