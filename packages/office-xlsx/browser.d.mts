import type { EditorProps, MountedEditor } from './types'
export type { Model, Edit, EditorProps, MountedEditor, ExportFile, PrintDocument, ScreenSourcesResult, ScreenCaptureRequest, ScreenCaptureResult } from './types'
export declare function mount(container: HTMLElement, props: EditorProps): MountedEditor
export declare const mountEditor: typeof mount
