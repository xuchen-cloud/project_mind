import type { FUniver } from '@univerjs/core/facade'
import { BooleanNumber } from '@univerjs/core'
import type { IFilterColumn } from '@univerjs/preset-sheets-filter'
import type { Model } from './types'
import type { WorkbookFile, WorkbookRangeResult, WorkbookCellStyle } from './generated/desktop-api'
import { buildConditionalRule, toUniverDvRule } from './generated/file-rendering'
/** Install the complete source rule sets before enabling their editing tools. */
export function installFileDecorations(api:FUniver,workbook: NonNullable<ReturnType<FUniver['getActiveWorkbook']>>,model: Model,restored=false){
  const unsupported={cf:new Set<string>(),dv:new Set<string>()}
  for(const meta of model.sheets){
    const sheet=workbook.getSheetBySheetId(meta.id)
    if(!sheet)continue
    const source=model.ranges[meta.id] as unknown as WorkbookRangeResult
    if(source.autoFilter&&!restored){
      const filter=sheet.getRange(source.autoFilter.startRow,source.autoFilter.startColumn,source.autoFilter.endRow-source.autoFilter.startRow+1,source.autoFilter.endColumn-source.autoFilter.startColumn+1).createFilter()
      for(const col of source.autoFilterColumns??[]){
        const criteria:IFilterColumn={colId:col.colId,...(col.values||col.blank?{filters:{filters:col.values??[],...(col.blank?{blank:true as const}:{})}}:{}),...(col.customs?{customFilters:{...(col.customs.and?{and:BooleanNumber.TRUE as const}:{}),customFilters:col.customs.filters as NonNullable<IFilterColumn['customFilters']>['customFilters']}}:{})}
        filter?.setColumnFilterCriteria(source.autoFilter.startColumn+col.colId,criteria)
      }
    }
    const comments=(meta.comments??[]) as {row:number;column:number;text:string;thread?:unknown}[]
    for(const comment of comments.filter(c=>!c.thread&&!restored))sheet.getRange(comment.row,comment.column).createOrUpdateNote({id:crypto.randomUUID(),row:comment.row,col:comment.column,note:comment.text,width:160,height:100,show:false})
    for(const [index,rule]of (model.ranges[meta.id].dataValidations as WorkbookRangeResult['dataValidations']).entries()){
      const mapped=toUniverDvRule(rule,`file-${meta.id}-${index}`,model as unknown as WorkbookFile)
      if(mapped&&!restored)api.syncExecuteCommand('data-validation.mutation.addRule',{unitId:workbook.getId(),subUnitId:meta.id,rule:mapped})
      else if(!mapped)unsupported.dv.add(meta.id)
    }
    for(const rule of model.ranges[meta.id].conditionalRules as WorkbookRangeResult['conditionalRules']){
      const built=buildConditionalRule(sheet,(model.dxfStyles??[]) as WorkbookCellStyle[],rule)
      if(built&&!restored)sheet.addConditionalFormattingRule(built)
      else if(!built)unsupported.cf.add(meta.id)
    }
  }
  for(const name of restored?[]:model.definedNames){
    const builder=workbook.newDefinedNameBuilder().setName(name.name).setRef(name.formula)
    if(name.sheetIndex!==undefined)builder.setScopeToWorksheet(workbook.getSheets()[name.sheetIndex])
    workbook.insertDefinedNameBuilder(builder.build())
  }
  return unsupported
}
