/** Pinned Univer's plain-text paste must use parsed numbers even without a new format. */
export function adaptPlainTextPaste(source) {
 const before=`const pattern = getNumfmtParseValueFilter(text);
\t\t\tif (pattern === null || pattern === void 0 ? void 0 : pattern.z) cellValue = { [range.rows[0]]: { [range.cols[0]]: {
\t\t\t\tv: pattern.v,
\t\t\t\ts: { n: { pattern: pattern.z } },
\t\t\t\tf: null
\t\t\t} } };`
 const after=`const pattern = getNumfmtParseValueFilter(text);
\t\t\tif (pattern && typeof pattern.v === 'number') cellValue = { [range.rows[0]]: { [range.cols[0]]: {
\t\t\t\tv: pattern.v,
\t\t\t\tt: CellValueType.NUMBER,
\t\t\t\t...(pattern.z ? { s: { n: { pattern: pattern.z } } } : {}),
\t\t\t\tf: null
\t\t\t} } };`
 if(source.split(before).length!==2)throw new Error('Pinned Univer plain-text paste patch no longer matches')
 return source.replace(before,after)
}
