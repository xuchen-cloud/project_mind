import {SetScrollOperation} from '@univerjs/sheets-ui';
import {nextPreviewFrame,type OfficePreviewAccess,type OfficePreviewView} from '../editor-chrome/preview-view';
/** Fixed Univer facade preserves active sheet, zoom and sub-cell scroll offsets. */
export function installXlsxPreviewView(runtime:()=>any) {
  const owner=window as Window & {__projectMindOfficePreview?:OfficePreviewAccess};
  const book=()=>{const value=runtime()?.univerAPI.getActiveWorkbook();if(!value)throw Error('Excel 预览尚未就绪');return value;};
  owner.__projectMindOfficePreview={
    capture(){const workbook=book(),sheet=workbook.getActiveSheet();const scroll=sheet.getScrollState();return {zoom:sheet.getZoom(),sheetId:sheet.getSheetId(),scroll:[],sheetScroll:{sheetViewStartRow:scroll.sheetViewStartRow,sheetViewStartColumn:scroll.sheetViewStartColumn,offsetX:scroll.offsetX,offsetY:scroll.offsetY}};},
    async restore(view:OfficePreviewView){
      const workbook=book(),sheet=workbook.getSheetBySheetId(view.sheetId);
      if(!sheet)throw Error('Excel 预览工作表已不存在');
      workbook.setActiveSheet(sheet);sheet.zoom(view.zoom);await nextPreviewFrame();
      if(view.sheetScroll)await runtime().univerAPI.executeCommand(SetScrollOperation.id,{unitId:workbook.getId(),sheetId:sheet.getSheetId(),...view.sheetScroll});
    },
  };
}
