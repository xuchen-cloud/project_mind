import type {LazyWorkbookState} from './vendor/apps/sheets/src/renderer/univer-state'

type FormulaCell = {row: number; column: number; formula: string}
const revisions = new WeakMap<LazyWorkbookState, number>()

export const formulaClosureRevision = (state: LazyWorkbookState): number => revisions.get(state) ?? 0

/** A closure covers the formulas that were analyzed, including session edits. */
export function invalidateFormulaClosure(state: LazyWorkbookState): void {
  revisions.set(state, formulaClosureRevision(state) + 1)
  state.closure.status = 'idle'
  state.closure.pinned.clear()
  state.recalc.generation += 1
  if (state.recalc.timer) clearTimeout(state.recalc.timer)
  state.recalc.timer = null
  state.recalc.running = false
  state.recalc.overlay.clear()
  state.recalc.follow.clear()
}

export function formulasWithEdits(state: LazyWorkbookState, sheetId: string, original: readonly FormulaCell[]): FormulaCell[] {
  const formulas = new Map(original.map(cell => [`${cell.row}:${cell.column}`, cell]))
  for (const [key, entry] of state.editJournal.cells.get(sheetId) ?? []) {
    if (entry.formula) formulas.set(key, {row: entry.row, column: entry.column, formula: entry.formula})
    else if (entry.hasValue) formulas.delete(key)
  }
  return [...formulas.values()]
}

export function formulaSheetExtent(state: LazyWorkbookState, sheet: {id: string; rowCount: number; columnCount: number}): {rowCount: number; columnCount: number} {
  let {rowCount, columnCount} = sheet
  for (const entry of state.editJournal.cells.get(sheet.id)?.values() ?? []) {
    if (!entry.hasValue && !entry.formula) continue
    rowCount = Math.max(rowCount, entry.row + 1)
    columnCount = Math.max(columnCount, entry.column + 1)
  }
  for (const fill of state.editJournal.bulkConstantFills.get(sheet.id) ?? []) {
    rowCount = Math.max(rowCount, fill.endRow + 1)
    columnCount = Math.max(columnCount, fill.endColumn + 1)
  }
  return {rowCount, columnCount}
}
