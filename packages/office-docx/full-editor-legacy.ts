import {rendererHtml} from './dist/renderer-resource.mjs';
import {mountFullEditorSource} from './full-editor-host';
import type {EditorController,EditorOptions} from './editor-types';
/** Preserve the self-contained legacy editor entry. Products use full-editor.mjs. */
export function mountFullEditor(element:HTMLElement,options:EditorOptions):EditorController{
  return mountFullEditorSource(element,options,{html:rendererHtml});
}
