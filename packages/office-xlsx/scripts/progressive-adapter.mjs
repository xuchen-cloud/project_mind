/** Exact, source-locked transforms; upstream sources remain unmodified. */
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw Error('Progressive XLSX source changed: ' + from)
  return source.replace(from, to)
}
export function adaptProgressiveApp(source) {
  return replace(source, 'formulaMode: opensInFormulaMode(cellCounts),',
    'formulaMode: !window.__projectMindSheetsHost.isPartialView() && opensInFormulaMode(cellCounts),')
}
export function adaptProgressiveSync(source) {
  source = source.replaceAll('if (result.indexingComplete) captureSheetFileState(state, sheetId, result)',
    'if (result.indexingComplete || result.metadataReady) captureSheetFileState(state, sheetId, result)')
  source = replace(source, '      if (result.indexingComplete) {\n        applySheetFilter(',
    '      if (result.indexingComplete || result.metadataReady) {\n        applySheetFilter(')
  source = replace(source, '    if (!result.indexingComplete) {\n      // Poll until the stream finishes:',
    '    if (!(result.indexingComplete || (result.metadataReady && result.rangeReady))) {\n      // Poll until the stream finishes:')
  source = replace(source, '    if (result.indexingComplete) {\n      captureSheetFileState(state, sheetId, result)',
    '    if (result.indexingComplete || result.metadataReady) {\n      captureSheetFileState(state, sheetId, result)')
  return source
}

export function adaptProgressiveHold(source) {
  source = replace(source, 'if (params?.forceCalculation) return',
    'if (params?.forceCalculation && window.__projectMindSheetsHost.canCalculate()) return')
  return replace(source, 'const holding = () => Date.now() - state.lastChunkAt < FORMULA_STREAM_HOLD_MS',
    'const holding = () => !window.__projectMindSheetsHost.canCalculate() || Date.now() - state.lastChunkAt < FORMULA_STREAM_HOLD_MS')
}
