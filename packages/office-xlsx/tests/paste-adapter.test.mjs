import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {getNumfmtParseValueFilter,CellValueType} from '@univerjs/core'
import {adaptPlainTextPaste} from '../scripts/paste-adapter.mjs'
const source=readFileSync(new URL('../node_modules/@univerjs/sheets-ui/lib/es/index.js',import.meta.url),'utf8')
function paste(text,adapt=true){
 const code=adapt?adaptPlainTextPaste(source):source
 const start=code.indexOf('\t_onPastePlainText(pasteTo, text, payload) {')
 const end=code.indexOf('\n\t_onPasteCells(',start)
 assert.ok(start>=0&&end>start)
 const controller=Function('getNumfmtParseValueFilter','CellValueType','Tools','isFormulaString','SetRangeValuesMutation','SetRangeValuesUndoMutationFactory',`return ({${code.slice(start,end)}})`)(getNumfmtParseValueFilter,CellValueType,{isLegalUrl:()=>false},v=>v.startsWith('='),{id:'set-range'},()=>({undo:true}))
 const mutations=controller._onPastePlainText({range:{rows:[2],cols:[1]},unitId:'book',subUnitId:'sheet-1'},text,{})
 return {cell:mutations.redos[0].params.cellValue[2][1],mutations}
}
test('plain number paste stores numeric cells and retains the existing destination format',()=>{
 assert.equal(paste('25',false).cell.v,'25','pinned upstream reproduces string storage')
 for(const [input,value]of [['25',25],['-12.5',-12.5],['0',0]]){
  const {cell,mutations}=paste(input)
  assert.equal(cell.v,value)
  assert.equal(cell.t,CellValueType.NUMBER)
  assert.equal('s'in cell,false,'a plain number must not replace the destination number format')
  assert.equal(mutations.undos.length,1)
 }
})
test('formatted numbers, formulas and ordinary text keep their paste behavior',()=>{
 assert.equal(paste('25%').cell.v,0.25)
 assert.equal(paste('25%').cell.s.n.pattern,'0%')
 assert.equal(paste('=SUM(B3:B4)').cell.f,'=SUM(B3:B4)')
 assert.equal(paste('hello').cell.v,'hello')
 assert.equal(paste("'25").cell.v,"'25")
})
