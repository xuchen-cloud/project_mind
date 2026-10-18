import type { EditorProps, MountedEditor } from './types'
export type { Model, Edit, EditorProps, MountedEditor, OutputCommand, ExportFile, PrintDocument, ScreenSourcesResult, ScreenCaptureRequest, ScreenCaptureResult } from './types'
export declare function mount(container: HTMLElement, props: EditorProps, rendererUrl?: string): MountedEditor
export declare const mountEditor: typeof mount
