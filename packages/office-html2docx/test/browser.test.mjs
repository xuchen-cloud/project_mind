import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import * as installedPlaywright from 'playwright-core';
import JSZip from 'jszip';

const kind=process.env.OFFICE_BROWSER||'chromium';
if(!['chromium','webkit'].includes(kind))throw Error('OFFICE_BROWSER must be chromium or webkit');
const playwright=process.env.OFFICE_PLAYWRIGHT_MODULE?await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href):installedPlaywright;
const output=new URL(`output/${kind}/`,import.meta.url);
let browser,server,page,origin;
const externalRequests=[];
test.beforeEach(()=>{externalRequests.length=0;});
test.afterEach(()=>assert.deepEqual(externalRequests,[],'No conversion may attempt external network requests'));
test.before(async()=>{
 server=createServer(async(req,res)=>{
  if(req.url==='/index.mjs'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../dist/index.mjs',import.meta.url)));}
  else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module">import {convertAltChunkHtml} from "/index.mjs";window.convert=convertAltChunkHtml;</script>');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 await mkdir(output,{recursive:true});
 browser=await playwright[kind].launch({headless:true,...(kind==='chromium'?{channel:'chrome'}:process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{})});page=await browser.newPage();page.on('request',req=>{if(req.url().startsWith('http')&&!req.url().startsWith(origin))externalRequests.push(req.url());});
 if(process.env.OFFICE_BROWSER_DEBUG){page.on('console',message=>console.error(message.type(),message.text()));page.on('pageerror',error=>console.error(error));}
 await page.goto(origin);await page.waitForFunction(()=>window.convert);
 if(process.env.OFFICE_BROWSER_DEBUG)await page.evaluate(()=>{
  const original=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  Object.defineProperty(HTMLImageElement.prototype,'src',{...original,set(value){if(value.startsWith('data:image/svg+xml'))window.__lastRenderSvg=value;original.set.call(this,value);}});
 });
});
test.after(async()=>{
 if(browser)await writeFile(new URL('browser-environment.json',output),JSON.stringify({node:process.version,browser:kind,version:browser.version(),platform:process.platform,headless:true},null,2)+'\n');
 await browser?.close();await new Promise(r=>server?.close(r));
});

test('Chinese bold text, lists, tables and a real data image survive as DOCX OOXML',{timeout:30000},async()=>{
 const result=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,12,8);
  return Array.from(await window.convert(`<h1>中文标题</h1><p>正文<strong>粗体中文</strong></p><ul><li>第一条</li><li>第二条</li></ul><table><tr><th>列名</th><th>数量</th></tr><tr><td>苹果</td><td>12</td></tr></table><p><img width="12" height="8" src="${canvas.toDataURL()}"></p>`));
 });
 const zip=await JSZip.loadAsync(new Uint8Array(result));const xml=await zip.file('word/document.xml').async('string');
 for(const text of ['中文标题','正文','粗体中文','第一条','第二条','苹果','12'])assert.ok(xml.includes(text),text);
 assert.match(xml,/<w:b(?:\s|\/|>)/);assert.match(xml,/<w:tbl[ >]/);assert.match(xml,/<w:numPr>/);assert.match(xml,/<w:drawing>/);
 const images=Object.keys(zip.files).filter(name=>name.startsWith('word/media/')&&!zip.files[name].dir);assert.ok(images.length>0);
 const image=await zip.file(images[0]).async('uint8array');assert.deepEqual(Array.from(image.slice(0,8)),[137,80,78,71,13,10,26,10]);assert.ok(image.length>70);assert.ok((await pngPixels(image)).red>20,'data image must produce actual red pixels');
 await writeFile(new URL('converted.docx',output),new Uint8Array(result));
});

test('untrusted HTML cannot run scripts, events, navigation or external resource requests', {timeout:30000},async()=>{
 const external=[];const listener=req=>{if(!req.url().startsWith(origin)&&!req.url().startsWith('data:')&&!req.url().startsWith('about:'))external.push(req.url());};page.on('request',listener);
 try {
  const result=await page.evaluate(async()=>{
   const bytes=await window.convert(`<html><head><meta http-equiv="refresh" content="0;url=https://altchunk.invalid/navigate"><base href="https://altchunk.invalid/"><link rel="stylesheet" href="https://altchunk.invalid/x.css"><style>body{color:#222}</style></head><body onload="parent.__pwned=1"><script>parent.__pwned=1;fetch('https://altchunk.invalid/script');location='https://altchunk.invalid/script-nav'</script><svg onload="parent.__pwned=2"><image href="https://altchunk.invalid/svg"/></svg><iframe src="https://altchunk.invalid/frame"></iframe><object data="https://altchunk.invalid/object"></object><form action="https://altchunk.invalid/form"><input autofocus onfocus="parent.__pwned=3" value="安全输入"></form><a href="javascript:parent.__pwned=4">安全中文</a></body></html>`);
   return {bytes:Array.from(bytes),pwned:window.__pwned,frames:document.querySelectorAll('iframe[data-office-html2docx]').length,url:location.href};
  });
  const zip=await JSZip.loadAsync(new Uint8Array(result.bytes));assert.match(await zip.file('word/document.xml').async('string'),/安全中文/);
  assert.equal(result.pwned,undefined);assert.equal(result.frames,0);assert.equal(result.url,`${origin}/`);assert.deepEqual(external,[]);
 } finally {page.off('request',listener);}
});

