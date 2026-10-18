import { EditorLoading } from "../document/EditorLoading"
import { useEffect, useRef, useState } from 'react'
import type { EditorProps, MountedEditor } from '../../../packages/office-xlsx/types'
import '../../../packages/office-xlsx/dist/browser.css'
import type {RegisterEditorOutput} from '../../lib/editor-output'

export type { Model, Edit } from '../../../packages/office-xlsx/types'
export type XlsxEditorProps = EditorProps & {
  registerOutput?: RegisterEditorOutput
  registerBeforeSave?: (callback: () => Promise<void>) => () => void
}

/** Host owns the draft and persistence. New model means a committed baseline. */
export function XlsxEditor(props: XlsxEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<MountedEditor | null>(null)
  const mounting = useRef<Promise<MountedEditor> | null>(null)
  const latest = useRef(props)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<'runtime' | 'render' | null>('runtime')
  const loadingReady = useRef<Promise<void> | null>(null)
  function observeReady(mounted: MountedEditor) {
    const ready = mounted.ready
    if (loadingReady.current === ready) return
    loadingReady.current = ready
    setLoading('render')
    const current = () => editor.current === mounted && mounted.ready === ready
    void ready.then(() => { if (current()) setLoading(null) }, cause => { if (current()) setError(cause instanceof Error ? cause.message : String(cause)) })
  }
  latest.current = props
  useEffect(() => {
    let disposed = false
    mounting.current = import('../../../packages/office-xlsx/dist/browser.mjs').then(({ mount }) => {
      if (disposed || !host.current) throw new Error('Excel 编辑器已关闭')
      const mounted = editor.current = mount(host.current, latest.current)
      observeReady(mounted)
      return mounted
    })
    void mounting.current.catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { disposed = true; editor.current?.dispose(); editor.current = null }
  }, [])
  useEffect(() => {
    const node=host.current; const failed=(event:Event)=>setError(String((event as CustomEvent).detail)); node?.addEventListener('office-error',failed); return()=>node?.removeEventListener('office-error',failed)
  }, [])
  useEffect(() => props.registerBeforeSave?.(async () => {
    const mounted = await mounting.current
    if (!mounted) throw new Error('Excel 编辑器尚未加载')
    await mounted.commitEditing()
  }), [props.registerBeforeSave])
  useEffect(() => props.registerOutput?.(async command => {
    if (!['pdf','csv','print'].includes(command)) throw new Error('Excel 不支持此输出格式')
    const mounted=await mounting.current
    if (!mounted) throw new Error('Excel 编辑器尚未加载')
    await mounted.output(command as 'pdf'|'csv'|'print')
  }), [props.registerOutput])
  useEffect(() => {
    try { editor.current?.update(props); if (editor.current) observeReady(editor.current) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [props.model, props.edits, props.onChange, props.readOnly, props.presentationMode, props.onPendingChange, props.onSaveRequest, props.onExport, props.onPrint, props.onRenderPdf, props.onRecalculate, props.onInspectImportedWorkbook, props.onCaptureScreenSources, props.onCaptureScreenSource])
  return <div className="editor-loading-boundary office-xlsx-editor h-full min-h-0 w-full" aria-label="Excel 工作表">
    <div ref={host} className="h-full min-h-0 w-full" />
    {error && <div role="alert" className="office-xlsx-status">{error}</div>}
    {loading && !error ? <EditorLoading format="xlsx" stage={loading} overlay /> : null}
  </div>
}
