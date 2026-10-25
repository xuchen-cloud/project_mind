import type { GatewayChanges } from './gateway-contract'
import type { ScreenSourcesResult, ScreenCaptureRequest, ScreenCaptureResult } from './generated/desktop-api'
export type { GatewayChanges } from './gateway-contract'
export type { CreateContent } from './authoring'
export type { ScreenSourcesResult, ScreenCaptureRequest, ScreenCaptureResult } from './generated/desktop-api'
/** Public JSON contract. Coordinates are zero based. */
export type ContentEdit = { sheetId: string; row: number; column: number } & (
  | { kind: 'blank' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'formula'; formula: string }
)
export type Edit = ContentEdit | { kind: 'gateway'; changes: GatewayChanges; snapshot?: Record<string, unknown> }
export interface Context { binaryPath?: string; tempRoot?: string }
export type Scalar = string | number | boolean | null
export interface Area { startRow: number; endRow: number; startColumn: number; endColumn: number }
export interface Border { style: string; color?: string }
export interface Style {
  fontFamily?: string; fontSize?: number; fontColor?: string; fillColor?: string
  bold: boolean; italic: boolean; underline: boolean; strikethrough: boolean; wrapText: boolean
  numberFormat?: string; horizontalAlignment?: string; verticalAlignment?: string
  borderTop?: Border; borderBottom?: Border; borderLeft?: Border; borderRight?: Border
  locked?: boolean; hidden?: boolean
  [property: string]: unknown
}
export interface Cell {
  row: number; column: number; value: Scalar; formula?: string; styleIndex?: number
  arrayRef?: string; rich?: readonly { text: string; bold: boolean; italic: boolean; [property: string]: unknown }[]
}
export interface Row { row: number; height?: number; hidden: boolean; styleIndex?: number; [property: string]: unknown }
export interface Sheet {
  id: string; name: string; hidden: boolean; veryHidden?: boolean
  rowCount: number; columnCount: number; sourceXmlBytes: number
  columnWidths: { startColumn: number; endColumn: number; width?: number; hidden: boolean; styleIndex?: number }[]
  defaultRowHeight: number | null; defaultColumnWidth: number | null
  freeze: { frozenColumns: number; frozenRows: number } | null
  showGridLines: boolean; tabColor: string | null
  [property: string]: unknown
}
export interface Range {
  /** Bounds actually loaded. Absence beyond these bounds never means blank. */
  area: Area; cells: Cell[]; rows: Row[]; merges: Area[]
  indexingComplete: boolean; conditionalRules: unknown[]; dataValidations: unknown[]
  sheetProtection: { protected: boolean; hasPassword: boolean; allow: Record<string, boolean>; [property: string]: unknown } | null
  [property: string]: unknown
}
export interface Model {
  format: 'xlsx'; name: string; activeSheetId: string
  styles: Style[]; dxfStyles?: Style[]; sheets: Sheet[]; ranges: Record<string, Range>
  visuals: unknown[]; definedNames: { name: string; formula: string; sheetIndex?: number }[]
  date1904: boolean
  /** Formula data retained in the workbook but requiring user attention. */
  warnings?: FormulaWarning[]
  /** Validated source data for the complete upstream renderer; contains no file capabilities. */
  rendererData?: { file: Record<string, unknown>; formulas: Record<string, unknown>; outlines: Record<string, unknown>; media: Record<string, unknown>; pivots: Record<string, unknown> }
}
export interface FormulaWarning {
  code: 'FORMULA_UNCACHED' | 'FORMULA_ERROR'
  message: string
  sheetId?: string
  row?: number
  column?: number
}
export interface RecalculateRequest {
  edits: {sheetId: string; row: number; column: number; input: string}[]
  reads: {sheetId: string; range: Area}[]
}
export interface RecalculateResult {
  cells: {sheetId: string; row: number; column: number; formatted: string; number?: number; isError?: boolean; isFormula: boolean}[]
}
export interface ExportFile { name: string; mime: string; bytes: Uint8Array }
export interface PrintDocument { html: string; title?: string; pageSize?: { widthPt: number; heightPt: number } }
export interface EditorProps {
  /** Exact native save receipt; unrelated model replacements must omit this. */
  savedModelUpdate?: {previous: Model; current: Model}

  /** The same renderer and view state; preview locks editing and hides editing controls. */
  presentationMode?: 'preview' | 'edit'
  model: Model; edits: Edit[]; onChange: (edits: Edit[]) => void; readOnly: boolean
  onPendingChange?: (pending: boolean) => void
  onSaveRequest?: () => void | Promise<void>
  onExport?: (file: ExportFile) => Promise<boolean>
  onPrint?: (document: PrintDocument) => Promise<void>
  onRenderPdf?: (document: PrintDocument) => Promise<Uint8Array>
  onRecalculate?: (request: RecalculateRequest) => Promise<RecalculateResult>
  /** Inspect only user-selected XLSX bytes; never creates or writes a File. */
  onInspectImportedWorkbook?: (bytes: Uint8Array) => Promise<Model>
  onCaptureScreenSources?: () => Promise<ScreenSourcesResult>
  onCaptureScreenSource?: (request: ScreenCaptureRequest) => Promise<ScreenCaptureResult | null>
}
export type OutputCommand = 'pdf' | 'csv' | 'print'
export interface SelectionController {
  captureSelection: () => Promise<{selectionId: string; text: string}>
  applySelection: (input: {selectionId: string; change: unknown}) => Promise<{text: string}>
}
export interface MountedEditor extends SelectionController {
  readonly ready: Promise<void>
  commitEditing: () => Promise<void>
  /** PDF/CSV await the output callback; print opens the original print settings dialog. */
  output: (command: OutputCommand) => Promise<void>
  update: (props: EditorProps) => void
  dispose: () => void
}