test('cancellation rejects with AbortError and immediately destroys its iframe', {timeout:10000},async()=>{
 const result=await page.evaluate(async()=>{
  const controller=new AbortController();const promise=window.convert('<p>取消中文转换</p>',{signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,40));const active=document.querySelectorAll('iframe[data-office-html2docx]').length;controller.abort();
  try{await promise;return {unexpected:true};}catch(error){return {name:error.name,active,remaining:document.querySelectorAll('iframe[data-office-html2docx]').length};}
 });assert.deepEqual(result,{name:'AbortError',active:1,remaining:0});
 const pre=await page.evaluate(async()=>{const controller=new AbortController();controller.abort();try{await window.convert('<p>先取消</p>',{signal:controller.signal});}catch(error){return {name:error.name,remaining:document.querySelectorAll('iframe[data-office-html2docx]').length};}});
 assert.deepEqual(pre,{name:'AbortError',remaining:0});
});

test('only empty content returns null; broken, external and oversized images throw', {timeout:30000},async()=>{
 assert.equal(await page.evaluate(()=>window.convert('   <p></p>')),null);
 for(const html of ['<img src="https://altchunk.invalid/image.png">','<p>保留正文</p><img src="data:image/png;base64,YWJj">','<p>不可丢失图片</p><img width="5000" height="5000" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=">']){
  const result=await page.evaluate(async html=>{try{await window.convert(html);return {unexpected:true};}catch(error){return {message:error.message,remaining:document.querySelectorAll('iframe[data-office-html2docx]').length};}},html);
  assert.equal(result.unexpected,undefined);assert.match(result.message,/image|pixel|screenshot/i);assert.equal(result.remaining,0);
 }
});

test('safe external links and internal anchors remain real OOXML hyperlinks', {timeout:15000},async()=>{
 const result=await page.evaluate(async()=>Array.from(await window.convert('<p id="chapter">章节</p><p><a href="https://example.com/report?q=1">在线报告</a> <a href="mailto:reader@example.com">邮件</a> <a href="#chapter">返回章节</a> <a href="javascript:alert(1)">危险链接</a></p>')));
 const zip=await JSZip.loadAsync(new Uint8Array(result));const xml=await zip.file('word/document.xml').async('string'),rels=await zip.file('word/_rels/document.xml.rels').async('string');
 assert.match(xml,/<w:hyperlink /);assert.match(rels,/Target="https:\/\/example.com\/report\?q=1"/);assert.match(rels,/Target="mailto:reader@example.com"/);assert.match(xml,/<w:hyperlink\b[^>]*\bw:anchor="[^"]+"/);assert.doesNotMatch(rels,/javascript:/);
});

async function pngPixels(bytes){
 return page.evaluate(async bytes=>{
  const image=new Image();image.src='data:image/png;base64,'+btoa(String.fromCharCode(...bytes));await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let red=0,blue=0;
  for(let i=0;i<pixels.length;i+=4){if(pixels[i]>240&&pixels[i+1]<15&&pixels[i+2]<15&&pixels[i+3]>240)red++;if(pixels[i]<15&&pixels[i+1]<15&&pixels[i+2]>240&&pixels[i+3]>240)blue++;}
  return {width:canvas.width,height:canvas.height,red,blue};
 },Array.from(bytes));
}

test('CSS data background images render real pixels; unsupported CSS resources fail explicitly', {timeout:30000},async()=>{
 const bytes=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,4,4);
  const data=canvas.toDataURL();return Array.from(await window.convert(`<div style="width:120px;height:60px;background-image:url('${data}');background-size:100% 100%;border-radius:4px">背景中文</div>`));
 });
 const zip=await JSZip.loadAsync(new Uint8Array(bytes)),xml=await zip.file('word/document.xml').async('string');assert.match(xml,/<w:drawing>/);
 let red=0;for(const name of Object.keys(zip.files).filter(name=>/^word\/media\/.*\.png$/.test(name)))red+=(await pngPixels(await zip.file(name).async('uint8array'))).red;
 assert.ok(red>100,'CSS background must contain actual red pixels');
 for(const html of ['<p style="background-image:url(https://altchunk.invalid/background)">内容</p>','<p style="background-image:url(data:image/png;base64,YWJj)">内容</p>','<style>@import url(https://altchunk.invalid/style)</style><p>内容</p>','<p style="background-image:image-set(\'https://altchunk.invalid/a\' 1x)">内容</p>']){
  const result=await page.evaluate(async html=>{try{await window.convert(html);return 'unexpected success';}catch(error){return error.message;}},html);assert.match(result,/altChunk (?:CSS|image)|altChunk images|CSS imports/);
 }
});

