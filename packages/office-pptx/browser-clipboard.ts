/** Browser clipboard permissions stay with the webview; no filesystem relay. */
type Internal={kind:'internal'|'slide'|'none'};
const marker=(token:string)=>`<!--project-mind-pptx:${token}-->`;
let token='',kind:Internal['kind']='none';
export async function markClipboard(next:'internal'|'slide',png?:string){
 token=crypto.randomUUID();kind=next;
 if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')return false;
 const data:Record<string,Blob>={'text/html':new Blob([marker(token)],{type:'text/html'})};
 if(png)data['image/png']=new Blob([new Uint8Array(Buffer.from(png,'base64'))],{type:'image/png'});
 try{await navigator.clipboard.write([new ClipboardItem(data)]);return true}catch{return false}
}
export async function readClipboard(internal:Internal):Promise<any>{
 if(!navigator.clipboard?.read){if(internal.kind!=='none')return internal;throw new Error('当前浏览器不提供系统剪贴板读取，请使用文本编辑框的系统粘贴');}
 try{
  const items=await navigator.clipboard.read();
  for(const item of items)if(item.types.includes('text/html')&&(await(await item.getType('text/html')).text()).includes(marker(token))&&token&&internal.kind===kind)return internal;
  for(const item of items){const mime=item.types.find(t=>/^image\/(png|jpeg|gif|webp)$/.test(t));if(mime){const bytes=await(await item.getType(mime)).arrayBuffer();return {kind:'image',base64:Buffer.from(bytes).toString('base64'),ext:mime.split('/')[1]}}}
  for(const item of items)if(item.types.includes('text/plain')){const text=await(await item.getType('text/plain')).text();if(text.trim())return {kind:'text',text}}
  return internal.kind==='none'?{kind:'none'}:internal;
 }catch(e){if(internal.kind!=='none')return internal;throw new Error(`无法读取系统剪贴板：${e instanceof Error?e.message:String(e)}`)}
}
export async function nativeClipboard(op:'copy'|'cut'|'paste',assertCurrent:()=>void=()=>{}){
 if(op==='copy'||op==='cut'){if(!document.execCommand(op))throw new Error('浏览器未授权剪贴板写入，请使用系统复制/剪切快捷键');return}
 if(!navigator.clipboard?.readText)throw new Error('当前浏览器不提供剪贴板读取，请使用系统粘贴快捷键');
 const text=await navigator.clipboard.readText();assertCurrent();const el=document.activeElement;
 if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){el.setRangeText(text,el.selectionStart??0,el.selectionEnd??0,'end');el.dispatchEvent(new Event('input',{bubbles:true}));return}
 if(!(el instanceof HTMLElement)||!el.isContentEditable||!document.execCommand('insertText',false,text))throw new Error('请先将光标放入文字编辑框');
}
