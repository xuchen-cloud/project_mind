import type { Area, Model, OfficeViewRead, Range } from './types'

/** A ready bounded read also covers blank rows after the last indexed cell.
 * Preserve native indexing progress; widen only this mapped viewport coverage. */
export function withReadyRangeCoverage<T extends {raw:{rangeReady?:boolean};indexedThroughScreen:number|null}>(mapped:T|null, area:Area):T|null {
  return mapped?.raw.rangeReady === true ? {...mapped,indexedThroughScreen:area.endRow} : mapped
}

/** One row index per immutable complete snapshot; the GUI normally reads native ranges. */
const indices = new WeakMap<Range, { cells: Map<number, Range['cells']>; rows: Map<number, Range['rows'][number]> }>()
export function snapshotRange(model: Model, sheetId: string, area: Area) {
  const source = model.ranges[sheetId]
  if (!source || model.coverage?.kind === 'partial') throw Error('Range requires its live workbook view')
  let index = indices.get(source)
  if (!index) {
    index = { cells: new Map(), rows: new Map() }
    for (const cell of source.cells) {
      let row = index.cells.get(cell.row)
      if (!row) index.cells.set(cell.row, row = [])
      row.push(cell)
    }
    for (const row of source.rows) index.rows.set(row.row, row)
    indices.set(source, index)
  }
  const cells: Range['cells'] = [], rows: Range['rows'] = []
  for (let row = area.startRow; row <= area.endRow; row++) {
    for (const cell of index.cells.get(row) ?? []) if (cell.column >= area.startColumn && cell.column <= area.endColumn) cells.push(cell)
    const property = index.rows.get(row)
    if (property) rows.push(property)
  }
  const {area: _area, ...metadata} = source
  return {...metadata, cells, rows}
}

/** Scoped to one frame/source. In-flight requests coalesce; only ready ranges enter the LRU. */
export function createViewReader(read: (request: OfficeViewRead) => Promise<unknown>) {
  const cache = new Map<string, Promise<unknown>>()
  return (request: OfficeViewRead): Promise<unknown> => {
    // Formula/outline inventories evolve while indexing and must never freeze in cache.
    if (request.kind !== 'range') return read(request)
    const key = JSON.stringify(request)
    const hit = cache.get(key)
    if (hit) {cache.delete(key); cache.set(key, hit); return hit}
    const result = read(request).then(value => {
      const range = value as Range
      if (!(range.indexingComplete || range.rangeReady === true)) cache.delete(key)
      return value
    }, error => {cache.delete(key); throw error})
    cache.set(key, result)
    // Protocol allows 100k cells/range. Eight ranges cap this cache at 800k cells.
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    return result
  }
}
