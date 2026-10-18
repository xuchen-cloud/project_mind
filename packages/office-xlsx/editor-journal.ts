import { CellValueType, type ICellData, type IRange, type IStyleData } from '@univerjs/core'
import { LexerTreeBuilder, ErrorType } from '@univerjs/engine-formula'
import type { Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import {
  createEditJournal, recordSetRangeValues, recordSetNumfmt, recordStructuralOp,
  recordSheetInsert, recordSheetDuplicate, recordSheetRemove, recordSheetRename,
  recordSheetOrderChange, recordSheetHidden, recordSheetTabColor, recordPageSetup,
  recordCfChange, recordDvChange, recordFilterChange, recordNoteChange,
  toSaveEdits, toSaveStructuralOps, toSaveSheetOps, toSavePageSetupStates,
  fromNeutralStyle, plainCellValue, type EditJournal, restoreJournalCells, toNeutralStyle,
} from './generated/edit-journal'
import { matrixBounds } from './generated/file-rendering'
import * as commands from './generated/commands'
import type { WorkbookCellEdit } from './generated/desktop-api'
import type { Edit, GatewayChanges, Model } from './types'

type Workbook = NonNullable<ReturnType<FUniver['getActiveWorkbook']>>
type Params = {
  unitId?: string; subUnitId?: string; sheetId?: string; sheet?: {id: string; name: string}; name?: string
  hidden?: number | boolean; color?: string; cellValue?: Record<string, Record<string, ICellData | null>>
  range?: IRange; ranges?: IRange[]; sourceRange?: IRange; targetRange?: IRange
  from?: { subUnitId?: string; value?: Params['cellValue'] }; to?: { subUnitId?: string; value?: Params['cellValue'] }
  fromRange?: IRange; toRange?: IRange; rowHeight?: number | Record<number, number>; colWidth?: number | Record<number, number>
  autoHeightInfo?: number | Record<number, number>; xSplit?: number; ySplit?: number; zoomRatio?: number; showGridlines?: number; rightToLeft?: number
}
const area = ({startRow,endRow,startColumn,endColumn}: IRange) => ({startRow,endRow,startColumn,endColumn})

/** Uses the upstream journal rather than deriving saves from the visible canvas. */
export function createEditorJournal(univer: Univer, api: FUniver, workbook: Workbook, model: Model, initial: Edit[]) {
  const journal = createEditJournal()
  let copySource: string | undefined
  const seed=initial.find(e=>e.kind==='gateway')
  const extras: GatewayChanges = seed?.kind==='gateway' ? structuredClone(seed.changes) : {}
  for(const [sheetId,entries] of [...new Map((extras.edits??[]).map(e=>[e.sheetId,(extras.edits??[]).filter(v=>v.sheetId===e.sheetId)]) )]) {
    restoreJournalCells(journal,sheetId,(entries??[]).map(e=>({...e,hasValue:e.writeValue,rich:e.rich})))
  }
  for(const {sheetId,...op} of extras.structuralOps??[])journal.structuralOps.set(sheetId,[...(journal.structuralOps.get(sheetId)??[]),op])
  for(const op of extras.sheetOps??[]) {
    if(op.kind==='add-sheet')recordSheetInsert(journal,op.sheetId,op.name)
    if(op.kind==='duplicate-sheet')recordSheetDuplicate(journal,op.sheetId,op.name,op.sourceSheetId)
    if(op.kind==='remove-sheet')recordSheetRemove(journal,op.sheetId)
    if(op.kind==='rename-sheet')recordSheetRename(journal,op.sheetId,op.newName,undefined)
    if(op.kind==='set-sheet-hidden')recordSheetHidden(journal,op.sheetId,op.hidden,model.sheets.find(s=>s.id===op.sheetId)?.hidden??false)
    if(op.kind==='set-sheet-tab-color')recordSheetTabColor(journal,op.sheetId,op.color??undefined,undefined)
  }
  for(const e of initial)if(e.kind!=='gateway') {
    restoreJournalCells(journal,e.sheetId,[{row:e.row,column:e.column,hasValue:true,value:'value'in e?e.value:null,...(e.kind==='formula'?{formula:e.formula}:{})}])
  }
  for(const {sheetId,...state}of extras.pageSetupStates??[])recordPageSetup(journal,sheetId,state)
  let formulaValues: GatewayChanges['formulaValues']
  const baseline=new Map<string,ICellData>()
  for(const sheet of workbook.getSheets())sheet.getSheet().getCellMatrix().forValue((r,c,cell)=>{if(cell)baseline.set(`${sheet.getSheetId()}:${r}:${c}`,structuredClone(cell))})
  // Draft snapshots restore rendering; the upstream journal remains the only save authority.
  function captureFormulaValues(){
    formulaValues=[]
    for(const sheet of workbook.getSheets())sheet.getSheet().getCellMatrix().forValue((row,column,cell)=>{
      if(!cell?.f&&!cell?.si)return
      const value=cell.v
      if(value===undefined||value===null)throw new Error(`公式尚未得到计算结果：${sheet.getSheetName()}!${row+1}:${column+1}`)
      formulaValues!.push({sheetId:sheet.getSheetId(),row,column,value:typeof value==='string'&&Object.values(ErrorType).includes(value as ErrorType)?{error:String(value)}:cell.t===CellValueType.BOOLEAN?!!value:value})
    })
  }
  function changedEdits(){
    const edits=toSaveEdits(journal)
    if(initial.length||journal.structuralOps.size||journal.sheets.added.size||journal.sheets.removed.size)return edits
    return edits.filter(e=>{
      const before=baseline.get(`${e.sheetId}:${e.row}:${e.column}`)
      const after=workbook.getSheetBySheetId(e.sheetId)?.getRange(e.row,e.column).getCellData()
      // Compare actual content/style after an undo, excluding calculation caches.
      const comparable=(cell:ICellData|undefined|null)=>{
        const style=typeof cell?.s==='string'?workbook.getWorkbook().getStyles().get(cell.s):cell?.s
        return {v:cell?.f?null:cell?.v??null,f:cell?.f??null,p:cell?.p??null,s:style?toNeutralStyle(style as Record<string,unknown>):null,t:cell?.f?null:cell?.t??null}
      }
      const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):v
      return JSON.stringify(stable(comparable(before)))!==JSON.stringify(stable(comparable(after)))
    })
  }
  function readCells(sheetId: string, range: IRange) {
    const sheet = workbook.getSheetBySheetId(sheetId)
    if (!sheet) return
    if ((range.endRow-range.startRow+1)*(range.endColumn-range.startColumn+1)>200_000) throw new Error('单次移动或排序超过 200000 格预算')
    const matrix: NonNullable<Params['cellValue']> = {}
    for(let r=range.startRow;r<=range.endRow;r++) for(let c=range.startColumn;c<=range.endColumn;c++) {
      const raw=sheet.getRange(r,c).getCellData()
      const style=raw ? sheet.getSheet().getCellStyle(r,c) : null
      ;(matrix[r]??={})[c]=raw ? {...raw,s:style ?? null} : null
    }
    recordSetRangeValues(journal,sheetId,matrix,resolveShared(sheetId))
  }
  function resolveShared(sheetId: string) {
    return (r: number,c: number,si: string) => {
      let master: {row:number;col:number;formula:string}|undefined
      workbook.getSheetBySheetId(sheetId)?.getSheet().getCellMatrix().forValue((row,col,data)=>{
        if(data?.si===si && data.f) {master={row,col,formula:data.f};return false}
      })
      return master ? univer.__getInjector().get(LexerTreeBuilder).moveFormulaRefOffset(master.formula,c-master.col,r-master.row) : null
    }
  }
  function record(id: string, params: unknown) {
    const p=(params??{}) as Params
    const sid=p.subUnitId??p.sheetId
    if(id===commands.COPY_SHEET_COMMAND) {copySource=undefined;return false}
    if(commands.SHEET_LIFECYCLE_MUTATIONS.has(id)) {
      if(id==='sheet.mutation.insert-sheet' && p.sheet) {
        if(copySource) recordSheetDuplicate(journal,p.sheet.id,p.sheet.name,copySource)
        else recordSheetInsert(journal,p.sheet.id,p.sheet.name)
        copySource=undefined
      } else if(sid) {
        const original=model.sheets.find(s=>s.id===sid)
        if(id==='sheet.mutation.remove-sheet')recordSheetRemove(journal,sid)
        if(id==='sheet.mutation.set-worksheet-name' && p.name)recordSheetRename(journal,sid,p.name,original?.name)
        if(id==='sheet.mutation.set-worksheet-hidden')recordSheetHidden(journal,sid,p.hidden===true||p.hidden===1,original?.hidden??false)
        if(id==='sheet.mutation.set-tab-color')recordSheetTabColor(journal,sid,p.color,original?.tabColor)
      }
      if(id==='sheet.mutation.set-worksheet-order')recordSheetOrderChange(journal)
      return true
    }
    if(id===commands.MOVE_RANGE_MUTATION) {
      const from=p.fromRange??matrixBounds(p.from?.value),to=p.toRange??matrixBounds(p.to?.value)
      if(from)readCells(p.from?.subUnitId??sid!,from)
      if(to)readCells(p.to?.subUnitId??sid!,to)
      return true
    }
    if(commands.DEFINED_NAME_MUTATIONS.has(id)) {journal.definedNames.dirty=true;return true}
    if(!sid)return false
    if(id===commands.SET_RANGE_VALUES_MUTATION) {
      // Resolve interned paste style ids before handing the payload to upstream.
      const cells: NonNullable<Params['cellValue']>={}
      for(const [r,cols] of Object.entries(p.cellValue??{}))for(const [c,raw]of Object.entries(cols)) {
        const style=raw && typeof raw.s==='string' ? workbook.getWorkbook().getStyles().get(raw.s) : raw?.s
        ;(cells[r]??={})[c]=raw ? {...raw,...(typeof raw.s==='string'?{s:style}: {})} : null
      }
      recordSetRangeValues(journal,sid,cells,resolveShared(sid));return true
    }
    if(id===commands.SET_NUMFMT_MUTATION){recordSetNumfmt(journal,sid,p);return true}
    if(id===commands.REMOVE_NUMFMT_MUTATION){for(const r of p.ranges??[])readCells(sid,r);return true}
    const rowColumn=commands.ROW_COLUMN_MUTATIONS[id]
    if(rowColumn&&p.range){const rows=rowColumn.axis==='row';recordStructuralOp(journal,sid,{kind:rowColumn.kind,index:rows?p.range.startRow:p.range.startColumn,count:rows?p.range.endRow-p.range.startRow+1:p.range.endColumn-p.range.startColumn+1},workbook.getSheetBySheetId(sid)?.getSheetName());return true}
    if(id===commands.MOVE_ROWS_MUTATION&&p.sourceRange&&p.targetRange){recordStructuralOp(journal,sid,{kind:'move-rows',index:p.sourceRange.startRow,count:p.sourceRange.endRow-p.sourceRange.startRow+1,before:p.targetRange.startRow},workbook.getSheetBySheetId(sid)?.getSheetName());return true}
    const merge=commands.MERGE_MUTATIONS[id]
    if(merge){for(const r of p.ranges??[])recordStructuralOp(journal,sid,{kind:merge,range:area(r)});return true}
    const axis=commands.AXIS_ATTR_MUTATIONS[id]
    if(axis){
      const rows=axis.axis==='row', sizes=rows?p.rowHeight:p.colWidth
      for(const range of p.ranges??[]) {
        const start=rows?range.startRow:range.startColumn,end=rows?range.endRow:range.endColumn
        if(axis.kind==='hidden')recordStructuralOp(journal,sid,{kind:rows?'set-rows-hidden':'set-cols-hidden',start,end,hidden:!!axis.hidden})
        else for(let index=start;index<=end;index++) {
          const auto=typeof p.autoHeightInfo==='object'?p.autoHeightInfo[index]:p.autoHeightInfo
          const size=typeof sizes==='object'?sizes[index]:sizes
          if(axis.kind==='auto-size'&&auto!==1)continue
          if(axis.kind==='size'&&size===undefined)continue
          recordStructuralOp(journal,sid,{kind:rows?'set-row-size':'set-col-size',start:index,end:index,size:axis.kind==='auto-size'?null:rows?size!*0.75:commands.pixelsToCharacterWidth(size!)})
        }
      }return true
    }
    if(id===commands.REORDER_RANGE_MUTATION&&p.range){readCells(sid,p.range);return true}
    if(commands.CF_MUTATIONS.has(id)){recordCfChange(journal,sid);return true}
    if(commands.DV_MUTATIONS.has(id)){recordDvChange(journal,sid);return true}
    if(commands.FILTER_MUTATIONS.has(id)){recordFilterChange(journal,sid);return true}
    if(commands.NOTE_MUTATIONS.has(id)){recordNoteChange(journal,sid);return true}
    if(id===commands.SET_FROZEN_MUTATION){recordPageSetup(journal,sid,{frozenRows:Math.max(0,p.ySplit??0),frozenColumns:Math.max(0,p.xSplit??0)});return true}
    if(id===commands.TOGGLE_GRIDLINES_MUTATION){recordPageSetup(journal,sid,{showGridlines:p.showGridlines===1});return true}
    if(id===commands.SET_RIGHT_TO_LEFT_MUTATION){recordPageSetup(journal,sid,{rightToLeft:p.rightToLeft===1});return true}
    if((id===commands.SET_ZOOM_OPERATION||id===commands.SET_ZOOM_COMMAND)&&p.zoomRatio!==undefined){recordPageSetup(journal,sid,{zoomScale:Math.min(400,Math.max(10,Math.round(p.zoomRatio*100)))});return true}
    return false
  }
  function changes(): GatewayChanges {
    const result: GatewayChanges={...extras,edits:changedEdits(),structuralOps:toSaveStructuralOps(journal),sheetOps:toSaveSheetOps(journal),sheetOrder:workbook.getSheets().map(s=>s.getSheetId()),pageSetupStates:toSavePageSetupStates(journal)}
    result.cfStates=[...(extras.cfStates??[]).filter(e=>!journal.cfDirty.has(e.sheetId)),...[...journal.cfDirty].flatMap(sheetId=>{
      const sheet=workbook.getSheetBySheetId(sheetId)
      return sheet ? [{sheetId,rules:sheet.getConditionalFormattingRules().map(r=>({ranges:r.ranges.map(area),stopIfTrue:r.stopIfTrue===true,rule:r.rule as unknown as Record<string,unknown>}))}] : []
    })]
    result.dvStates=[...(extras.dvStates??[]).filter(e=>!journal.dvDirty.has(e.sheetId)),...[...journal.dvDirty].flatMap(sheetId=>{
      const sheet=workbook.getSheetBySheetId(sheetId)
      return sheet ? [{sheetId,rules:sheet.getDataValidations().map(({rule})=>{const {ranges,...rest}=rule;return {ranges:ranges.map(area),rule:rest as unknown as Record<string,unknown>}})}] : []
    })]
    result.noteStates=[...(extras.noteStates??[]).filter(e=>!journal.noteDirty.has(e.sheetId)),...[...journal.noteDirty].flatMap(sheetId=>{
      const sheet=workbook.getSheetBySheetId(sheetId)
      const source=(model.sheets.find(s=>s.id===sheetId)?.comments??[]) as {row:number;column:number;author:string;text:string;thread?:import('./generated/desktop-api').SheetThread&{text:string}}[]
      return sheet ? [{sheetId,notes:[...sheet.getNotes().map(n=>{
        const old=source.find(c=>c.row===n.row&&c.column===n.col)
        return {row:n.row,column:n.col,author:old?.author??'',text:n.note}
      }),...source.filter(c=>c.thread).map(c=>{const {text,...thread}=c.thread!;return {row:c.row,column:c.column,author:c.author,text,thread}})]}] : []
    })]
    result.filterStates=[...(extras.filterStates??[]).filter(e=>!journal.filterDirty.has(e.sheetId)),...[...journal.filterDirty].flatMap<NonNullable<GatewayChanges['filterStates']>[number]>(sheetId=>{
      const sheet=workbook.getSheetBySheetId(sheetId),filter=sheet?.getFilter()
      const original=(model.ranges[sheetId]?.autoFilter as IRange|null)
      if(!filter)return original?[{sheetId,filter:null,hiddenRows:[],visibilityRange:area(original)}]:[]
      const range=area(filter.getRange().getRange()),columns:NonNullable<NonNullable<GatewayChanges['filterStates']>[number]['filter']>['columns']=[]
      for(let c=range.startColumn;c<=range.endColumn;c++){
        const criteria=filter.getColumnFilterCriteria(c)
        if(!criteria)continue
        if(criteria.colorFilters)throw new Error('当前网关不支持保存颜色筛选')
        if(!criteria.filters&&!criteria.customFilters)continue
        columns.push({colId:c-range.startColumn,...(criteria.filters?.filters?{values:criteria.filters.filters}:{}),...(criteria.filters?.blank?{blank:true}:{}),...(criteria.customFilters?{customs:{and:!!criteria.customFilters.and,filters:criteria.customFilters.customFilters.map(f=>({val:f.val,...(f.operator?{operator:f.operator}:{})}))}}:{})})
      }
      return [{sheetId,filter:{range,columns},hiddenRows:filter.getFilteredOutRows(),visibilityRange:original?{startRow:Math.min(range.startRow,original.startRow),endRow:Math.max(range.endRow,original.endRow),startColumn:Math.min(range.startColumn,original.startColumn),endColumn:Math.max(range.endColumn,original.endColumn)}:range}]
    })]
    if(journal.definedNames.dirty){
      const names=workbook.getDefinedNames()
      result.definedNamesState={names:names.map(n=>({name:n.getName(),formula:n.getFormulaOrRefString(),...(n.getLocalSheetId()?{sheetIndex:workbook.getSheets().findIndex(s=>s.getSheetId()===n.getLocalSheetId())}:{})})),preserveNames:[]}
    }
    if(formulaValues)result.formulaValues=formulaValues
    return result
  }
  function edits(): Edit[] {
    const value=changes()
    const meaningful=Object.entries(value).some(([k,v])=>k!=='sheetOrder' && k!=='formulaValues' && v!==undefined && (Array.isArray(v)?v.length>0:v!==null))
    return meaningful?[{kind:'gateway',changes:value,snapshot:workbook.save() as unknown as Record<string,unknown>}]:[]
  }
  return {journal,record,edits,changes,captureFormulaValues,prepareCopy:(sheetId?:string)=>{copySource=sheetId??workbook.getActiveSheet()?.getSheetId()}}
}
