import {fileURLToPath} from 'node:url'

function replaceOnce(source,from,to){
 if(source.split(from).length!==2)throw Error('Pinned XLSX initialization point changed: '+from)
 return source.replace(from,to)
}

export function adaptSteadyScheduling(source){
 source=replaceOnce(source,'const STEADY_TIMEOUT = 3e3;','')
 source=replaceOnce(source,'\t\t\t\tawait this._lifecycleService.onStage(LifecycleStages.Ready);','\t\t\t\tawait this._lifecycleService.onStage(LifecycleStages.Ready);\n\t\t\t\tif (this._disposed) return;')
 source=replaceOnce(source,'this._renderTimeout = window.setTimeout(() => {','this._cancelRenderInit = schedulePostPaint(() => {')
 source=replaceOnce(source,'this._lifecycleService.stage = LifecycleStages.Rendered;',"this._lifecycleService.stage = LifecycleStages.Rendered;performance.mark('office-xlsx:rendered-hooks-complete');")
 source=replaceOnce(source,'\n\t\t\t\t}, 300);','\n\t\t\t\t});')
 source=replaceOnce(source,'\t\t\t\t\tthis._steadyTimeout = window.setTimeout(() => {\n\t\t\t\t\t\tthis._lifecycleService.stage = LifecycleStages.Steady;\n\t\t\t\t\t}, STEADY_TIMEOUT);',
  '\t\t\t\t\tthis._cancelSteadyInit = schedulePostPaint(() => {\n\t\t\t\t\t\tthis._lifecycleService.stage = LifecycleStages.Steady;\n\t\t\t\t\t});')
 // Both normal dispose and bootstrap failure must cancel queued frame/tasks.
 const cancel='clearTimeout(this._steadyTimeout);'
 if(source.split(cancel).length!==3)throw Error('Pinned Univer Steady cancellation points changed')
 source=source.replaceAll(cancel,cancel+'this._cancelSteadyInit?.();')
 const cancelRender='clearTimeout(this._renderTimeout);'
 if(source.split(cancelRender).length!==3)throw Error('Pinned Univer render cancellation points changed')
 source=source.replaceAll(cancelRender,cancelRender+'this._cancelRenderInit?.();')
 return `import {schedulePostPaint} from ${JSON.stringify(fileURLToPath(new URL('../post-paint.ts',import.meta.url)))};\n`+source
}

export function adaptFormulaStreamHold(source){
 source=replaceOnce(source,"import { CustomCommandExecutionError, ICommandService } from '@univerjs/core'","import { CustomCommandExecutionError, ICommandService, LifecycleStages } from '@univerjs/core'")
 source=replaceOnce(source,'schedule: (() => void) | null','schedule: ((delay?: number) => void) | null')
 // This existing request is issued only after all initial formula data is loaded.
 source=replaceOnce(source,'  current.schedule?.()','  current.schedule?.(0)')
 source=replaceOnce(source,'if (holding() || state.inProgress)', 'if (runtime.univerAPI.getCurrentLifecycleStage() < LifecycleStages.Rendered || (!state.fullRecalc && holding()) || state.inProgress)')
 source=replaceOnce(source,'const schedule = () => {','const schedule = (delay = FORMULA_STREAM_HOLD_MS + 20) => {')
 source=replaceOnce(source,'setTimeout(flush, FORMULA_STREAM_HOLD_MS + 20)','setTimeout(flush, delay)')
 // Only the explicit complete-preload release uses a microtask. It runs after
 // synchronous Rendered subscribers, without waiting behind another task/paint.
 source=replaceOnce(source,'  const flush = () => {','  let disposed = false, flushQueued = false\n  const flush = () => {\n    if (disposed) return')
 source=replaceOnce(source,'    if (state.timer) clearTimeout(state.timer)\n    state.timer = setTimeout(flush, delay)',
  `    if (disposed) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    if (flushQueued) return
    if (delay === 0) {
      flushQueued = true
      performance.mark('office-xlsx:initial-calculation-queued')
      queueMicrotask(() => {
        flushQueued = false
        if (disposed) return
        performance.mark('office-xlsx:initial-calculation-flush')
        flush()
      })
    } else state.timer = setTimeout(flush, delay)`)

 source=replaceOnce(source,'  state.schedule = schedule',`  state.schedule = schedule
  const lifecycle = runtime.univerAPI.addEvent(runtime.univerAPI.Event.LifeCycleChanged, ({stage}) => {if(stage === LifecycleStages.Rendered && state.fullRecalc)schedule(0)})
  runtime.univer.onDispose(() => {
    disposed = true
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    lifecycle.dispose()
    states.delete(runtime)
    if (current === state) current = null
  })`)
 source=replaceOnce(source,"    if (command.id === STOP_MUTATION) state.inProgress = false", "    if (command.id === STOP_MUTATION) {state.inProgress = false;if(state.fullRecalc)schedule(0)}")
 source=replaceOnce(source,'    state.inProgress = params?.stageInfo != null','    state.inProgress = params?.stageInfo != null\n    if (!state.inProgress && state.fullRecalc) schedule(0)')
 source=replaceOnce(source,'    void commandService.executeCommand(', '    if (fullRecalc) window.__projectMindSheetsHost.initialCalculationStarting(runtime)\n    void commandService.executeCommand(')
 return source
}

export function adaptPreloadCompletion(source){
 return replaceOnce(source,'if (state.formulaMode && !isManualCalculation(runtime)) requestFullRecalcAfterStream()',
  'if (state.formulaMode && !isManualCalculation(runtime)) {window.__projectMindSheetsHost.initialCalculationRequested(state,runtime);requestFullRecalcAfterStream()}')
}

export function adaptLoadedVisualScroll(source){
 // All visuals of the active sheet are installed together. Univer's float DOM
 // manager already repositions them on scroll/resize; reinstalling destroys
 // asynchronously loaded image/chart components. Keep streaming installs.
 return replaceOnce(source,'        visualViewportKeyRef.current = viewportKey',
  '        visualViewportKeyRef.current = viewportKey\n        if (lazyWorkbookRef.current?.flags.preloadComplete) return')
}
