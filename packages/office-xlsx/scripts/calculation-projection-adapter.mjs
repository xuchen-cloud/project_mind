/** Keep the pinned engine's result publication in one synchronous projection. */
export function adaptCalculationProjection(source) {
  const start = source.indexOf('\tasync _applyResult(data) {')
  const end = source.indexOf('\n\t}\n};\nCalculateController =', start)
  if (start < 0 || end < 0 || source.indexOf('\tasync _applyResult(data) {', start + 1) >= 0) throw Error('Pinned formula result projection point changed')
  const body = source.slice(start + '\tasync _applyResult(data) {'.length, end)
  if (body.split('this._commandService.executeCommand(').length !== 4) throw Error('Pinned formula result dispatch points changed')
  return source.slice(0, start) + `\tasync _applyResult(data) {
    const apply = () => {${body.replaceAll('this._commandService.executeCommand(', 'this._commandService.syncExecuteCommand(')}
    };
    const host = globalThis.__projectMindSheetsHost;
    return host ? host.projectCalculationResult(data, apply) : apply();` + source.slice(end)
}
