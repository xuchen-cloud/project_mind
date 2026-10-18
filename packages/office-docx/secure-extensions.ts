import {Extension,Node as TiptapNode} from '@tiptap/core';
import {Plugin} from '@tiptap/pm/state';
function inertAnchors(root:globalThis.Node){
 if(root.nodeType!==1)return;const el=root as Element;
 for(const anchor of [...(el.matches('a')?[el]:[]),...el.querySelectorAll('a')]){
  const title=anchor.getAttribute('title')??anchor.getAttribute('href')??anchor.getAttribute('xlink:href')??'';
  for(const name of anchor.getAttributeNames())if(!['class','style','data-style','title','role'].includes(name))anchor.removeAttribute(name);
  if(anchor.getAttribute('title')!==title)anchor.setAttribute('title',title);
  if(anchor.getAttribute('role')!=='link')anchor.setAttribute('role','link');
 }
}
/** Source relationships never acquire navigation rights inside the File editor. */
export function secureExtensions(extensions:any[]){
 const safe=extensions.map(extension=>{
  if(extension.name==='link')return extension.extend({renderHTML({mark}:any){return ['a',{role:'link',class:mark.attrs.plain?'doc-link doc-link-plain':'doc-link',title:mark.attrs.tooltip||mark.attrs.href||''},0];}});
  if(!(extension instanceof TiptapNode)||!extension.config.addNodeView)return extension;
  return extension.extend({addNodeView(){const create=this.parent?.();if(!create)return null;return(props:any)=>{
   const view=create(props);inertAnchors(view.dom);const update=view.update;
   if(update)view.update=(...args:any[])=>{const result=update.apply(view,args);inertAnchors(view.dom);return result;};return view;
  };}});
 });
 safe.push(Extension.create({name:'projectMindPrivilegedFileBoundary',priority:10000,addProseMirrorPlugins:()=>[new Plugin({
  props:{editable:()=>!(globalThis as any).window?.__projectMindDocxHost?.locked},
  filterTransaction(tr){return !tr.docChanged||!(globalThis as any).window?.__projectMindDocxHost?.readOnly;},
  view(view){inertAnchors(view.dom);const unregister=(window as any).__projectMindDocxHost?.registerEditorView(view);const observer=new MutationObserver(()=>inertAnchors(view.dom));observer.observe(view.dom,{subtree:true,childList:true,attributes:true});return{update:next=>inertAnchors(next.dom),destroy:()=>{observer.disconnect();unregister?.();}};},
 })]}));return safe;
}
