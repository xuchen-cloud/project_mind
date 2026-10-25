import { z } from 'zod'
import { gatewayChangesSchema } from './gateway-contract'

/** The upstream gateway journal is also the authoring protocol. Native identities,
 * filesystem paths and session IDs never belong to this content document. */
export const createSchema = z.object({
  sheets: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(31).regex(/^[^\\/?*[\]:]+$/)
      .refine(name => !name.startsWith("'") && !name.endsWith("'"), 'Invalid worksheet name'),
    hidden: z.boolean().optional(),
    tabColor: z.string().regex(/^#[0-9A-F]{6}$/).optional(),
  }).strict()).min(1).max(1000),
  changes: gatewayChangesSchema.omit({ sheetOps: true, sheetOrder: true, formulaValues: true }).optional(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.sheets.map(sheet => sheet.id)).size !== input.sheets.length ||
    new Set(input.sheets.map(sheet => sheet.name.toLowerCase())).size !== input.sheets.length)
    ctx.addIssue({ code: 'custom', message: 'Worksheet IDs and names must be unique' })
  if (input.sheets.every(sheet => sheet.hidden))
    ctx.addIssue({ code: 'custom', message: 'At least one worksheet must be visible' })
})

export type CreateContent = z.infer<typeof createSchema>
export const createJsonSchema = z.toJSONSchema(createSchema)
export const gatewayChangesJsonSchema = z.toJSONSchema(gatewayChangesSchema)

export const authoringContract = {
  coordinates: 'zero based row/column; sheetId refers to sheets[].id during creation or the inspected native sheet ID during editing',
  create: 'sheets declares final worksheet order, names, visibility and tab colors; changes is the upstream gateway operation set',
  edit: 'pass one {kind:"gateway",changes:{...}} edit for the complete operation set; sheetOps/sheetOrder are supported for existing-workbook editing',
  operations: Object.keys(gatewayChangesSchema.shape),
  formulas: 'edits[].formula starts with =; writeValue:true and value:null. Real native evaluation retains numeric, text, boolean and Excel error cache types. Unsupported functions retain their formula with no cache; inspect warnings identifies uncached/error cells.',
  views: 'freezing, print settings and worksheet visibility options are in pageSetupStates; dimensions, merging, outline and hidden axes are in structuralOps',
  rules: 'cfStates/dvStates carry the full upstream Univer rule set for their sheet; unsupported rule shapes fail explicitly in the gateway',
  budget: 'at most 2 MiB UTF-8 JSON, 1000 sheets, 2000000 used cells for calculation; generated workbook must fit the engine byte budget',
} as const

export function parseCreateContent(content: unknown): CreateContent {
  let json: string | undefined
  try { json = JSON.stringify(content) } catch { throw new Error('Expected JSON workbook content') }
  if (json === undefined) throw new Error('Expected JSON workbook content')
  if (Buffer.byteLength(json, 'utf8') > 2 * 1024 * 1024) throw new Error('Workbook authoring content exceeds 2 MiB UTF-8 JSON')
  const parsed = createSchema.parse(content)
  const bounds = new Map(parsed.sheets.map(sheet => [sheet.id, { rows: 1, columns: 1 }]))
  const include = (id: string, row: number, column: number) => {
    const bound = bounds.get(id)
    if (!bound) throw new Error(`Unknown authoring sheet: ${id}`)
    bound.rows = Math.max(bound.rows, row + 1)
    bound.columns = Math.max(bound.columns, column + 1)
  }
  for (const edit of parsed.changes?.edits ?? []) include(edit.sheetId, edit.row, edit.column)
  for (const fill of parsed.changes?.bulkConstantFills ?? []) include(fill.sheetId, fill.endRow, fill.endColumn)
  for (const table of parsed.changes?.tableAdditions ?? []) include(table.sheetId, table.area.endRow, table.area.endColumn)
  for (const pivot of parsed.changes?.pivotAdditions ?? []) {
    include(pivot.sheetId, pivot.location.endRow, pivot.location.endColumn)
    include(pivot.sourceSheetId, pivot.sourceArea.endRow, pivot.sourceArea.endColumn)
  }
  for (const op of parsed.changes?.structuralOps ?? []) if ('range' in op) include(op.sheetId, op.range.endRow, op.range.endColumn)
  if ([...bounds.values()].reduce((sum, bound) => sum + bound.rows * bound.columns, 0) > 2_000_000)
    throw new Error('Workbook authoring exceeds the 2000000-cell workbook budget')
  // JSON permits lone surrogate escapes; the native XML writer does not.
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw new Error('Invalid Unicode workbook content')
    if (value && typeof value === 'object') pending.push(...Object.values(value))
  }
  return parsed
}
