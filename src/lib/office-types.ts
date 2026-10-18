import type { DocxModel, DocxEdit } from '../../packages/office-docx/types';
import type { Model as XlsxModel, Edit as XlsxEdit } from '../../packages/office-xlsx/types';
import type { PptxModel, PptxEdit } from '../../packages/office-pptx/types';
export type OfficeModel = DocxModel | XlsxModel | PptxModel;
export type OfficeEdit = DocxEdit | XlsxEdit | PptxEdit;
export type OfficeFormat = OfficeModel['format'];
export type {DocxEdit, XlsxEdit, PptxEdit};

export type {FaceVerticalMetrics} from '../../packages/office-docx/editor-types';
