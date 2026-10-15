import type { DocxModel, Edit } from './types';
export interface EditorOptions {
  model: DocxModel;
  edits: Edit[];
  onChange(edits: Edit[]): void;
  readOnly?: boolean;
  onError?(message: string): void;
}
export interface EditorController {
  update(options: EditorOptions): void;
  destroy(): void;
  undo(): void;
  redo(): void;
}
export declare function mountEditor(element: HTMLElement, options: EditorOptions): EditorController;
