import {readFile} from 'node:fs/promises'
import {adaptSteadyScheduling} from './initialization-adapter.mjs'
import {adaptPlainTextPaste} from './paste-adapter.mjs'
/**
 * Reproducible patch for pinned @univerjs/sheets-ui 0.25.1 (Apache-2.0).
 * A queued auto-height callback can outlive the workbook during rebase/dispose.
 * The public browser lifecycle test reproduces the missing-workbook dereference.
 */
export const disposedAutoHeightPatch={
  name:'xlsx-disposed-auto-height',
  setup(build){
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
      const text=await readFile(path,'utf8')
      const needle='getUndoRedoParamsOfAutoHeight(ranges, subUnitIdParam, currentCellHeights) {\n\t\tconst { _univerInstanceService: univerInstanceService } = this;\n\t\tconst workbook = univerInstanceService.getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET);'
      if(text.split(needle).length!==2)throw new Error('Pinned Univer auto-height patch no longer matches')
      return {contents:adaptPlainTextPaste(text.replace(needle,needle+'\n\t\tif (!workbook) return { redos: [], undos: [] };')),loader:'js'}
    })
  },
}
