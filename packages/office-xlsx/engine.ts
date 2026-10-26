import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { workbookFileSchema, workbookMediaResultSchema, workbookFormulaCellsResultSchema, workbookRowOutlineResultSchema, workbookPivotDefinitionSchema,workbookRecalcRequestSchema,workbookRecalcResultSchema } from './generated/desktop-api'
import { parsePivotDefinition } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-pivot'
import { Sidecar } from './sidecar'
import { gatewayChangesSchema, saveRequest } from './gateway-contract'
import { writeWorkbookTo } from './generated/save-workbook'
import { saveWorkbookViaSidecar } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-package-io'
import type { CellEdit, SheetFormulaValues } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-gateway'
import type { Area, Context, Edit, Model, Range, Sheet, Style, RecalculateRequest, RecalculateResult, FormulaWarning } from './types'
import { blankXlsxBuffer } from './vendor/packages/xlsx-gateway/src/gateway/csv-import'
import { parseCreateContent } from './authoring'
import { parseRelationships, parseSheetElements } from './vendor/packages/xlsx-gateway/src/gateway/xlsx-sheets'
import { parseAddress } from './vendor/packages/xlsx-gateway/src/domain/cell-address'

export type { Model, Edit, Context,RecalculateRequest,RecalculateResult } from './types'
export { createSchema, createJsonSchema, gatewayChangesJsonSchema, authoringContract } from './authoring'
export { gatewayChangesSchema } from './gateway-contract'
export type { CreateContent } from './authoring'
const LIMIT_BYTES = 64 * 1024 * 1024
const MAX_RECALC_CELLS = 2_000_000
export const INITIAL_ROWS = 1000
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
  z.object({ kind: z.literal('gateway'), changes: gatewayChangesSchema, snapshot: z.record(z.string(),z.unknown()).optional() }).strict(),
])).max(1_000_000)
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
  sheets: z.array(sheetSchema).min(1).max(1000), styles: z.array(styleSchema), visuals: z.array(z.unknown()),
  definedNames: z.array(z.object({ name: nativeText, formula: nativeText, sheetIndex: z.number().int().nonnegative().optional() }).passthrough()),
  date1904: z.boolean().optional() }).passthrough()
const rangeSchema = z.object({ cells: z.array(cellSchema), rows: z.array(z.object({ row, height: z.number().finite().optional(), hidden: z.boolean(),
  styleIndex: z.number().int().nonnegative().optional() }).passthrough()),
  merges: z.array(z.object({ startRow: row, endRow: row, startColumn: column, endColumn: column }).passthrough()),
  indexingComplete: z.boolean(), conditionalRules: z.array(z.unknown()), dataValidations: z.array(z.unknown()),
  sheetProtection: z.object({ protected: z.boolean(), hasPassword: z.boolean(), allow: z.record(z.string(), z.boolean()) }).passthrough().nullable() }).passthrough()
const formulasSchema = z.object({ cells: z.array(cellSchema), sharedGroups: z.array(z.unknown()), indexingComplete: z.boolean(), truncated: z.boolean() }).strict()
const recalcSchema = z.object({ cells: z.array(z.object({ sheet: nativeText, row, column, formatted: nativeText,
  number: z.number().finite().optional(), value: scalarSchema, isFormula: z.boolean(), isError: z.boolean() }).strict()), cached: z.boolean() }).strict()
