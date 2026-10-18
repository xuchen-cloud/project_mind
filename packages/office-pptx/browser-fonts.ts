/** User-selected font bytes stay in this webview's font store; business files remain native. */
import {readFaceDir,extractFace} from './parity-fonts.mjs';
import {createBrowserFontMetrics} from './browser-font-metrics';
type Face={id:string;family:string;bold:boolean;italic:boolean;data:ArrayBuffer};
const faces=new Map<string,Face>();
const measured=createBrowserFontMetrics();
export const browserFontMetrics=measured.provider;
async function prepareFace(face:Face){
 validateFont(Buffer.from(face.data));
 const commitMetrics=measured.prepare(face,face.data);
 const font=new FontFace(face.family,face.data,{weight:face.bold?'700':'400',style:face.italic?'italic':'normal'});
 await font.load();
 return ()=>{commitMetrics();document.fonts.add(font);faces.set(face.id,face)};
}
const database=new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('project-mind-pptx-fonts',1);req.onupgradeneeded=()=>req.result.createObjectStore('faces',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
export const fontsReady=database.then(db=>new Promise<void>((resolve,reject)=>{const req=db.transaction('faces').objectStore('faces').getAll();req.onsuccess=()=>{void Promise.all(req.result.map((face:Face)=>prepareFace(face))).then(commits=>{commits.forEach(commit=>commit());resolve()},reject)};req.onerror=()=>reject(req.error)}));
let fontWork:Promise<unknown>=fontsReady;
export async function waitForFonts(){await fontsReady;let work:Promise<unknown>;do{work=fontWork;await work}while(work!==fontWork);await document.fonts.ready}
export async function fontCatalog(){await fontsReady;return [...new Set([...faces.values()].map(f=>f.family))].map(family=>({family,script:'latin',installed:true,license:'user-provided',bytes:[...faces.values()].filter(f=>f.family===family).reduce((n,f)=>n+f.data.byteLength,0)}))}
export async function privateFontFaces(){await fontsReady;return [...faces.values()].map(({data,...face})=>face)}
export async function privateFontData(id:string){await fontsReady;return faces.get(id)?.data??null}
function validateFont(bytes:Buffer){
 if(bytes.length<12)throw new Error('字体文件头不完整');
 const collection=bytes.toString('ascii',0,4)==='ttcf',count=collection?bytes.readUInt32BE(8):1;
 if(count<1||count>256||collection&&12+4*count>bytes.length)throw new Error('字体集合超出可用范围');
 const offsets=collection?Array.from({length:count},(_,i)=>bytes.readUInt32BE(12+4*i)):[0];let expanded=0;
 for(const offset of offsets){if(offset+12>bytes.length)throw new Error('字体目录不完整');const n=bytes.readUInt16BE(offset+4);if(n<1||n>512||offset+12+16*n>bytes.length)throw new Error('字体目录超出可用范围');let size=12+16*n;
  for(let t=0;t<n;t++){const pos=offset+12+16*t,start=bytes.readUInt32BE(pos+8),length=bytes.readUInt32BE(pos+12);if(start+length>bytes.length)throw new Error('字体表超出文件范围');size+=Math.ceil(length/4)*4}
  expanded+=size;if(expanded>100*1024*1024)throw new Error('展开字体超出 100 MiB');
 }
}
export function installLocalFonts(){
 const work=fontWork.then(()=>installPickedFonts());fontWork=work;
 const finished=()=>{if(fontWork===work)fontWork=fontsReady};void work.then(finished,finished);
 return work;
}
async function installPickedFonts(){
 const files=await new Promise<File[]>((resolve)=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='.ttf,.otf,.ttc,.otc';input.onchange=()=>{resolve([...input.files??[]]);input.remove()};input.oncancel=()=>{resolve([]);input.remove()};input.click()});
 if(!files.length)return {families:[]};if(files.length>16||files.reduce((n,f)=>n+f.size,0)>100*1024*1024)throw new Error('一次最多安装 16 个、合计 100 MiB 的字体');
 await fontsReady;const installed:Face[]=[],commits:Array<()=>void>=[];
 for(const file of files){const bytes=Buffer.from(await file.arrayBuffer());if(!['00010000','4f54544f','74746366','74727565'].includes(bytes.subarray(0,4).toString('hex')))throw new Error(`无法识别字体：${file.name}`);
  validateFont(bytes);const dir=readFaceDir(bytes);if(!dir.length||dir.length>256)throw new Error('字体集合超出可用范围');
  for(const info of dir){if(!info.display)throw new Error(`字体缺少名称：${file.name}`);const data=extractFace(bytes,info.offset),bold=(info.weight??400)>=600,italic=/italic|oblique/.test(info.styleText),face={id:`${info.display}:${bold}:${italic}`,family:info.display,bold,italic,data};commits.push(await prepareFace(face));installed.push(face)}
 }
 const db=await database;await new Promise<void>((resolve,reject)=>{const tx=db.transaction('faces','readwrite');for(const f of installed)tx.objectStore('faces').put(f);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)});
 commits.forEach(commit=>commit());document.fonts.dispatchEvent(new Event('loadingdone'));return {families:[...new Set(installed.map(f=>f.family))]};
}
