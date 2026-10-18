import {onHostMessage,sendHostMessage} from './renderer-channel'
/** Real export/print requests to the File host; no filesystem or relay access. */
import {PDFDocument} from 'pdf-lib'
import type {ExportFile,PrintDocument,RecalculateRequest,RecalculateResult,Model,ScreenSourcesResult,ScreenCaptureRequest,ScreenCaptureResult} from './types'
let nextId=0
const requests=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>()
onHostMessage(data=>{
 if(!['exportReply','printReply','calculateReply','renderPdfReply','inspectImportedReply','captureSourcesReply','captureSourceReply'].includes(data.type))return
 const request=requests.get(data.id);if(!request)return;requests.delete(data.id)
 data.value?.error?request.reject(Error(data.value.error)):request.resolve(data.value?.result)
})
function request(type:string,value?:ExportFile|PrintDocument|RecalculateRequest|Uint8Array|ScreenCaptureRequest){const id=++nextId;return new Promise<unknown>((resolve,reject)=>{requests.set(id,{resolve,reject});sendHostMessage({officeXlsx:true,type,value,id})})}
export async function exportFile(file:ExportFile){const written=await request('exportRequest',file);if(typeof written!=='boolean')throw Error('导出宿主未返回写入或取消结果');return written}
export async function recalculateWorkbook(input:RecalculateRequest){return await request('calculateRequest',input) as RecalculateResult}
export async function inspectImportedWorkbook(bytes:Uint8Array){return await request('inspectImportedRequest',bytes) as Model}
export async function captureScreenSources(){return await request('captureSourcesRequest') as ScreenSourcesResult}
export async function captureScreenSource(input:ScreenCaptureRequest){return await request('captureSourceRequest',input) as ScreenCaptureResult|null}
export async function renderPdfDocument(document:PrintDocument){
 const bytes=await request('renderPdfRequest',document)
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>64*1024*1024||!new TextDecoder().decode(bytes.subarray(0,8)).startsWith('%PDF-')||!new TextDecoder().decode(bytes.subarray(-1024)).includes('%%EOF'))throw Error('宿主未返回有效 PDF 字节')
 return bytes
}
export async function printDocument(document:PrintDocument){await request('printRequest',document)}

/** The upstream Electron loss-warning is a DOM dialog here, so WKWebView needs no JS UIDelegate. */
export function confirmCsvExport(hasFormulas:boolean,sheetName?:string):Promise<boolean>{
 if(!hasFormulas&&!sheetName)return Promise.resolve(true)
 return new Promise(resolve=>{
  const dialog=document.createElement('dialog');dialog.className='office-output-dialog';dialog.setAttribute('aria-label','导出 CSV')
  const heading=document.createElement('h2');heading.textContent='导出 CSV'
  const note=document.createElement('p');note.textContent=[sheetName?`CSV 仅包含当前工作表“${sheetName}”。`:'',hasFormulas?'公式将转换为当前结果。':'','CSV 不包含格式、图片、图表等工作簿内容。原 XLSX 保持可编辑。'].join('')
  const actions=document.createElement('div');actions.className='dialog-actions';const cancel=document.createElement('button'),proceed=document.createElement('button');cancel.textContent='取消';proceed.textContent='继续导出'
  const finish=(accepted:boolean)=>{dialog.close();dialog.remove();resolve(accepted)};cancel.onclick=()=>finish(false);proceed.onclick=()=>finish(true);dialog.oncancel=event=>{event.preventDefault();finish(false)}
  actions.append(cancel,proceed);dialog.append(heading,note,actions);document.body.append(dialog);dialog.showModal()
 })
}