function isUnicode(value: string) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}
function areaSize(area: Area) { return (area.endRow - area.startRow + 1) * (area.endColumn - area.startColumn + 1) }
/** Content-derived UUIDv8 for the renderer's in-memory snapshot, never a native session capability. */
function snapshotIdentity(sha256: string): string {
  const uuid = Buffer.from(sha256.slice(0, 32), 'hex')
  uuid[6] = (uuid[6] & 0x0f) | 0x80
  uuid[8] = (uuid[8] & 0x3f) | 0x80
  const hex = uuid.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** New workbooks use upstream's native blank + complete gateway mutation/save
 * path, preserving formulas, formatting, drawings and workbook objects. */
export async function create(content: unknown, context?: Context): Promise<Uint8Array> {
  const input = parseCreateContent(content)
  contextSchema.parse(context ?? {})
  let bytes: Uint8Array = new Uint8Array(await blankXlsxBuffer(input.sheets[0].name))
  if (input.sheets.length > 1) {
    bytes = await edit(bytes, [{ kind: 'gateway', changes: {
      sheetOps: input.sheets.slice(1).map((sheet, index) => ({ kind: 'add-sheet', sheetId: `create-sheet-${index}`, name: sheet.name })),
      sheetOrder: ['sheet-1', ...input.sheets.slice(1).map((_sheet, index) => `create-sheet-${index}`)],
    } }], context)
  }
  // Native sheet IDs are assigned by saved tab order. Resolve once after the
  // private baseline save, before any format/data objects are written.
  const ids = await withWorkbook(bytes, context, async (_client, _path, _dir, metadata) =>
    new Map(input.sheets.map(sheet => [sheet.id, metadata.sheets.find(native => native.name === sheet.name)!.id])))
  const changes = JSON.parse(JSON.stringify(input.changes ?? {}), (key, value) => {
    if (key !== 'sheetId' && key !== 'sourceSheetId') return value
    const id = ids.get(value)
    if (!id) throw new Error(`Unknown authoring sheet: ${value}`)
    return id
  })
  changes.sheetOps = input.sheets.flatMap(sheet => [
    ...(sheet.hidden === undefined ? [] : [{ kind: 'set-sheet-hidden', sheetId: ids.get(sheet.id), hidden: sheet.hidden }]),
    ...(sheet.tabColor === undefined ? [] : [{ kind: 'set-sheet-tab-color', sheetId: ids.get(sheet.id), color: sheet.tabColor }]),
  ])
  if (changes.sheetOps.length) changes.sheetOrder = [...ids.values()]
  if (!Object.values(changes).some(value => Array.isArray(value) ? value.length > 0 : value != null)) return bytes
  const candidate = await edit(bytes, [{ kind: 'gateway', changes }], context)
  if (candidate.length > LIMIT_BYTES) throw new Error('Generated XLSX exceeds the 64 MiB engine byte budget')
  return candidate
}
type Metadata = Pick<Model, 'name' | 'styles' | 'sheets' | 'visuals' | 'definedNames'> & { dxfStyles?: Style[]; sessionId: string; activeTab: number; date1904?: boolean }
async function openWorkbook(bytes: Uint8Array, context?: Context) {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT_BYTES || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Expected XLSX ZIP bytes, at most 64 MiB')
  }
  const ctx = contextSchema.parse(context ?? {})
  const dir = await mkdtemp(join(ctx.tempRoot ?? tmpdir(), 'office-xlsx-'))
  const client = new Sidecar(ctx.binaryPath ?? fileURLToPath(new URL(process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar', import.meta.url)))
  const close = async () => { try { await client.stop() } finally { await rm(dir, { recursive: true, force: true }) } }
  try {
    const path = join(dir, 'source.xlsx')
    await writeFile(path, bytes, { flag: 'wx' })
    const metadata = metadataSchema.parse(await client.open(path)) as Metadata
    return { client, path, dir, metadata, close }
  } catch (error) { await close(); throw error }
}
async function withWorkbook<T>(bytes: Uint8Array, context: Context | undefined,
  run: (client: Sidecar, path: string, dir: string, metadata: Metadata) => Promise<T>): Promise<T> {
  const workbook = await openWorkbook(bytes, context)
  try { return await run(workbook.client, workbook.path, workbook.dir, workbook.metadata) }
  finally { await workbook.close() }
}
async function loadedRange(client: Sidecar, metadata: Metadata, sheetId: string, area: Area): Promise<Range> {
  const sheet = metadata.sheets.find((s) => s.id === sheetId)!
  // Native reads intersect the actual used rectangle. Outside it, cells are
  // known empty; expose the requested bounded grid without widening native I/O.
  const nativeArea = { startRow: Math.min(area.startRow, sheet.rowCount - 1), endRow: Math.min(area.endRow, sheet.rowCount - 1),
    startColumn: Math.min(area.startColumn, sheet.columnCount - 1), endColumn: Math.min(area.endColumn, sheet.columnCount - 1) }
  const deadline = Date.now() + 5000
  let retryDelay = 25
  while (true) {
    const result = rangeSchema.parse(await client.readRange({ sessionId: metadata.sessionId, sheetId, range: nativeArea }))
    if (result.indexingComplete) return { ...result, area,
      cells: result.cells.filter((c) => c.row >= area.startRow && c.row <= area.endRow && c.column >= area.startColumn && c.column <= area.endColumn),
      rows: result.rows.filter((r) => r.row >= area.startRow && r.row <= area.endRow) } as Range
    if (Date.now() >= deadline) throw new Error(`XLSX indexing incomplete: ${sheetId}`)
    // Each retry rereads the requested rectangle. Back off while the native
    // indexer works, preserving the deadline and immediate first read.
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelay, deadline - Date.now())))
    retryDelay = Math.min(retryDelay * 2, 250)
  }
}
/** Preload the used workbook in bounded native reads, matching upstream's
 * two-million-cell formula budget. The canvas also exposes blank working space. */
