type Cell = Record<string, unknown>

export const STREAMED_CELL_MUTATION = 'sheet.mutation.set-range-values'
const CALCULATION_METADATA = new Set([
  'formula.mutation.set-formula-calculation-start',
  'formula.mutation.set-trigger-formula-calculation-start',
  'formula.mutation.set-formula-calculation-stop',
  'formula.mutation.set-formula-calculation-notification',
])
export const isCalculationMetadata = (id: string): boolean => CALCULATION_METADATA.has(id)

type ProjectionTarget = { unitId: string; subUnitId: string }

/** Authorize the synchronous projection and its scoped formula observers. */
export class ProjectionMutationGate {
  private readonly active = new Set<ProjectionTarget>()
  private readonly calculationBooks: string[] = []

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
    for (const unitId of this.calculationBooks) {
      if (id === STREAMED_CELL_MUTATION && options.fromFormula === true && data.unitId === unitId) return true
      if (id === 'formula.mutation.set-formula-calculation-result' && withinBook(data.unitData, unitId) && withinBook(data.unitOtherData ?? {}, unitId)) return true
      if (id === 'formula.mutation.set-array-formula-data' && withinBook(data.arrayFormulaRange, unitId) && withinBook(data.arrayFormulaCellData, unitId) && withinBook(data.arrayFormulaEmbedded ?? {}, unitId)) return true
      if (id === 'formula.mutation.set-image-formula-data' && Array.isArray(data.imageFormulaData) && data.imageFormulaData.every(item => item?.unitId === unitId)) return true
      if (id === 'formula.mutation.set-formula-dependency-calculation-result') return true
    }
    return false
  }

  run<T>(params: ProjectionTarget, apply: () => T): T {
    this.active.add(params)
    try { return apply() } finally { this.active.delete(params) }
  }

  runCalculation<T>(unitId: string, apply: () => T): T {
    this.calculationBooks.push(unitId)
    try { return apply() } finally { this.calculationBooks.pop() }
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
