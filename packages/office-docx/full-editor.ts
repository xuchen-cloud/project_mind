import {mountFullEditorSource} from './full-editor-host';
import type {EditorController,EditorOptions} from './editor-types';
/** Same-origin static renderer; host options are installed before navigation. */
export function mountFullEditor(element:HTMLElement,options:EditorOptions,rendererUrl?:string|URL):EditorController{
  // Keep this dynamic in the built host: app bundlers must not emit a second,
  // isolated HTML asset when the app supplies its staged renderer URL.
  const rendererPath='./renderer.html';
  const url=new URL(String(rendererUrl??new URL(rendererPath,import.meta.url)),element.ownerDocument.baseURI);
  if(url.origin!==element.ownerDocument.location.origin)throw Error('Word renderer 必须与 File 宿主同源。');
  return mountFullEditorSource(element,options,{url:url.href});
}
