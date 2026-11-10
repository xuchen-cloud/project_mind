type Cell = Record<string, unknown>

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
