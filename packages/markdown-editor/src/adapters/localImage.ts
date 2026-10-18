// Adapted from fixed GenOffice localImage.ts; original attribute serialization retained.
import type { JSONContent } from '@tiptap/core';
import { Image, type ImageOptions } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { firstImage, MARKDOWN_IMAGE_LIMIT } from './imageInput';
import { getErrorMessage } from '../../../../src/lib/errors';
export function safeImage(src:string):boolean { return /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/iu.test(src); }
export const LocalImage = Image.extend<ImageOptions & {resolve:(src:string)=>string; onError:(message:string)=>void;onPending:(pending:boolean)=>void}>({
  addOptions(){return {...this.parent!(), inline:true,allowBase64:true,resolve:()=>'',onError:()=>{},onPending:()=>{}};},
  addAttributes(){
    return {...this.parent?.(), src:{ default:null,
      parseHTML:(element:HTMLElement)=>element.getAttribute('data-markdown-src')??element.getAttribute('src'),
      renderHTML:(attrs:Record<string,unknown>)=>{const source=String(attrs.src??'');return {'data-markdown-src':source,src:this.options.resolve(source)||undefined};},
    }};
  },
  renderMarkdown:(node)=>{
    const image=imageMarkdown(node.attrs);const link=node.marks?.find(mark=>mark.type==='link');
    return link?`[${image}](${String(link.attrs?.href??'')})`:image;
  },
  addProseMirrorPlugins(){
    const editor=this.editor; const options=this.options;
    const readers=new Set<FileReader>();
    const insert=(files:FileList|null|undefined,pos:number)=>{
      const file=firstImage(files);
      if(!file||!editor.isEditable)return false;
      if(file.size>MARKDOWN_IMAGE_LIMIT){options.onError('图片超过 4 MiB，请使用已纳管资源的路径。');return true;}
      let anchor=pos;let canceled=false;let finished=false;
      const reader=new FileReader();readers.add(reader);options.onPending(true);
      const finish=()=>{if(finished)return;finished=true;editor.off('transaction',map);readers.delete(reader);options.onPending(readers.size>0);};
      // User edits map the insertion point; an external setContent cancels this old input.
      const map=({transaction}:{transaction:import('@tiptap/pm/state').Transaction})=>{
        if(transaction.getMeta('preventUpdate')){canceled=true;reader.abort();finish();return;}
        anchor=transaction.mapping.map(anchor);
      };
      editor.on('transaction',map);
      reader.onload=()=>{
        const isCurrent=()=>!canceled&&!editor.isDestroyed&&editor.isEditable;
        try{
          if(isCurrent())editor.chain().focus().insertContentAt(anchor,{type:'image',attrs:{src:String(reader.result),alt:file.name}}).run();
        }catch(reason){if(isCurrent())options.onError(`图片未插入：${getErrorMessage(reason)}`);}finally{finish();}
      };
      reader.onerror=()=>{finish();options.onError('读取图片失败。');};reader.onabort=finish;
      reader.readAsDataURL(file);return true;
    };
    return [new Plugin({key:new PluginKey('markdownImagePaste'),view:()=>({destroy(){for(const reader of readers)reader.abort();}}),props:{
      handlePaste:(view,event)=>insert(event.clipboardData?.files,view.state.selection.from),
      handleDrop:(view,event,_slice,moved)=>!moved&&insert(event.dataTransfer?.files,view.posAtCoords({left:event.clientX,top:event.clientY})?.pos??view.state.selection.from),
    }})];
  },
});
const attr = (value: unknown) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

function imageMarkdown(attrs: JSONContent['attrs']): string {
  const src = String(attrs?.src ?? '')
  const alt = String(attrs?.alt ?? '')
  const title = String(attrs?.title ?? '')
  const escapedAlt = alt.replace(/[\\[\]]/g, '\\$&')
  const destination = /[\s()<>\\"]/u.test(src) ? `<${src.replace(/[\\<>]/g, '\\$&')}>` : src
  const titleText = title ? ` ${JSON.stringify(title)}` : ''
  // markdown has no image size syntax; a sized picture keeps its HTML form
  if (attrs?.width != null || attrs?.height != null) {
    const parts = [`src="${attr(src)}"`]
    if (alt) parts.push(`alt="${attr(alt)}"`)
    if (title) parts.push(`title="${attr(title)}"`)
    if (attrs.width != null) parts.push(`width="${attr(attrs.width)}"`)
    if (attrs.height != null) parts.push(`height="${attr(attrs.height)}"`)
    return `<img ${parts.join(' ')} />`
  }
  return `![${escapedAlt}](${destination}${titleText})`
}

function markImages(
  content: JSONContent[],
  mark: { type: string; attrs: JSONContent['attrs'] },
): JSONContent[] {
  return content.map((node) => {
    if (node.type === 'image') return { ...node, marks: [...(node.marks ?? []), mark] }
    if (node.content) return { ...node, content: markImages(node.content, mark) }
    return node
  })
}

/** Link whose markdown parse also marks the images it wraps (the manager only marks text) */
export const ImageAwareLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    const attrs = { href: token.href, title: token.title || null }
    const content = markImages(helpers.parseInline(token.tokens || []), { type: 'link', attrs })
    return helpers.applyMark('link', content, attrs)
  },
})

/** Paragraph whose markdown parse keeps a lone image inside it (the stock one lifts it out as a block) */
export const ImageParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const parsed = Paragraph.config.parseMarkdown!(token, helpers)
    return Array.isArray(parsed) ? helpers.createNode('paragraph', undefined, parsed) : parsed
  },
})
