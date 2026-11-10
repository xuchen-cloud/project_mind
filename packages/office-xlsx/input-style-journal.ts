import {canonicalCellData} from './cell-comparison'

type Style = Record<string, unknown>
type NormalizeStyle = (style: Style) => object | undefined

/** Cell input repeats the editor's inherited font. Only changed style fields
 * belong in the journal; keep explicit style commands and resets intact. */
export function withoutUnchangedInputStyles(values: unknown, before: (row: number, column: number) => Style | null | undefined, normalize: NormalizeStyle): unknown {
  if (!values || typeof values !== 'object') return values
  let result: Style | undefined
  for (const [row, cells] of Object.entries(values)) {
    const rowIndex = Number(row)
    if (!Number.isInteger(rowIndex) || rowIndex < 0) continue
    if (!cells || typeof cells !== 'object') continue
    let nextRow: Style | undefined
    for (const [column, value] of Object.entries(cells)) {
      const columnIndex = Number(column)
      if (!Number.isInteger(columnIndex) || columnIndex < 0) continue
      if (!value || typeof value !== 'object') continue
      const cell = value as Style
      if (!('v' in cell || 'f' in cell || 'p' in cell) || !cell.s || typeof cell.s !== 'object') continue
      const previous = normalize(before(rowIndex, columnIndex) ?? {}) ?? {}
      const remaining = {...cell.s as Style}
      let changed = false
      for (const [key, item] of Object.entries(remaining)) {
        const neutral = normalize({[key]: item})
        if (!neutral || !Object.keys(neutral).length) continue
        if (Object.entries(neutral).every(([name, next]) => JSON.stringify(canonicalCellData(next)) === JSON.stringify(canonicalCellData((previous as Style)[name])))) {
          delete remaining[key]
          changed = true
        }
      }
      if (!changed) continue
      const next = {...cell}
      if (Object.keys(remaining).length) next.s = remaining
      else delete next.s
      const updatedRow: Style = nextRow ?? {...cells}
      updatedRow[column] = next
      nextRow = updatedRow
    }
    if (!nextRow) continue
    result ??= {...values}
    result[row] = nextRow
  }
  return result ?? values
}
