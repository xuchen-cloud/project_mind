type Cell = Record<string, unknown>

export const STREAMED_CELL_MUTATION = 'sheet.mutation.set-range-values'

type ProjectionTarget = { unitId: string; subUnitId: string }

/** Authorize the synchronous projection and its scoped formula observers. */
export class ProjectionMutationGate {
  private readonly active = new Set<ProjectionTarget>()

  permits(id: string, params: unknown, options?: { onlyLocal?: boolean; fromFormula?: boolean }): boolean {
    if (typeof params !== 'object' || params === null) return false
    if (id === STREAMED_CELL_MUTATION && this.active.has(params as ProjectionTarget)) return true
    if (options?.onlyLocal !== true) return false
    const data = params as Record<string, unknown>
    const withinBook = (value: unknown, unitId: string): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && Object.keys(value).every(key => key === unitId)
    for (const target of this.active) {
      if (id === STREAMED_CELL_MUTATION && options.fromFormula === true && data.unitId === target.unitId && data.subUnitId === target.subUnitId) return true
      if (id === 'formula.mutation.set-formula-data' && withinBook(data.formulaData, target.unitId)) {
        const sheets = data.formulaData[target.unitId]
        if (sheets && typeof sheets === 'object' && Object.keys(sheets).every(key => key === target.subUnitId)) return true
      }
      if (id === 'formula.mutation.set-array-formula-data' && withinBook(data.arrayFormulaRange, target.unitId) && withinBook(data.arrayFormulaCellData, target.unitId)) return true
    }
    return false
  }

  run<T>(params: ProjectionTarget, apply: () => T): T {
    this.active.add(params)
    try { return apply() } finally { this.active.delete(params) }
  }
}

/** Univer's formula observer treats even {} as deleting the formula. Omit
 * untouched coordinates from the mutation, including pinned styled cells. */
export function streamedCellWrites(matrix: readonly (readonly Cell[])[], startRow: number, startColumn: number, pinned?: ReadonlySet<string>): Record<number, Record<number, Cell>> {
  const writes: Record<number, Record<number, Cell>> = {}
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix[row].length; column += 1) {
      const cell = matrix[row][column]
      const targetRow = startRow + row, targetColumn = startColumn + column
      if (!Object.keys(cell).length || pinned?.has(`${targetRow}:${targetColumn}`)) continue
      ;(writes[targetRow] ??= {})[targetColumn] = cell
    }
  }
  return writes
}
