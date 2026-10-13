/** Pure data seam for a React view. Keep upstream metadata, dimensions and
 * style indices intact. This does not implement a spreadsheet renderer. */
export function workbookViewModel({metadata,ranges}) {
  return {
    sessionId:metadata.sessionId,
    activeSheetId:metadata.sheets[metadata.activeTab ?? 0]?.id,
    styles:metadata.styles,
    visuals:metadata.visuals,
    sheets:metadata.sheets.map(sheet=>({
      id:sheet.id,name:sheet.name,hidden:sheet.hidden,veryHidden:sheet.veryHidden??false,
      rowCount:sheet.rowCount,columnCount:sheet.columnCount,
      columnWidths:sheet.columnWidths,defaultRowHeight:sheet.defaultRowHeight,
      freeze:sheet.freeze,rows:ranges[sheet.id]?.rows??[],
      merges:ranges[sheet.id]?.merges??[],
      cells:(ranges[sheet.id]?.cells??[]).map(c=>({row:c.row,column:c.column,
        value:c.value,formula:c.formula,styleIndex:c.styleIndex,rich:c.rich})),
      conditionalRules:ranges[sheet.id]?.conditionalRules??[],
      dataValidations:ranges[sheet.id]?.dataValidations??[],
      indexingComplete:ranges[sheet.id]?.indexingComplete??false,
    })),
  }
}
