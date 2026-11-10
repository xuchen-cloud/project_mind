import {readFile} from 'node:fs/promises'
import {adaptSteadyScheduling} from './initialization-adapter.mjs'
import {adaptPlainTextPaste} from './paste-adapter.mjs'
import {adaptCalculationProjection} from './calculation-projection-adapter.mjs'
/**
 * Reproducible patch for pinned @univerjs/sheets-ui 0.25.1 (Apache-2.0).
 * A queued auto-height callback can outlive the workbook during rebase/dispose.
 * The public browser lifecycle test reproduces the missing-workbook dereference.
 */
export const disposedAutoHeightPatch={
  name:'xlsx-disposed-auto-height',
  setup(build){
    build.onLoad({filter:/@univerjs[\\/]engine-formula[\\/]lib[\\/]es[\\/]index\.js$/},async({path})=>({contents:adaptCalculationProjection(await readFile(path,'utf8')),loader:'js'}))
    build.onLoad({filter:/@univerjs[\\/]ui[\\/]lib[\\/]es[\\/]index\.js$/},async({path})=>({contents:adaptSteadyScheduling(await readFile(path,'utf8')),loader:'js'}))
    build.onLoad({filter:/@univerjs[\\/]sheets-note-ui[\\/]lib[\\/]es[\\/]index\.js$/},async({path})=>{
      const text=await readFile(path,'utf8')
      // The 300ms debounce loses freshly typed text when the popup closes or
      // beforeSave snapshots its journal immediately. Notes must journal input
      // synchronously, just like cell text, before the user can leave/save.
      const needle='const updateNote = useDebounceFn((newNote) => {'
      if(text.split(needle).length!==2)throw new Error('Pinned Univer note input patch no longer matches')
      return {contents:text.replace(needle,'const updateNote = ((newNote) => {'),loader:'js'}
    })
    build.onLoad({filter:/@univerjs[\\/]sheets-ui[\\/]lib[\\/]es[\\/]index\.js$/},async({path})=>{
      let text=await readFile(path,'utf8')
      // A restored draft can create a workbook directly from a Univer snapshot.
      // Normalize its active view before scaling the scene, including sheet switches.
      for(const [from,to] of [
        ['const SHEET_ZOOM_RANGE = [10, 400];','const SHEET_ZOOM_RANGE = [50, 150];'],
        ['const zoomRatio = worksheet.getZoomRatio() || 1;', 'const zoomRatio = Math.min(SHEET_ZOOM_RANGE[1] / 100, Math.max(SHEET_ZOOM_RANGE[0] / 100, worksheet.getZoomRatio() || 1));\n\t\t\tworksheet.getConfig().zoomRatio = zoomRatio;'],
      ]){
        if(text.split(from).length!==2)throw Error('Pinned Univer zoom point changed: '+from);
        text=text.replace(from,to);
      }
      const needle='getUndoRedoParamsOfAutoHeight(ranges, subUnitIdParam, currentCellHeights) {\n\t\tconst { _univerInstanceService: univerInstanceService } = this;\n\t\tconst workbook = univerInstanceService.getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET);'
      if(text.split(needle).length!==2)throw new Error('Pinned Univer auto-height patch no longer matches')
      return {contents:adaptPlainTextPaste(text.replace(needle,needle+'\n\t\tif (!workbook) return { redos: [], undos: [] };')),loader:'js'}
    })
  },
}
