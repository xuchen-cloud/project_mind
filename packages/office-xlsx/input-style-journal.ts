type Style = Record<string, unknown>
type NormalizeStyle = (style: Style) => object | undefined

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value

/** Cell input repeats the editor's inherited font. Only changed style fields
 * belong in the journal; keep explicit style commands and resets intact. */
export function withoutUnchangedInputStyles(values: unknown, before: (row: number, column: number) => Style | null | undefined, normalize: NormalizeStyle): unknown {
  if (!values || typeof values !== 'object') return values
  let result: Style | undefined
  for (const [row, cells] of Object.entries(values)) {
    if (!cells || typeof cells !== 'object') continue
    let nextRow: Style | undefined
    for (const [column, value] of Object.entries(cells)) {
      if (!value || typeof value !== 'object') continue
      const cell = value as Style
      if (!('v' in cell || 'f' in cell || 'p' in cell) || !cell.s || typeof cell.s !== 'object') continue
      const previous = normalize(before(Number(row), Number(column)) ?? {}) ?? {}
      const remaining = {...cell.s as Style}
      let changed = false
      for (const [key, item] of Object.entries(remaining)) {
        const neutral = normalize({[key]: item})
        if (!neutral || !Object.keys(neutral).length) continue
        if (Object.entries(neutral).every(([name, next]) => JSON.stringify(stable(next)) === JSON.stringify(stable((previous as Style)[name])))) {
          delete remaining[key]
          changed = true
        }
      }
      if (!changed) continue
      const next = {...cell}
      if (Object.keys(remaining).length) next.s = remaining
      else delete next.s
      nextRow ??= {...cells}
      nextRow[column] = next
    }
    if (!nextRow) continue
    result ??= {...values}
    result[row] = nextRow
  }
  return result ?? values
}
