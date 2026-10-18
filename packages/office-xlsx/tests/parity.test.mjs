import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { inspect, edit } from '../dist/engine.mjs'
const original = await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url))
const cell = (m, r, c) => m.ranges['sheet-1'].cells.find(x => x.row === r && x.column === c)

test('gateway format and rich text edits save to XLSX and preserve unseen objects', async () => {
  const saved = await edit(original, [{ kind: 'gateway', changes: { edits: [
    {sheetId:'sheet-1',row:2,column:0,writeValue:false,value:null,style:{bold:true,fontSize:18,fillColor:'#FFE4B5',borderBottom:{style:'double',color:'#805020'}}},
    {sheetId:'sheet-1',row:19,column:3,writeValue:true,value:'rich text',rich:[
      {text:'rich ',bold:true,italic:false,underline:false,strikethrough:false},
      {text:'text',bold:false,italic:true,underline:false,strikethrough:false},
    ]},
  ] } }])
  const reopened = await inspect(saved)
  assert.equal(cell(reopened,2,0).value, '苹果')
  const style = reopened.styles[cell(reopened,2,0).styleIndex]
  assert.equal(style.bold,true)
  assert.equal(style.fontSize,18)
  assert.equal(style.fillColor,'#FFE4B5')
  assert.equal(style.borderBottom.style,'double')
  assert.equal(cell(reopened,19,3).value,'rich text')
  assert.equal(cell(reopened,19,3).rich[0].bold,true)
  assert.equal(cell(reopened,19,3).rich[1].italic,true)
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(saved)
  for (const path of Object.keys(before.files).filter(p=>/charts\/|drawings\/|media\//.test(p)))
    assert.deepEqual(await after.file(path).async('uint8array'),await before.file(path).async('uint8array'),path)
})

test('used cells beyond Z100 are loaded and editable on open without a host range reload', async () => {
  const saved = await edit(original,[{kind:'gateway',changes:{edits:[
    {sheetId:'sheet-1',row:149,column:39,writeValue:true,value:'AN150'},
  ]}}])
  const reopened = await inspect(saved)
  assert.equal(cell(reopened,149,39)?.value,'AN150')
  assert.ok(reopened.ranges['sheet-1'].area.endRow>=149)
  assert.ok(reopened.ranges['sheet-1'].area.endColumn>=39)
})

test('structural edits shift formulas, row dimensions and drawing anchors then recalculate XLSX caches', async () => {
  const saved=await edit(original,[{kind:'gateway',changes:{structuralOps:[
    {sheetId:'sheet-1',kind:'insert-rows',index:2,count:1},
    {sheetId:'sheet-1',kind:'set-row-size',start:3,end:3,size:30},
    {sheetId:'sheet-1',kind:'set-col-size',start:0,end:0,size:20},
    {sheetId:'sheet-1',kind:'merge-cells',range:{startRow:19,endRow:19,startColumn:3,endColumn:4}},
  ],edits:[{sheetId:'sheet-1',row:3,column:1,writeValue:true,value:15}]}}])
  const reopened=await inspect(saved)
  assert.equal(cell(reopened,3,0).value,'苹果')
  assert.equal(cell(reopened,5,1).formula,'=SUM(B4:B5)')
  assert.equal(cell(reopened,5,1).value,35)
  assert.equal(reopened.ranges['sheet-1'].rows.find(r=>r.row===3).height,30)
  assert.equal(reopened.sheets[0].columnWidths.find(c=>c.startColumn===0).width,20)
  assert.ok(reopened.ranges['sheet-1'].merges.some(m=>m.startRow===19&&m.endColumn===4))
  const zip=await JSZip.loadAsync(saved)
  const drawing=await zip.file('xl/drawings/drawing1.xml').async('string')
  assert.ok(drawing.includes('<'))
})

test('a row shift and a new table save atomically to the original XLSX',async()=>{
 const saved=await edit(original,[{kind:'gateway',changes:{structuralOps:[{sheetId:'sheet-1',kind:'insert-rows',index:0,count:1}],tableAdditions:[{sheetId:'sheet-1',area:{startRow:2,endRow:4,startColumn:0,endColumn:1},name:'ParityTable',columnNames:['品名','金额'],bandedRows:true}]}}])
 const fresh=await inspect(saved)
 assert.equal(cell(fresh,3,0).value,'苹果')
 assert.ok(fresh.sheets[0].tables.some(t=>t.name==='ParityTable'))
 const zip=await JSZip.loadAsync(saved);const table=Object.keys(zip.files).find(p=>/xl\/tables\/table\d+\.xml$/.test(p));assert.match(await zip.file(table).async('string'),/ref="A3:B5"/)
})

test('new-sheet objects survive structural staging and reordered native sheet identities',async()=>{
 const saved=await edit(original,[{kind:'gateway',changes:{
  sheetOps:[{kind:'add-sheet',sheetId:'new-summary',name:'新汇总'},{kind:'reorder-sheets'}],sheetOrder:['new-summary','sheet-2','sheet-1','sheet-3'],
  structuralOps:[{sheetId:'sheet-1',kind:'insert-rows',index:0,count:1}],
  edits:[{sheetId:'new-summary',row:0,column:0,writeValue:true,value:'项目'},{sheetId:'new-summary',row:0,column:1,writeValue:true,value:'值'},{sheetId:'new-summary',row:1,column:0,writeValue:true,value:'新表保留'},{sheetId:'new-summary',row:1,column:1,writeValue:true,value:17}],
  tableAdditions:[{sheetId:'new-summary',area:{startRow:0,endRow:1,startColumn:0,endColumn:1},name:'AddedSheetTable',columnNames:['项目','值'],bandedRows:true},{sheetId:'sheet-1',area:{startRow:2,endRow:4,startColumn:0,endColumn:1},name:'OriginalDetailTable',columnNames:['品名','金额'],bandedRows:true}],
 }}])
 const fresh=await inspect(saved),summary=fresh.sheets.find(s=>s.name==='新汇总'),detail=fresh.sheets.find(s=>s.name==='明细')
 assert.deepEqual(fresh.sheets.map(s=>s.name),['新汇总','说明','明细','隐藏数据'])
 assert.ok(summary.tables.some(t=>t.name==='AddedSheetTable'));assert.ok(detail.tables.some(t=>t.name==='OriginalDetailTable'))
 assert.equal(fresh.ranges[summary.id].cells.find(c=>c.row===1&&c.column===1).value,17)
 assert.equal(fresh.ranges[detail.id].cells.find(c=>c.row===3&&c.column===0).value,'苹果')
 assert.equal(fresh.sheets.find(s=>s.name==='说明').tables.length,0,'deferred objects cannot follow stale sheet indexes')
})

test('a pivot on an added sheet keeps its added source through one staged save',async()=>{
 const changes={sheetOps:[{kind:'add-sheet',sheetId:'pivot-source',name:'源区域'},{kind:'add-sheet',sheetId:'pivot-output',name:'透视结果'},{kind:'reorder-sheets'}],sheetOrder:['pivot-output','sheet-1','pivot-source','sheet-2','sheet-3'],edits:[
  {sheetId:'pivot-source',row:0,column:0,writeValue:true,value:'项目'},{sheetId:'pivot-source',row:0,column:1,writeValue:true,value:'金额'},
  {sheetId:'pivot-source',row:1,column:0,writeValue:true,value:'合同'},{sheetId:'pivot-source',row:1,column:1,writeValue:true,value:17},
  {sheetId:'pivot-output',row:0,column:0,writeValue:true,value:'项目'},{sheetId:'pivot-output',row:0,column:1,writeValue:true,value:'金额合计'},
  {sheetId:'pivot-output',row:1,column:0,writeValue:true,value:'合同'},{sheetId:'pivot-output',row:1,column:1,writeValue:true,value:17},
 ],pivotAdditions:[{sheetId:'pivot-output',sourceSheetId:'pivot-source',sourceArea:{startRow:0,endRow:1,startColumn:0,endColumn:1},location:{startRow:0,endRow:2,startColumn:0,endColumn:1},name:'AddedSheetPivot',fieldNames:['项目','金额'],rowFieldIndices:[0],rowItems:['合同'],values:[{fieldIndex:1,agg:'sum'}]}]}
 const fresh=await inspect(await edit(original,[{kind:'gateway',changes}])),output=fresh.sheets.find(s=>s.name==='透视结果'),source=fresh.sheets.find(s=>s.name==='源区域')
 assert.equal(output.pivotTables.length,1);assert.equal(source.pivotTables.length,0)
 const pivot=fresh.rendererData.pivots[output.pivotTables[0].path];assert.equal(pivot.sourceSheet,'源区域');assert.equal(pivot.sourceRef,'A1:B2')
 assert.equal(fresh.ranges[output.id].cells.find(c=>c.row===1&&c.column===1).value,17)
})
