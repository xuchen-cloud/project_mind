import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {inspect,recalculate} from '../dist/engine.mjs'

test('read-only formula queries apply temporary inputs to source XLSX and return real native results',async()=>{
 const source=await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)),before=new Uint8Array(source)
 const result=await recalculate(source,{edits:[{sheetId:'sheet-1',row:2,column:1,input:'15'}],reads:[{sheetId:'sheet-1',range:{startRow:4,endRow:6,startColumn:1,endColumn:1}}]})
 assert.equal(result.cells.find(c=>c.sheetId==='sheet-1'&&c.row===4&&c.column===1)?.number,35)
 assert.equal(result.cells.find(c=>c.sheetId==='sheet-1'&&c.row===6&&c.column===1)?.number,30)
 assert.equal(result.cells.find(c=>c.row===4)?.isFormula,true)
 const wide=await recalculate(source,{edits:[{sheetId:'sheet-1',row:2,column:1,input:'15'}],reads:[{sheetId:'sheet-1',range:{startRow:0,endRow:20000,startColumn:1,endColumn:1}}]});assert.equal(wide.cells.find(c=>c.row===4)?.number,35);assert.equal(wide.cells.find(c=>c.row===6)?.number,30)
 assert.deepEqual(new Uint8Array(source),before)
 assert.equal((await inspect(source)).ranges['sheet-1'].cells.find(c=>c.row===2&&c.column===1)?.value,10)
 await assert.rejects(recalculate(source,{edits:[],reads:[{sheetId:'unowned',range:{startRow:0,endRow:0,startColumn:0,endColumn:0}}]}),/Unknown sheet/)
 await assert.rejects(recalculate(source,{edits:[],reads:[{sheetId:'sheet-1',range:{startRow:0,endRow:100000,startColumn:0,endColumn:0}}]}),/100000/)
})
