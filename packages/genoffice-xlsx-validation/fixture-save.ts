import type { SheetSession } from './sheet-session.ts'

/** Precisely the tested numeric-formula fixture path, not a general fallback.
 * Caller explicitly pushes marker only for the cache-sheet-touch branch. */
export async function prepareFixtureSave(session: SheetSession) {
  const recalc:any=await session.recalculate()
  const formulaValues=session.metadata.sheets.map((s:any)=>({sheetName:s.name,
    cells:recalc.cells.filter((c:any)=>c.sheet===s.name&&c.isFormula).map((c:any)=>{
      if(c.isError || typeof c.number!=='number') throw new Error(`Tested save requires numeric formula result: ${s.name}!${c.row}:${c.column}`)
      return {row:c.row,column:c.column,value:c.number}
    })}))
  const sheet=session.metadata.sheets.find((s:any)=>s.name==='说明')
  const original=session.ranges[sheet.id].cells.find((c:any)=>c.row===2&&c.column===1)
  const marker={sheetName:'说明',row:2,column:1,writeValue:false,
    cell:{value:original.value,formula:original.formula}}
  return {recalc,formulaValues,marker}
}
