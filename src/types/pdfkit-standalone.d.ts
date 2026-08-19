/// <reference types="pdfkit" />

declare namespace PDFKit.Mixins {
  interface AnnotationOption {
    structParent?: PDFKit.PDFStructureElement;
  }
}

declare module "pdfkit/js/pdfkit.standalone.js" {
  const PDFDocument: PDFKit.PDFDocument;
  export default PDFDocument;
}
