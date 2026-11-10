import {z} from 'zod'
import {
  workbookRangeResultSchema, workbookFormulaCellsResultSchema,
  workbookRowOutlineResultSchema, workbookMediaResultSchema, workbookPivotDefinitionSchema,
} from './generated/desktop-api'
import type {OfficeViewRead} from './types'
const rangeResult = workbookRangeResultSchema.extend({
  area: z.object({startRow:z.number().int().nonnegative(),endRow:z.number().int().nonnegative(),startColumn:z.number().int().nonnegative(),endColumn:z.number().int().nonnegative()}).strict(),
  rangeReady: z.boolean(),
  metadataReady: z.boolean(),
})
/** Validate the native reply before any upstream grid/metadata mutation. */
export function parseViewResult(request: OfficeViewRead, value: unknown): unknown {
  switch(request.kind) {
    case 'range': return rangeResult.parse(value)
    case 'formulas': return workbookFormulaCellsResultSchema.parse(value)
    case 'outline': return workbookRowOutlineResultSchema.parse(value)
    case 'media': return workbookMediaResultSchema.parse(value)
    case 'pivot': return workbookPivotDefinitionSchema.parse(value)
  }
}