export async function inspect(bytes: Uint8Array, context?: Context): Promise<Model> {
  return withWorkbook(bytes, context, async (client, _path, _dir, metadata) => {
    const ranges: Record<string, Range> = {}
    if (metadata.sheets.reduce((n, s) => n + s.rowCount * s.columnCount, 0) > MAX_RECALC_CELLS)
      throw new Error('Workbook used area exceeds the 2000000-cell editor budget')
    for (const sheet of metadata.sheets) {
      const chunks: Range[] = []
      const rowsPerRead = Math.max(1, Math.floor(MAX_RANGE_CELLS / sheet.columnCount))
      for (let startRow = 0; startRow < sheet.rowCount; startRow += rowsPerRead) {
        chunks.push(await loadedRange(client, metadata, sheet.id, { startRow,
          endRow: Math.min(sheet.rowCount - 1, startRow + rowsPerRead - 1), startColumn: 0, endColumn: sheet.columnCount - 1 }))
      }
      const first = chunks[0]
      ranges[sheet.id] = { ...first,
        area: { startRow: 0, endRow: Math.max(INITIAL_ROWS, sheet.rowCount) - 1,
          startColumn: 0, endColumn: Math.max(INITIAL_COLUMNS, sheet.columnCount) - 1 },
        cells: chunks.flatMap(chunk => chunk.cells), rows: chunks.flatMap(chunk => chunk.rows),
        merges: [...new Map(chunks.flatMap(chunk => chunk.merges).map(range => [JSON.stringify(range),range])).values()] }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const file = workbookFileSchema.parse({ ...metadata, sessionId: snapshotIdentity(sha256), sha256, fileBytes: bytes.length, readOnly: false })
    // Data belongs to this inspected snapshot. The iframe never receives paths or a native capability.
    delete file.path
    const formulas: Record<string, unknown> = {}, outlines: Record<string, unknown> = {}, media: Record<string, unknown> = {}, pivots: Record<string, unknown> = {}
    for (const sheet of file.sheets) {
      formulas[sheet.id] = workbookFormulaCellsResultSchema.parse(await client.request({ command:'read_formula_cells',sessionId:metadata.sessionId,sheetId:sheet.id }))
      outlines[sheet.id] = workbookRowOutlineResultSchema.parse(await client.request({ command:'read_row_outline',sessionId:metadata.sessionId,sheetId:sheet.id }))
    }
    const mediaIds = new Set(file.visuals.filter(visual=>visual.mediaPath||visual.fillMediaPath).map(visual=>visual.id))
    for (const sheet of file.sheets) for (const image of sheet.cellImages) mediaIds.add(image.id)
    for (const range of Object.values(ranges)) for (const image of (range.pageSetup as {headerFooterPictures?:{id:string}[]}|undefined)?.headerFooterPictures??[]) mediaIds.add(image.id)
    for (const visualId of mediaIds) media[visualId] = workbookMediaResultSchema.parse(await client.request({ command:'read_media',sessionId:metadata.sessionId,visualId }))
    const pivotRefs = file.sheets.flatMap(sheet => sheet.pivotTables).filter(pivot => pivot.cachePath)
    if (pivotRefs.length) {
      const zip = await JSZip.loadAsync(bytes)
      for (const pivot of pivotRefs) {
        const definition = zip.file(pivot.path), cache = zip.file(pivot.cachePath!)
        if (!definition || !cache) throw new Error('Missing source pivot definition/cache')
        pivots[pivot.path] = workbookPivotDefinitionSchema.parse(parsePivotDefinition(await definition.async('string'), await cache.async('string')))
      }
    }
    const warnings = await formulaWarnings(bytes, metadata, ranges)
    return { format: 'xlsx', name: metadata.name, rendererData: {file, formulas, outlines, media, pivots}, styles: metadata.styles, dxfStyles: metadata.dxfStyles??[], sheets: metadata.sheets, warnings,
      activeSheetId: metadata.sheets[metadata.activeTab]?.id ?? metadata.sheets[0].id, ranges,
      visuals: metadata.visuals, definedNames: metadata.definedNames, date1904: metadata.date1904 ?? false }
  })
}
async function formulaWarnings(bytes: Uint8Array, metadata: Metadata, ranges: Record<string, Range>): Promise<FormulaWarning[]> {
  const warnings: FormulaWarning[] = []
  const candidates = metadata.sheets.filter(sheet => ranges[sheet.id].cells.some(cell => cell.formula))
  if (!candidates.length) return warnings
  const zip = await JSZip.loadAsync(bytes)
  const workbook = await zip.file('xl/workbook.xml')!.async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
  const paths = new Map(parseRelationships(rels).filter(rel => rel.id && !rel.external).map(rel =>
    [rel.id!, rel.target.startsWith('/') ? rel.target.slice(1) : posix.normalize(`xl/${rel.target}`)]))
  const sheets = new Map(parseSheetElements(workbook).map(sheet => [sheet.name, paths.get(sheet.relationshipId ?? '')]))
  for (const sheet of candidates) {
    const path = sheets.get(sheet.name)
    if (!path) throw new Error('Missing worksheet relationship for formula validation')
    const xml = await zip.file(path)!.async('string')
    for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = match[2] ?? ''
      if (!/<f\b/.test(body)) continue
      const address = /\br="([A-Z]+[1-9][0-9]*)"/.exec(match[1])?.[1]
      if (!address) continue
      const coordinate = parseAddress(address)
      const cache = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)
      const text = /\bt="str"/.test(match[1])
      if (!cache || (!cache[1] && !text))
        warnings.push({ code: 'FORMULA_UNCACHED', message: 'Formula has no cached result; recalculate in Excel. The local engine may not support this function or reference.', sheetId: sheet.id, ...coordinate })
      else if (/\bt="e"/.test(match[1]))
        warnings.push({ code: 'FORMULA_ERROR', message: `Formula evaluates to ${cache[1]}`, sheetId: sheet.id, ...coordinate })
      // Calamine reports an empty text cache as null. OOXML distinguishes
      // this valid evaluated empty string from an absent formula result.
      if (text && cache && cache[1] === '') {
        const cell = ranges[sheet.id].cells.find(cell => cell.row === coordinate.row && cell.column === coordinate.column)
        if (cell) cell.value = ''
      }
    }
  }
  return warnings
}
/** Explicit range extension; no implicit full-workbook read. Same source bytes required. */
export async function loadRange(bytes: Uint8Array, sheetId: string, area: Area, context?: Context): Promise<Range> {
  const bounded = areaSchema.parse(area)
  return withWorkbook(bytes, context, async (client, _path, _dir, metadata) => {
    if (!metadata.sheets.some((sheet) => sheet.id === sheetId)) throw new Error('Unknown sheet')
    return loadedRange(client, metadata, sheetId, bounded)
  })
}
/** Keep the upstream native per-request 20k read budget while honoring the public whole-workbook budget. */
async function nativeRecalculate(client:Sidecar,request:{path:string;edits:unknown[];reads:{sheet:string;range:Area}[]}, preparedPath?: string):Promise<z.infer<typeof recalcSchema>>{
 const path=preparedPath ?? await calculationSource(client,request.path)
 const cells:z.infer<typeof recalcSchema>['cells']=[]
 let pending:{sheet:string;range:Area}[]=[],size=0,cached=false
 const flush=async()=>{if(!pending.length)return;const result=recalcSchema.parse(await client.recalcCells({...request,path,reads:pending}));cells.push(...result.cells);cached=result.cached;pending=[];size=0}
 for(const read of request.reads){const width=read.range.endColumn-read.range.startColumn+1,rows=Math.max(1,Math.floor(20000/width));for(let row=read.range.startRow;row<=read.range.endRow;row+=rows){const range={...read.range,startRow:row,endRow:Math.min(read.range.endRow,row+rows-1)},count=areaSize(range);if(size+count>20000)await flush();pending.push({sheet:read.sheet,range});size+=count}}
 await flush();return{cells,cached}
}
/** IronCalc logs an invalid type to stdout for a legal formula lacking <v>,
 * corrupting JSONL. Give it a private copy with temporary numeric caches;
 * evaluation still determines every returned result. Source bytes stay fixed. */
