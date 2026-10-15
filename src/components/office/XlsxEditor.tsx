import { useEffect, useRef, useState } from 'react'
import type { EditorProps, MountedEditor } from '../../../packages/office-xlsx/types'
import '../../../packages/office-xlsx/dist/browser.css'

export type { Model, Edit } from '../../../packages/office-xlsx/types'
export type XlsxEditorProps = EditorProps & {
  registerBeforeSave?: (callback: () => Promise<void>) => () => void
}

/** Host owns the draft and persistence. New model means a committed baseline. */
export function XlsxEditor(props: XlsxEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<MountedEditor | null>(null)
  const mounting = useRef<Promise<MountedEditor> | null>(null)
  const latest = useRef(props)
  const [error, setError] = useState<string | null>(null)
  latest.current = props
  useEffect(() => {
    let disposed = false
    mounting.current = import('../../../packages/office-xlsx/dist/browser.mjs').then(({ mount }) => {
      if (disposed || !host.current) throw new Error('Excel 编辑器已关闭')
      return editor.current = mount(host.current, latest.current)
    })
    void mounting.current.catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { disposed = true; editor.current?.dispose(); editor.current = null }
  }, [])
  useEffect(() => props.registerBeforeSave?.(async () => {
    const mounted = await mounting.current
    if (!mounted) throw new Error('Excel 编辑器尚未加载')
    await mounted.commitEditing()
  }), [props.registerBeforeSave])
  useEffect(() => {
    try { editor.current?.update(props) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [props.model, props.edits, props.onChange, props.readOnly, props.onPendingChange])
  return <div ref={host} className="office-xlsx-editor h-full min-h-0 w-full" aria-label="Excel 工作表">
    {error && <div role="alert" className="office-xlsx-status">{error}</div>}
  </div>
}
