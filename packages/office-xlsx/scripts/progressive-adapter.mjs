/** Exact, source-locked transforms; upstream sources remain unmodified. */
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw Error('Progressive XLSX source changed: ' + from)
  return source.replace(from, to)
}
export function adaptProgressiveApp(source) {
  source = replace(source, 'formulaMode: opensInFormulaMode(cellCounts),',
    'formulaMode: !window.__projectMindSheetsHost.isPartialView() && opensInFormulaMode(cellCounts),')
  source = replace(source, '                params.cellValue,',
    '                window.__projectMindSheetsHost.journalCellValues(params.cellValue),')
  source = replace(source, '          const formulas = collectCellFormulaTexts(params?.value ?? params?.cellValue)',
    `          if (event.id === SET_RANGE_VALUES_MUTATION && params?.subUnitId) {
            window.__projectMindSheetsHost.captureInputStyles(params.subUnitId, params.cellValue)
          }
          const formulas = collectCellFormulaTexts(params?.value ?? params?.cellValue)`)
  return replace(source, '        if (recorded.length === 0) return', `        if (recorded.length === 0) return
        if (window.__projectMindSheetsHost.isPartialView() && !state.flags.preloadComplete &&
            recorded.some((entry) => entry.hasValue || entry.formula !== undefined)) {
          window.__projectMindSheetsHost.invalidateFormulaClosure(state)
          void activateFormulaClosure(runtime, lazyWorkbookRef, setMessage)
        }`)
}
export function adaptProgressiveSync(source) {
  const wipe = 'worksheet.getRange(clearStartRow, clearStartColumn, clearRows, clearColumns).setValues(wipe)'
  if (source.split(wipe).length !== 3) throw Error('Streamed eviction write points changed')
  source = source.replaceAll(wipe, `window.__projectMindSheetsHost.writeStreamedCells(worksheet,
          {startRow: clearStartRow, startColumn: clearStartColumn,
           endRow: clearStartRow + clearRows - 1, endColumn: clearStartColumn + clearColumns - 1}, wipe, pinnedKeys)`)
  source = replace(source,
    'worksheet.getRange(range.startRow, range.startColumn, rows, columns).setValues(matrix)',
    'window.__projectMindSheetsHost.writeStreamedCells(worksheet, range, matrix, pinnedKeys)')
  source = replace(source, '    const cellRange = worksheet.getRange(entry.row, entry.column, 1, 1)',
    `    const cellRange = worksheet.getRange(entry.row, entry.column, 1, 1)
    // Formatting replay must carry the current formula through SetRangeValues.
    const replayStyle = (patch: ICellData) => cellRange.setValues([[{
      ...worksheet.getSheet().getCellRaw(entry.row, entry.column), ...patch,
    }]])`)
  source = replace(source, 'cellRange.setValues([[{ s: null } as unknown as ICellData]])', 'replayStyle({ s: null })')
  source = replace(source, 'cellRange.setValues([[{ s: fromNeutralStyle(entry.style) as IStyleData }]])',
    'replayStyle({ s: fromNeutralStyle(entry.style) as IStyleData })')
  source = replace(source, 'cellRange.setValues([[{ custom: { ...existing, ...flags } }]])',
    'replayStyle({ custom: { ...existing, ...flags } })')
  source = source.replaceAll('if (result.indexingComplete) captureSheetFileState(state, sheetId, result)',
    'if (result.indexingComplete || result.metadataReady) captureSheetFileState(state, sheetId, result)')
  source = replace(source, '      if (result.indexingComplete) {\n        applySheetFilter(',
    '      if (result.indexingComplete || result.metadataReady) {\n        applySheetFilter(')
  source = replace(source, '    if (!result.indexingComplete) {\n      // Poll until the stream finishes:',
    '    if (!(result.indexingComplete || (result.metadataReady && result.rangeReady))) {\n      // Poll until the stream finishes:')
  source = replace(source, '    if (result.indexingComplete) {\n      captureSheetFileState(state, sheetId, result)',
    '    if (result.indexingComplete || result.metadataReady) {\n      captureSheetFileState(state, sheetId, result)')
  const start = source.indexOf('export async function activateFormulaClosure(')
  const end = source.indexOf('\n/// On-demand precedent pinning', start)
  if (start < 0 || end < 0) throw Error('Formula closure integration point changed')
  let closure = source.slice(start, end)
  closure = replace(closure, "  state.closure.status = 'pending'", `  const revision = window.__projectMindSheetsHost.formulaClosureRevision(state)
  const current = () => lazyWorkbookRef.current === state &&
    window.__projectMindSheetsHost.formulaClosureRevision(state) === revision
  state.closure.status = 'pending'`)
  const guard = 'if (lazyWorkbookRef.current !== state) return'
  if (closure.split(guard).length !== 4) throw Error('Formula closure async guards changed')
  closure = closure.replaceAll(guard, 'if (!current()) return')
  closure = replace(closure, 'formulas: indexedFormulas(result.cells, shared),',
    'formulas: window.__projectMindSheetsHost.formulasWithEdits(state, sheet.id, indexedFormulas(result.cells, shared)),')
  closure = replace(closure, '            rowCount: sheet.rowCount,\n            columnCount: sheet.columnCount,',
    '            ...window.__projectMindSheetsHost.formulaSheetExtent(state, sheet),')
  closure = replace(closure, '    const pinned = new Map<string, PinnedClosureCell>()', `    const pinned = new Map<string, PinnedClosureCell>()
    // Each installed range must survive eviction while later reads are pending.
    state.closure.pinned.set(sheetId, pinned)
    const closureKeysByRow = new Map<number, number[]>()
    for (const key of cells) {
      const row = keyRow(key)
      const keys = closureKeysByRow.get(row) ?? []
      keys.push(key)
      closureKeysByRow.set(row, keys)
    }`)
  closure = replace(closure, `      }
    }
    state.closure.pinned.set(sheetId, pinned)`, `      }
      for (let row = range.startRow; row <= range.endRow; row += 1) {
        for (const key of closureKeysByRow.get(row) ?? []) {
          const column = keyColumn(key), address = row + ':' + column
          if (column < range.startColumn || column > range.endColumn) continue
          const content = journalCellContentAt(state.editJournal, sheetId, row, column)
          if (content.found) {
            pinned.set(address, content.formula ? {f: content.formula, v: null} : {v: content.value ?? null})
          } else if (!pinned.has(address)) {
            pinned.set(address, {v: null})
          }
        }
      }
    }`)
  closure = replace(closure, "  state.closure.status = 'active'", "  if (!current()) return\n  state.closure.status = 'active'")
  source = source.slice(0, start) + closure + source.slice(end)
  return source
}

export function adaptProgressiveHold(source) {
  source = replace(source, 'if (params?.forceCalculation) return',
    'if (params?.forceCalculation && window.__projectMindSheetsHost.canCalculate()) return')
  return replace(source, 'const holding = () => Date.now() - state.lastChunkAt < FORMULA_STREAM_HOLD_MS',
    'const holding = () => !window.__projectMindSheetsHost.canCalculate() || Date.now() - state.lastChunkAt < FORMULA_STREAM_HOLD_MS')
}
