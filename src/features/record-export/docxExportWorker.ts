import type { ResolvedExportImage } from "./recordExport";
import type { RecordExportDocument } from "./recordExportModel";
import { generateDocxInCurrentThread } from "./docxGenerator";

type Request = {
  document: RecordExportDocument;
  images: Array<[string, ResolvedExportImage]>;
};

globalThis.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const bytes = await generateDocxInCurrentThread(event.data.document, new Map(event.data.images));
    globalThis.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
