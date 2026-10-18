import {PDFDocument} from 'pdf-lib';
import JSZip from 'jszip';
import {buildPrintDocument} from './renderer-print';
type OutputOptions={
  onRenderPdf?:(document:{html:string;title?:string;pageSize?:{widthPt:number;heightPt:number}})=>Promise<Uint8Array>;
  onExport?:(file:{name:string;mime:string;bytes:Uint8Array})=>Promise<boolean>;
};
/** Upstream group/chunk orchestration stays in file-actions. These tokens are
 * renderer memory only: no paths or directory authority cross the native seam. */
export function createPdfBridge(options:()=>OutputOptions){
  let images:null|{token:string;pdf?:Uint8Array;zip:JSZip;name:string}=null;
  const fromBase64=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const toBase64=(bytes:Uint8Array)=>{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value);};
  const nameFor=(name:string,extension:string)=>name.replace(/\.docx$/i,'').replace(new RegExp(`\\.${extension}$`,'i'),'')+'.'+extension;
  async function save(name:string,mime:string,bytes:Uint8Array,outPath?:string){
    if(outPath){
      if(!images||outPath!==images.token)throw Error('Word 导出不接受原生路径；请使用宿主保存对话框。');
      images.pdf=bytes;return{ok:true,path:outPath};
    }
    const callback=options().onExport;
    if(callback){const ok=await callback({name,mime,bytes});return{ok,...(ok?{path:name}:{})};}
    const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime})),a=document.createElement('a');
    a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);return{ok:true,path:name};
  }
  async function render(title:string,widthTwips:number,heightTwips:number){
    const callback=options().onRenderPdf;
    if(!callback)throw Error('当前宿主尚未连接原生 PDF 渲染。');
    if(!Number.isFinite(widthTwips)||!Number.isFinite(heightTwips)||widthTwips<=0||heightTwips<=0)throw Error('PDF 分组纸张尺寸无效。');
    const document=await buildPrintDocument(title);
    document.pageSize={widthPt:widthTwips/20,heightPt:heightTwips/20};
    const bytes=new Uint8Array(await callback(document));
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw Error('原生渲染未返回 PDF 字节。');
    await PDFDocument.load(bytes);return bytes;
  }
  const failed=(error:unknown)=>({ok:false,error:error instanceof Error?error.message:String(error)});
  return{
    async exportPdf(name:string,width:number,height:number,outPath?:string,_scale?:number){
      try{return await save(nameFor(name,'pdf'),'application/pdf',await render(name,width,height),outPath);}catch(error){return failed(error);}
    },
    async printPdfBuffer(width:number,height:number,_scale?:number){
      try{return{ok:true,base64:toBase64(await render('Word',width,height))};}catch(error){return failed(error);}
    },
    async saveMergedPdf(name:string,parts:string[],outPath?:string){
      try{
        const merged=await PDFDocument.create();
        for(const part of parts){const source=await PDFDocument.load(fromBase64(part));for(const page of await merged.copyPages(source,source.getPageIndices()))merged.addPage(page);}
        return await save(nameFor(name,'pdf'),'application/pdf',await merged.save(),outPath);
      }catch(error){return failed(error);}
    },
    startImages(name:string){
      if(images)throw Error('图片导出仍在进行中。');
      const token=`word-pages:${crypto.randomUUID()}`;images={token,zip:new JSZip(),name:nameFor(name,'zip')};return{dir:token,pdfPath:token};
    },
    async takeExportPdf(token:string){
      if(!images||token!==images.token||!images.pdf)return failed('图片导出的 PDF 字节不存在。');
      const bytes=images.pdf;images.pdf=undefined;return{ok:true,base64:toBase64(bytes)};
    },
    async writeExportImage(token:string,name:string,base64:string){
      if(!images||token!==images.token||/[\\/]/.test(name)||!name.endsWith('.png'))return failed('图片导出会话或文件名无效。');
      images.zip.file(name,fromBase64(base64));return{ok:true};
    },
    async finishImages(){
      if(!images)throw Error('图片导出会话已关闭。');
      const {name,zip}=images;const bytes=await zip.generateAsync({type:'uint8array',compression:'STORE'});
      return(await save(name,'application/zip',bytes)).ok;
    },
    cancelImages(){images=null;},
  };
}
