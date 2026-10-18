import { z } from 'zod'
import { workbookSaveRequestSchema } from './generated/desktop-api'
/** Format operations only. File paths, identity, CAS, versions remain host-owned. */
export const gatewayChangesSchema = z.object(workbookSaveRequestSchema.shape).strict().pick({
  edits: true, bulkConstantFills: true, structuralOps: true, chartEdits: true,
  visualEdits: true, visualAdditions: true, tableAdditions: true, tableEdits: true,
  pivotAdditions: true, sheetOps: true, sheetOrder: true, filterStates: true,
  hyperlinkEdits: true, cfStates: true, dvStates: true, pageSetupStates: true,
  noteStates: true, formulaValues: true, pivotCacheRefreshPaths: true,
  pivotRefreshUpdates: true, sheetProtections: true, sparklineAdditions: true,
  definedNamesState: true, themeState: true, workbookProtectionState: true,
  protectedRangeStates: true,
}).partial()
export type GatewayChanges = import('zod').infer<typeof gatewayChangesSchema>
export function saveRequest(changes: GatewayChanges) {
  return workbookSaveRequestSchema.parse({
    definedNamesState: null, sessionId: crypto.randomUUID(), mode: 'save', edits: [], structuralOps: [],
    chartEdits: [], visualEdits: [], visualAdditions: [], tableAdditions: [],
    pivotAdditions: [], sheetOps: [], sheetOrder: [], filterStates: [],
    hyperlinkEdits: [], cfStates: [], dvStates: [], pageSetupStates: [],
    noteStates: [], formulaValues: [], pivotCacheRefreshPaths: [],
    pivotRefreshUpdates: [], sheetProtections: [], protectedRangeStates: [],
    ...changes,
  })
}
