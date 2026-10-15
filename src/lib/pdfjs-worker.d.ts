// PDF.js 6 exposes its parser handler in this distribution entry without a
// declaration file. We pass the module through to PDF.js, never call it here.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