test('PNG encoder failures propagate instead of producing a partially empty DOCX', {timeout:15000},async()=>{
 const result=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;canvas.getContext('2d').fillRect(0,0,8,8);const data=canvas.toDataURL();
  const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback){callback(null);};
  try{await window.convert(`<p>图片必须成功</p><img width="8" height="8" src="${data}">`);return 'unexpected success';}catch(error){return error.message;}finally{HTMLCanvasElement.prototype.toBlob=original;}
 });assert.match(result,/PNG encoding failed/);
});

test('page-coordinate screenshots preserve an overhanging badge and original card layout', {timeout:15000},async()=>{
 const bytes=await page.evaluate(async()=>Array.from(await window.convert('<div style="margin:60px;position:relative;width:120px;height:60px;background:blue;border-radius:4px"><div style="position:absolute;top:-12px;left:20px;width:80px;height:24px;background:red;border-radius:4px">特别徽标</div>卡片中文</div>')));
 if(process.env.OFFICE_BROWSER_DEBUG){const svg=await page.evaluate(()=>window.__lastRenderSvg);if(svg)await writeFile(new URL('last-render.svg',output),decodeURIComponent(svg.slice(svg.indexOf(',')+1)));}
 const zip=await JSZip.loadAsync(new Uint8Array(bytes));let captured=false;const images=[];
 for(const name of Object.keys(zip.files).filter(name=>/^word\/media\/.*\.png$/.test(name))){
  const pixels=await pngPixels(await zip.file(name).async('uint8array'));
  images.push(pixels);
  if(pixels.width===240&&pixels.height===144){await writeFile(new URL('overhang.png',output),await zip.file(name).async('uint8array'));assert.ok(pixels.red>5000,'badge must include its upper overhang: '+JSON.stringify(pixels));assert.ok(pixels.blue>10000,'card retains its original layout: '+JSON.stringify(pixels));captured=true;}
 }
 assert.ok(captured,'full card and badge must produce a 120 by 72 CSS pixel image: '+JSON.stringify(images));
});

test('UTF-8 HTML budget rejects over 64 MiB before creating an iframe', {timeout:15000},async()=>{
 const result=await page.evaluate(async()=>{try{await window.convert('中'.repeat(Math.floor(64*1024*1024/3)+1));return {unexpected:true};}catch(error){return {message:error.message,frames:document.querySelectorAll('iframe[data-office-html2docx]').length};}});
 assert.match(result.message,/64 MiB/);assert.equal(result.frames,0);
});

test('a preserved hyperlink cannot navigate the conversion iframe when clicked', {timeout:15000},async()=>{
 const result=await page.evaluate(async()=>{
  const pending=window.convert('<p><a href="https://altchunk.invalid/click" target="_self">保留但不可导航</a></p>');
  let frame,link;
  for(let i=0;i<100;i++){frame=document.querySelector('iframe[data-office-html2docx]');link=frame?.contentDocument?.querySelector('a');if(link)break;await new Promise(r=>setTimeout(r,5));}
  if(!link)throw Error('conversion link never rendered');link.click();const url=frame.contentWindow.location.href;const bytes=await pending;
  return {url,length:bytes.length,remaining:document.querySelectorAll('iframe[data-office-html2docx]').length};
 });assert.equal(result.url,'about:srcdoc');assert.ok(result.length>0);assert.equal(result.remaining,0);
});

test('solid page background uses a valid generated PNG through the browser zlib adapter', {timeout:15000},async()=>{
 const bytes=await page.evaluate(async()=>Array.from(await window.convert('<html lang="zh-CN" style="background:#123456"><head><title>导入文档标题</title></head><body><p>页面背景中文</p></body></html>')));
 const zip=await JSZip.loadAsync(new Uint8Array(bytes));
 assert.match(await zip.file('docProps/core.xml').async('string'),/导入文档标题/);
 const {inflateSync,crc32}=await import('node:zlib');let checked=false;
 for(const name of Object.keys(zip.files).filter(name=>/^word\/media\/.*\.png$/.test(name))){
  const image=Buffer.from(await zip.file(name).async('uint8array'));
  if(image.readUInt32BE(16)!==1||image.readUInt32BE(20)!==1)continue;
  let offset=8;const idat=[];
  while(offset<image.length){const size=image.readUInt32BE(offset),type=image.toString('ascii',offset+4,offset+8),data=image.subarray(offset+8,offset+8+size);assert.equal(crc32(image.subarray(offset+4,offset+8+size)),image.readUInt32BE(offset+8+size));if(type==='IDAT')idat.push(data);offset+=12+size;}
  assert.deepEqual([...inflateSync(Buffer.concat(idat))],[0,0x12,0x34,0x56]);checked=true;
 }
 assert.ok(checked,'upstream solidColorPng must be present, with valid CRC/deflate payload');
});
