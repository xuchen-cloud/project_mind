/** Stable cell/style data for equality; preserves arrays and scalar values. */
export const canonicalCellData = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalCellData) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalCellData(item)])) : value
