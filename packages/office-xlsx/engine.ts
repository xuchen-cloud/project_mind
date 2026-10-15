import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Sidecar } from './sidecar'
import { saveWorkbookViaSidecar } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-package-io'
import type { CellEdit, SheetFormulaValues } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-gateway'
import type { Area, Context, Edit, Model, Range, Sheet, Style } from './types'

export type { Model, Edit, Context } from './types'
const LIMIT_BYTES = 64 * 1024 * 1024
const MAX_RECALC_CELLS = 20_000
export const INITIAL_ROWS = 100
export const INITIAL_COLUMNS = 26
export const MAX_RANGE_CELLS = 100_000
const row = z.number().int().min(0).max(1_048_575)
const column = z.number().int().min(0).max(16_383)
const coordinate = { sheetId: z.string().min(1), row, column }
const text = z.string().max(32_767).refine(isUnicode, 'Invalid Unicode string')
const editsSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ ...coordinate, kind: z.literal('blank') }).strict(),
  z.object({ ...coordinate, kind: z.literal('string'), value: text }).strict(),
  z.object({ ...coordinate, kind: z.literal('number'), value: z.number().finite() }).strict(),
  z.object({ ...coordinate, kind: z.literal('formula'), formula: text.refine((v) => v.startsWith('=') && v.length > 1, 'Formula must start with =') }).strict(),
])).max(10_000)
const contextSchema = z.object({ binaryPath: z.string().min(1).refine(isUnicode).optional(), tempRoot: z.string().min(1).refine(isUnicode).optional() }).strict()
const areaSchema = z.object({ startRow: row, endRow: row, startColumn: column, endColumn: column }).strict()
  .refine((r) => r.startRow <= r.endRow && r.startColumn <= r.endColumn, 'Reversed range')
  .refine((r) => areaSize(r) <= MAX_RANGE_CELLS, 'Range exceeds 100000 cells')
const nativeText = z.string().refine(isUnicode)
const scalarSchema = z.union([nativeText, z.number().finite(), z.boolean(), z.null()])
const cellSchema = z.object({ row, column, value: scalarSchema, formula: nativeText.optional(),
  styleIndex: z.number().int().nonnegative().optional(), arrayRef: nativeText.optional(), rich: z.array(z.object({
    text: nativeText, bold: z.boolean(), italic: z.boolean(),
  }).passthrough()).optional() }).passthrough()
const styleSchema = z.object({ bold: z.boolean(), italic: z.boolean(), underline: z.boolean(), strikethrough: z.boolean(), wrapText: z.boolean(),
  fontFamily: nativeText.optional(), fontSize: z.number().finite().optional(), fontColor: nativeText.optional(), fillColor: nativeText.optional(),
  numberFormat: nativeText.optional(), horizontalAlignment: nativeText.optional(), verticalAlignment: nativeText.optional(),
  ...Object.fromEntries(['borderTop', 'borderBottom', 'borderLeft', 'borderRight'].map((key) => [key,
    z.object({ style: nativeText, color: nativeText.optional() }).passthrough().optional()])) }).passthrough()
const sheetSchema = z.object({ id: nativeText.min(1), name: nativeText, hidden: z.boolean(),
  rowCount: z.number().int().min(1).max(1_048_576), columnCount: z.number().int().min(1).max(16_384), sourceXmlBytes: z.number().int().nonnegative(),
  columnWidths: z.array(z.object({ startColumn: column, endColumn: column, width: z.number().finite().optional(), hidden: z.boolean(),
    styleIndex: z.number().int().nonnegative().optional() }).passthrough()),
  defaultRowHeight: z.number().finite().nullable(), defaultColumnWidth: z.number().finite().nullable(),
  freeze: z.object({ frozenRows: z.number().int().nonnegative(), frozenColumns: z.number().int().nonnegative() }).passthrough().nullable(),
  showGridLines: z.boolean(), tabColor: nativeText.nullable() }).passthrough()
const metadataSchema = z.object({ sessionId: nativeText.min(1), name: nativeText, activeTab: z.number().int().nonnegative(),
  sheets: z.array(sheetSchema).min(1).max(32), styles: z.array(styleSchema), visuals: z.array(z.unknown()),
  definedNames: z.array(z.object({ name: nativeText, formula: nativeText, sheetIndex: z.number().int().nonnegative().optional() }).passthrough()),
  date1904: z.boolean().optional() }).passthrough()
