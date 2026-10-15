import { XlsxSidecarClient } from './upstream/apps/sheets/src/main/xlsx-sidecar-client.ts'
import { saveWorkbookViaSidecar } from './upstream/packages/xlsx-gateway/src/gateway/xlsx-package-io.ts'
import type { CellEdit, SheetFormulaValues } from './upstream/packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'

// Headless integration seam. Coordinates are zero based, like the upstream wire.
// Host owns File identity, permissions, version/CAS and final business commit.
export class SheetSession {
  constructor(public readonly client: XlsxSidecarClient, public readonly sourcePath: string) {}
  metadata: any
  ranges: Record<string, any> = {}
  edits: CellEdit[] = []
  async open() {
    this.metadata = await this.client.open(this.sourcePath)
    for (const sheet of this.metadata.sheets) {
      const request={sessionId:this.metadata.sessionId,sheetId:sheet.id,
        range:{startRow:0,endRow:Math.max(sheet.rowCount-1,0),startColumn:0,endColumn:Math.max(sheet.columnCount-1,0)}}
      const deadline=Date.now()+5000
      let result:any=await this.client.readRange(request)
      // The actual protocol exposes indexingComplete: CF/DV are available
      // only after the background XML index finishes, even on tiny fixtures.
      while (!result.indexingComplete) {
        if(Date.now()>deadline) throw new Error(`Fixture indexing incomplete: ${sheet.name}`)
        await new Promise(r=>setTimeout(r,10))
        result=await this.client.readRange(request)
      }
      this.ranges[sheet.id] = result
    }
    return {metadata:this.metadata,ranges:this.ranges}
  }
  setCell(sheetName: string, row: number, column: number, input: string | number) {
    const sheet = this.metadata.sheets.find((s:any)=>s.name===sheetName)
    if (!sheet || sheet.hidden) throw new Error('Unknown or hidden sheet')
    if (row<0 || column<0 || !Number.isInteger(row) || !Number.isInteger(column)) throw new Error('Invalid coordinates')
    const cell = typeof input==='string' && input.startsWith('=') ? {value:null,formula:input} : {value:input}
    const edit = {sheetName,row,column,writeValue:true,cell}
    this.edits = [...this.edits.filter(e=>!(e.sheetName===sheetName && e.row===row && e.column===column)),edit]
  }
  async recalculate() {
    return await this.client.recalcCells({path:this.sourcePath,
      edits:this.edits.map(e=>({sheet:e.sheetName,row:e.row,column:e.column,input:e.cell.formula ?? String(e.cell.value ?? '')})),
      reads:this.metadata.sheets.map((s:any)=>({sheet:s.name,range:{startRow:0,endRow:Math.max(s.rowCount-1,0),startColumn:0,endColumn:Math.max(s.columnCount-1,0)}}))}) as any
  }
  async save(targetPath: string, formulaValues?: SheetFormulaValues[]) {
    return await saveWorkbookViaSidecar({client:this.client,sourcePath:this.sourcePath,targetPath,edits:this.edits,formulaValues})
  }
  async close() { if(this.metadata) await this.client.close(this.metadata.sessionId) }
}