async function calculationSource(client: Sidecar, sourcePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(sourcePath))
  const workbook = await zip.file('xl/workbook.xml')!.async('string')
  const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
  const paths = new Map(parseRelationships(rels).filter(rel => rel.id && !rel.external).map(rel =>
    [rel.id!, rel.target.startsWith('/') ? rel.target.slice(1) : posix.normalize(`xl/${rel.target}`)]))
  const seeds: SheetFormulaValues[] = []
  for (const sheet of parseSheetElements(workbook)) {
    const path = paths.get(sheet.relationshipId ?? '')
    if (!path) throw new Error('Missing worksheet relationship for formula calculation')
    const xml = await zip.file(path)!.async('string')
    const cells: { row: number; column: number; value: number }[] = []
    for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = match[2] ?? ''
      if (!/<f\b/.test(body) || /<v\b/.test(body)) continue
      const address = /\br="([A-Z]+[1-9][0-9]*)"/.exec(match[1])?.[1]
      if (address) cells.push({ ...parseAddress(address), value: 0 })
    }
    if (cells.length) seeds.push({ sheetName: sheet.name, cells })
  }
  if (!seeds.length) return sourcePath
  const targetPath = join(dirname(sourcePath), 'formula-import.xlsx')
  await saveWorkbookViaSidecar({ client, sourcePath, targetPath, edits: [], formulaValues: seeds, tempRoot: dirname(sourcePath), temporaryCandidate: true })
  return targetPath
}
function recalculationInput(input: RecalculateRequest) {
  const schema = z.object({ edits: workbookRecalcRequestSchema.shape.edits, reads: workbookRecalcRequestSchema.shape.reads }).strict()
  const request = schema.parse(input)
  if (request.reads.reduce((total, read) => total + areaSize(read.range), 0) > MAX_RANGE_CELLS) throw Error('Recalc read exceeds 100000 cells')
  for (const { range } of request.reads) if (range.startRow > range.endRow || range.startColumn > range.endColumn) throw Error('Range boundaries are reversed')
  for (const change of request.edits) if (!isUnicode(change.input)) throw Error('Invalid Unicode input')
  return request
}
async function calculateWorkbook(client: Sidecar, path: string, metadata: Metadata, request: ReturnType<typeof recalculationInput>, preparedPath?: string): Promise<RecalculateResult> {
  const names = new Map(metadata.sheets.map(sheet => [sheet.id, sheet.name])), ids = new Map(metadata.sheets.map(sheet => [sheet.name, sheet.id]))
  const sheetName = (id: string) => { const name = names.get(id); if (name === undefined) throw Error('Unknown sheet'); return name }
  // Every call sends its complete overlay against the same immutable source.
  // The native model resets removed edits by rebuilding from that source.
  const result = await nativeRecalculate(client, { path, edits: request.edits.map(({ sheetId, ...edit }) => ({ ...edit, sheet: sheetName(sheetId) })), reads: request.reads.map(({ sheetId, range }) => ({ sheet: sheetName(sheetId), range })) }, preparedPath)
  return workbookRecalcResultSchema.parse({ cells: result.cells.map(({ sheet, value: _value, ...cell }) => { const sheetId = ids.get(sheet); if (!sheetId) throw Error('Unknown result sheet'); return { sheetId, ...cell } }) })
}
/** Native-only owner: one immutable source and sidecar, disposed with its lease. */
export async function createRecalculationSession(bytes: Uint8Array, context?: Context) {
  const workbook = await openWorkbook(bytes, context)
  let preparedPath: string
  try { preparedPath = await calculationSource(workbook.client, workbook.path) }
  catch (error) { await workbook.close(); throw error }
  let closed = false
  return {
    async recalculate(input: RecalculateRequest): Promise<RecalculateResult> {
      if (closed) throw Error('Recalculation baseline is closed')
      return calculateWorkbook(workbook.client, workbook.path, workbook.metadata, recalculationInput(input), preparedPath)
    },
    async close() { if (!closed) { closed = true; await workbook.close() } },
  }
}
/** Read-only native computation against host-owned bytes. Inputs never contain paths or session capabilities. */
export async function recalculate(bytes: Uint8Array, input: RecalculateRequest, context?: Context): Promise<RecalculateResult> {
  const request = recalculationInput(input)
  return withWorkbook(bytes, context, (client, path, _dir, metadata) => calculateWorkbook(client, path, metadata, request))
}
/** Typed content changes, original styles and unrelated parts retained. */
export async function edit(bytes: Uint8Array, edits: Edit[], context?: Context): Promise<Uint8Array> {
  const all = editsSchema.parse(edits)
  const gateway = all.filter((e) => e.kind === 'gateway')
  if (gateway.length) {
    if (gateway.length !== 1 || all.length !== 1) throw new Error('Gateway journal must be one complete operation set')
    const request = saveRequest(gateway[0].changes)
    // Upstream's two-phase format save, entirely inside the candidate. Native File CAS sees one final byte set.
    const hasShifts = request.structuralOps.length > 0 || request.sheetOps.some(op => op.kind !== 'set-sheet-tab-color')
    const heldPivots = hasShifts ? request.pivotAdditions : []
    const heldTables = request.structuralOps.length ? request.tableAdditions : []
    const heldTableEdits = request.structuralOps.length ? (request.tableEdits??[]).filter(edit => edit.area !== undefined) : []
    const heldNames = hasShifts ? request.definedNamesState : null
    if (heldPivots.length || heldTables.length || heldTableEdits.length || heldNames !== null) {
      // Native IDs are assigned from the saved tab order. Resolve by final names
      // across this private byte boundary, including newly added/renamed sheets.
      const names = await withWorkbook(bytes,context,async(_client,_path,_dir,metadata)=>new Map(metadata.sheets.map(sheet=>[sheet.id,sheet.name])))
      for(const op of request.sheetOps){
        if(op.kind==='add-sheet'||op.kind==='duplicate-sheet')names.set(op.sheetId,op.name)
        else if(op.kind==='rename-sheet')names.set(op.sheetId,op.newName)
        else if(op.kind==='remove-sheet')names.delete(op.sheetId)
      }
      const first = await edit(bytes,[{kind:'gateway',changes:{...gateway[0].changes,
        tableAdditions:heldTables.length?[]:request.tableAdditions,tableEdits:(request.tableEdits??[]).filter(edit=>!heldTableEdits.includes(edit)),
        pivotAdditions:heldPivots.length?[]:request.pivotAdditions,definedNamesState:null}}],context)
      const ids = await withWorkbook(first,context,async(_client,_path,_dir,metadata)=>new Map(metadata.sheets.map(sheet=>[sheet.name,sheet.id])))
      const remap=(id:string)=>{const name=names.get(id),savedId=name===undefined?undefined:ids.get(name);if(!savedId)throw Error('Unknown staged worksheet');return savedId}
      return edit(first,[{kind:'gateway',changes:{
        tableAdditions:heldTables.map(table=>({...table,sheetId:remap(table.sheetId)})),
        tableEdits:heldTableEdits.map(edit=>({...edit,sheetId:remap(edit.sheetId)})),
        pivotAdditions:heldPivots.map(pivot=>({...pivot,sheetId:remap(pivot.sheetId),sourceSheetId:remap(pivot.sourceSheetId)})),
        definedNamesState:heldNames,
      }}],context)
    }
    return withWorkbook(bytes, context, async (client, sourcePath, dir, metadata) => {
      const additions = new Set(request.sheetOps.filter(op => op.kind === 'add-sheet' || op.kind === 'duplicate-sheet').map(op => op.sheetId))
      const changed = new Set([...request.edits.map(e => e.sheetId), ...request.structuralOps.map(e => e.sheetId)])
      for (const id of changed) {
        if (additions.has(id)) continue
        if (!metadata.sheets.some(sheet => sheet.id === id)) throw new Error('Unknown sheet')
        // The complete renderer's protection guard journals verified protection intent,
        // allowed unlocked-cell edits and allowed structural operations together.
      }
      const targetPath = join(dir, 'result.xlsx')
      await writeWorkbookTo(client, {snapshotPath:sourcePath, sheetNames:new Map(metadata.sheets.map(s=>[s.id,s.name]))}, request, targetPath)
      const candidate = new Uint8Array(await readFile(targetPath))
      if (!request.formulaValues.length && (request.edits.some(e=>e.writeValue) || request.structuralOps.some(op=>/insert|remove|move/.test(op.kind)) || request.sheetOps.length)) {
        return recalculateCandidate(candidate, context)
      }
      return candidate
    })
  }
  const checked = all.filter((e) => e.kind !== 'gateway')
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
      throw new Error('Formula save exceeds the 2000000-cell workbook budget')
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
    const recalc = await nativeRecalculate(client,{ path: sourcePath,
      edits: checked.map((change) => ({ sheet: metadata.sheets.find((s) => s.id === change.sheetId)!.name,
        row: change.row, column: change.column, kind: change.kind,
        input: change.kind === 'blank' ? '' : change.kind === 'formula' ? change.formula : String(change.value) })), reads })
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

/** Compute against the already transformed candidate, never pre-shift coordinates. */
async function recalculateCandidate(bytes: Uint8Array, context?: Context): Promise<Uint8Array> {
  return withWorkbook(bytes, context, async (client, sourcePath, dir, metadata) => {
    const reads=metadata.sheets.map(sheet=>({sheet:sheet.name,range:{startRow:0,endRow:sheet.rowCount-1,startColumn:0,endColumn:sheet.columnCount-1}}))
    if(reads.reduce((n,r)=>n+areaSize(r.range),0)>MAX_RECALC_CELLS)throw new Error('Formula save exceeds the 2000000-cell workbook budget')
    const expected=new Set<string>()
    const inventories = new Map<string, z.infer<typeof formulasSchema>['cells']>()
    for(const sheet of metadata.sheets){
      await loadedRange(client,metadata,sheet.id,{startRow:0,endRow:0,startColumn:0,endColumn:0})
      const inventory=formulasSchema.parse(await client.request({command:'read_formula_cells',sessionId:metadata.sessionId,sheetId:sheet.id}))
      if(!inventory.indexingComplete||inventory.truncated)throw new Error('Incomplete formula inventory; candidate not saved')
      inventories.set(sheet.name, inventory.cells)
      for(const cell of inventory.cells)expected.add(`${sheet.name}:${cell.row}:${cell.column}`)
    }
    if(!expected.size)return bytes
    const result=await nativeRecalculate(client,{path:sourcePath,edits:[],reads})
    const formulaValues: SheetFormulaValues[]=[]
    for(const sheet of metadata.sheets){
      const cells=result.cells.filter(c=>c.sheet===sheet.name&&c.isFormula).map(c=>{
        expected.delete(`${c.sheet}:${c.row}:${c.column}`)
        const value = c.isError ? (c.formatted === '#NAME?' || c.formatted === '#ERROR!' ? null : { error: c.formatted }) : c.value
        return {row:c.row,column:c.column,value}
      })
      for (const cell of inventories.get(sheet.name) ?? []) if (expected.has(`${sheet.name}:${cell.row}:${cell.column}`))
        cells.push({ row: cell.row, column: cell.column, value: null })
      if(cells.length)formulaValues.push({sheetName:sheet.name,cells})
    }
    const targetPath=join(dir,'calculated.xlsx')
    await saveWorkbookViaSidecar({client,sourcePath,targetPath,edits:[],formulaValues,tempRoot:dir,temporaryCandidate:true})
    return new Uint8Array(await readFile(targetPath))
  })
}