/** Copy only print content and embedded resources; never the editor's App controls. */
export async function embeddedPrintHtml(html:string,copies=1,collate=true):Promise<string>{
 const output=new DOMParser().parseFromString(html,'text/html')
 if(output.querySelector('script,iframe,object,embed,form,input,textarea,select,button'))throw Error('打印文档含交互控件，未提交打印')
 const fonts=document.createElement('style');fonts.textContent=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules].filter(rule=>rule.type===CSSRule.FONT_FACE_RULE).map(rule=>rule.cssText)).join('\n');output.head.append(fonts)
 // Source images are data URLs; blob snapshots can be materialized without network access.
 for(const image of output.querySelectorAll('img[src],svg image[href],svg image[xlink\\:href]')){
  const attr=image.hasAttribute('src')?'src':image.hasAttribute('href')?'href':'xlink:href',src=image.getAttribute(attr)!
  if(src.startsWith('blob:')){const blob=await(await fetch(src)).blob();const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob)});image.setAttribute(attr,data)}
  else if(!src.startsWith('data:image/'))throw Error(`打印图片尚未内嵌：${src.slice(0,120)}`)
 }
 for(const style of output.querySelectorAll('style,[style]')){
  const css=style.tagName==='STYLE'?style.textContent??'':style.getAttribute('style')??''
  if(/@import\b/i.test(css))throw Error('打印样式含外部导入，未提交打印')
  for(const url of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))if(!/^(?:data:(?:image|font|application\/font)[/;]|#)/i.test(url[2]!))throw Error(`打印资源尚未内嵌：${url[2]!.slice(0,120)}`)
 }
 const pages=[...output.body.querySelectorAll(':scope > .page')]
 if(copies>1){output.body.replaceChildren();const append=(page:Element)=>output.body.append(page.cloneNode(true));if(collate)for(let n=0;n<copies;n++)pages.forEach(append);else for(const page of pages)for(let n=0;n<copies;n++)append(page)}
 const result='<!doctype html>'+output.documentElement.outerHTML
 if(result.length>20_000_000)throw Error('打印文档超过 20 MB HTML 预算')
 return result
}

/** The official paginator puts oriented paper dimensions on every page. Keep consecutive groups in order. */
export async function embeddedPrintDocuments(html:string,title?:string,copies=1,collate=true):Promise<PrintDocument[]>{
 const output=new DOMParser().parseFromString(await embeddedPrintHtml(html,copies,collate),'text/html')
 const groups:{pageSize:{widthPt:number;heightPt:number};pages:Element[]}[]=[]
 const pt=(length:string)=>{const match=/^([\d.]+)(in|mm|px|pt)$/.exec(length);if(!match)throw Error('官方打印页面缺少纸张尺寸');const value=Number(match[1])*({in:72,mm:72/25.4,px:0.75,pt:1}[match[2]!]!);if(!Number.isFinite(value)||value<=0)throw Error('无效打印纸张尺寸');return Math.round(value*10000)/10000}
 for(const page of output.body.querySelectorAll<HTMLElement>(':scope > .page')){const pageSize={widthPt:pt(page.style.width),heightPt:pt(page.style.height)},last=groups.at(-1);if(last&&last.pageSize.widthPt===pageSize.widthPt&&last.pageSize.heightPt===pageSize.heightPt)last.pages.push(page);else groups.push({pageSize,pages:[page]})}
 if(!groups.length)throw Error('官方打印文档没有页面')
 return groups.map(group=>{const copy=output.documentElement.cloneNode(true) as HTMLElement;copy.querySelector('body')!.replaceChildren(...group.pages.map(page=>page.cloneNode(true)));return{html:'<!doctype html>'+copy.outerHTML,...(title?{title}:{}),pageSize:group.pageSize}})
}

/** Native PDF jobs have one paper geometry; combine differently sized groups without reordering. */
export async function renderPdfDocuments(documents:PrintDocument[]):Promise<Uint8Array>{
 const results:Uint8Array[]=[];for(const document of documents)results.push(await renderPdfDocument(document))
 if(results.length===1)return results[0]!
 const combined=await PDFDocument.create();for(const bytes of results){const part=await PDFDocument.load(bytes);for(const page of await combined.copyPages(part,part.getPageIndices()))combined.addPage(page)}
 const bytes=await combined.save();if(bytes.byteLength>64*1024*1024)throw Error('PDF 超过 64 MiB 导出预算');return bytes
}