const rangeSchema = z.object({ cells: z.array(cellSchema), rows: z.array(z.object({ row, height: z.number().finite().optional(), hidden: z.boolean(),
  styleIndex: z.number().int().nonnegative().optional() }).passthrough()),
  merges: z.array(z.object({ startRow: row, endRow: row, startColumn: column, endColumn: column }).passthrough()),
  indexingComplete: z.boolean(), conditionalRules: z.array(z.unknown()), dataValidations: z.array(z.unknown()),
  sheetProtection: z.object({ protected: z.boolean(), hasPassword: z.boolean(), allow: z.record(z.string(), z.boolean()) }).passthrough().nullable() }).passthrough()
const formulasSchema = z.object({ cells: z.array(cellSchema), sharedGroups: z.array(z.unknown()), indexingComplete: z.boolean(), truncated: z.boolean() }).strict()
const recalcSchema = z.object({ cells: z.array(z.object({ sheet: nativeText, row, column, formatted: nativeText,
  number: z.number().finite().optional(), isFormula: z.boolean(), isError: z.boolean() }).strict()), cached: z.boolean() }).strict()
function isUnicode(value: string) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}
function areaSize(area: Area) { return (area.endRow - area.startRow + 1) * (area.endColumn - area.startColumn + 1) }
type Metadata = Pick<Model, 'name' | 'styles' | 'sheets' | 'visuals' | 'definedNames'> & { sessionId: string; activeTab: number; date1904?: boolean }
async function withWorkbook<T>(bytes: Uint8Array, context: Context | undefined,
  run: (client: Sidecar, path: string, dir: string, metadata: Metadata) => Promise<T>): Promise<T> {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT_BYTES || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Expected XLSX ZIP bytes, at most 64 MiB')
  }
  const ctx = contextSchema.parse(context ?? {})
  const dir = await mkdtemp(join(ctx.tempRoot ?? tmpdir(), 'office-xlsx-'))
  const client = new Sidecar(ctx.binaryPath ?? fileURLToPath(new URL(process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar', import.meta.url)))
  try {
    const path = join(dir, 'source.xlsx')
    await writeFile(path, bytes, { flag: 'wx' })
    const metadata = metadataSchema.parse(await client.open(path)) as Metadata
    return await run(client, path, dir, metadata)
  } finally { await client.stop(); await rm(dir, { recursive: true, force: true }) }
}
async function loadedRange(client: Sidecar, metadata: Metadata, sheetId: string, area: Area): Promise<Range> {
  const sheet = metadata.sheets.find((s) => s.id === sheetId)!
  // Native reads intersect the actual used rectangle. Outside it, cells are
  // known empty; expose the requested bounded grid without widening native I/O.
  const nativeArea = { startRow: Math.min(area.startRow, sheet.rowCount - 1), endRow: Math.min(area.endRow, sheet.rowCount - 1),
    startColumn: Math.min(area.startColumn, sheet.columnCount - 1), endColumn: Math.min(area.endColumn, sheet.columnCount - 1) }
  const deadline = Date.now() + 5000
  while (true) {
    const result = rangeSchema.parse(await client.readRange({ sessionId: metadata.sessionId, sheetId, range: nativeArea }))
    if (result.indexingComplete) return { ...result, area,
      cells: result.cells.filter((c) => c.row >= area.startRow && c.row <= area.endRow && c.column >= area.startColumn && c.column <= area.endColumn),
      rows: result.rows.filter((r) => r.row >= area.startRow && r.row <= area.endRow) } as Range
    if (Date.now() >= deadline) throw new Error(`XLSX indexing incomplete: ${sheetId}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Initial A1:Z100 only. The host can explicitly load additional bounded ranges. */
export async function inspect(bytes: Uint8Array, context?: Context): Promise<Model> {
  return withWorkbook(bytes, context, async (client, _path, _dir, metadata) => {
    const ranges: Record<string, Range> = {}
    for (const sheet of metadata.sheets) ranges[sheet.id] = await loadedRange(client, metadata, sheet.id,
      { startRow: 0, endRow: INITIAL_ROWS - 1, startColumn: 0, endColumn: INITIAL_COLUMNS - 1 })
    return { format: 'xlsx', name: metadata.name, styles: metadata.styles, sheets: metadata.sheets,
      activeSheetId: metadata.sheets[metadata.activeTab]?.id ?? metadata.sheets[0].id, ranges,
      visuals: metadata.visuals, definedNames: metadata.definedNames, date1904: metadata.date1904 ?? false }
  })
}
/** Explicit range extension; no implicit full-workbook read. Same source bytes required. */
export async function loadRange(bytes: Uint8Array, sheetId: string, area: Area, context?: Context): Promise<Range> {
  const bounded = areaSchema.parse(area)
  return withWorkbook(bytes, context, async (client, _path, _dir, metadata) => {
    if (!metadata.sheets.some((sheet) => sheet.id === sheetId)) throw new Error('Unknown sheet')
    return loadedRange(client, metadata, sheetId, bounded)
  })
}
/** Typed content changes, original styles and unrelated parts retained. */
export async function edit(bytes: Uint8Array, edits: Edit[], context?: Context): Promise<Uint8Array> {
  const checked = editsSchema.parse(edits)
  if (checked.length === 0) { contextSchema.parse(context ?? {}); return withWorkbook(bytes, context, async () => new Uint8Array(bytes)) }
  return withWorkbook(bytes, context, async (client, sourcePath, dir, metadata) => {
    const seen = new Set<string>()
    const wire: CellEdit[] = []
    for (const change of checked) {
      const sheet = metadata.sheets.find((sheet) => sheet.id === change.sheetId)
      if (!sheet || sheet.hidden) throw new Error('Unknown or hidden sheet')
      const key = `${sheet.id}:${change.row}:${change.column}`
      if (seen.has(key)) throw new Error('Duplicate cell edit')
      seen.add(key)
      const original = await loadedRange(client, metadata, sheet.id, {
        startRow: Math.min(change.row, sheet.rowCount - 1), endRow: Math.min(change.row, sheet.rowCount - 1),
        startColumn: Math.min(change.column, sheet.columnCount - 1), endColumn: Math.min(change.column, sheet.columnCount - 1) })
      if (original.sheetProtection) throw new Error('Protected sheet is read-only')
      const existing = original.cells.find((cell) => cell.row === change.row && cell.column === change.column)
      if (existing?.arrayRef) throw new Error('Array formula editing is not supported')
      wire.push({ sheetName: sheet.name, row: change.row, column: change.column, writeValue: true,
        cell: change.kind === 'formula' ? { value: null, formula: change.formula } : { value: change.kind === 'blank' ? null : change.value } })
    }
    const reads = metadata.sheets.map((sheet) => ({ sheet: sheet.name, range: {
      startRow: 0, endRow: Math.max(sheet.rowCount - 1, ...checked.filter((e) => e.sheetId === sheet.id).map((e) => e.row)),
      startColumn: 0, endColumn: Math.max(sheet.columnCount - 1, ...checked.filter((e) => e.sheetId === sheet.id).map((e) => e.column)),
    } }))
    if (reads.reduce((n, read) => n + areaSize(read.range), 0) > MAX_RECALC_CELLS) {
      throw new Error('Basic formula save exceeds the 20000-cell workbook budget')
    }
    const expected = new Set<string>()
    for (const sheet of metadata.sheets) {
      // Wait for complete indexing even when this sheet has no user edit.
      await loadedRange(client, metadata, sheet.id, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
      const formulas = formulasSchema.parse(await client.request({ command: 'read_formula_cells', sessionId: metadata.sessionId, sheetId: sheet.id }))
      if (!formulas.indexingComplete || formulas.truncated || formulas.sharedGroups.length) throw new Error('Unsupported formula inventory (shared or incomplete); candidate not saved')
      for (const cell of formulas.cells) expected.add(`${sheet.name}:${cell.row}:${cell.column}`)
    }
    for (const change of checked) {
      const cellKey = `${metadata.sheets.find((s) => s.id === change.sheetId)!.name}:${change.row}:${change.column}`
      if (change.kind === 'formula') expected.add(cellKey)
      else expected.delete(cellKey)
    }
    const recalc = recalcSchema.parse(await client.recalcCells({ path: sourcePath,
      edits: checked.map((change) => ({ sheet: metadata.sheets.find((s) => s.id === change.sheetId)!.name,
        row: change.row, column: change.column, kind: change.kind,
        input: change.kind === 'blank' ? '' : change.kind === 'formula' ? change.formula : String(change.value) })), reads }))
    for (const cell of recalc.cells) if (cell.isFormula) expected.delete(`${cell.sheet}:${cell.row}:${cell.column}`)
    if (expected.size) throw new Error(`Unsupported formula not recalculated: ${[...expected][0]}; candidate not saved`)
    const formulaValues: SheetFormulaValues[] = []
    for (const sheet of metadata.sheets) {
      const cells = recalc.cells.filter((cell) => cell.sheet === sheet.name && cell.isFormula).map((cell) => {
        if (cell.isError || typeof cell.number !== 'number' || !Number.isFinite(cell.number)) {
          throw new Error(`Unsupported formula result at ${cell.sheet}:${cell.row},${cell.column}; candidate not saved`)
        }
        return { row: cell.row, column: cell.column, value: cell.number }
      })
      if (cells.length) formulaValues.push({ sheetName: sheet.name, cells })
    }
    const targetPath = join(dir, 'result.xlsx')
    await saveWorkbookViaSidecar({ client, sourcePath, targetPath, edits: wire, formulaValues, tempRoot: dir, temporaryCandidate: true })
    return new Uint8Array(await readFile(targetPath))
  })
}
