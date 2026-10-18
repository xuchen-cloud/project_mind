/** Real MessagePorts, delayed native output, and two successive external File replacements. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {inspect,edit} from '../dist/engine.mjs';
if(!process.env.OFFICE_PLAYWRIGHT_MODULE||!process.env.OFFICE_ACCEPTANCE_URL)throw Error('Set OFFICE_PLAYWRIGHT_MODULE and OFFICE_ACCEPTANCE_URL');
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const fixture=new Uint8Array(await readFile(new URL('fixtures/complex.pptx',import.meta.url)));
const replacement=async text=>inspect(await edit(fixture,[{kind:'command',name:'slides:edit-text',args:[{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text}]}]}]}]));
const first=await replacement('历史 A'),last=await replacement('最终 B'),pdf=await PDFDocument.create();pdf.addPage([960,540]);const pdfBytes=Array.from(await pdf.save());
const out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});const results=[];
for(const name of (process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit'])){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{
   const Native=window.MessageChannel;
   window.protocolMessages=[];window.protocolHeld=[];
   window.MessageChannel=function(){
    const channel=new Native(),send=channel.port1.postMessage.bind(channel.port1);
    channel.port1.postMessage=message=>{window.protocolMessages.push(structuredClone(message));if(message.type==='init'&&window.protocolHoldInit)window.protocolHeld.push(message);else send(message)};
    window.protocolSend=message=>send(message);
    window.protocolFromChild=message=>channel.port2.postMessage(message);
    return channel;
   };
  });
  await page.request.get(url+'/reset');await page.goto(url);await page.locator('iframe').waitFor();const frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');
  const old=await page.evaluate(()=>window.protocolMessages.find(m=>m.type==='init').epoch);
  await page.evaluate(bytes=>{window.officePptxHarness.setPdfFixture(bytes);window.officePptxHarness.setExportMode('native');window.officePptxHarness.holdPdf()},pdfBytes);
  await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await frame.evaluate(()=>{window.oldPdf=window.slidesApi.exportPdf({filePath:'old.pdf',widthPx:960,heightPx:540,pages:[{svg:'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><text x="10" y="30">old</text></svg>'}]}).then(r=>({ok:true,result:r}),e=>({ok:false,error:String(e)}))});
  await page.waitForFunction(()=>window.officePptxHarness.pdfRequests().length===1);
  await page.evaluate(model=>{window.protocolHoldInit=true;window.officePptxHarness.replaceModel(model)},first);
  await page.waitForFunction(()=>window.protocolHeld.length===1);
  await page.evaluate(model=>window.officePptxHarness.replaceModel(model),last);
  await page.waitForFunction(()=>window.protocolHeld.length===2);
  const count=await page.evaluate(()=>window.protocolMessages.filter(m=>m.type==='flush').length);
  await page.evaluate(epoch=>{
   window.protocolFromChild({source:'project-mind-pptx',epoch,type:'initialized'});
   window.protocolFromChild({source:'project-mind-pptx',epoch,type:'change',edits:[{kind:'command',name:'slides:delete-slide',args:[0]}]});
   window.waitingFlush=window.officePptxHarness.flush();window.waitingFlush.then(()=>window.flushSettled=true,()=>window.flushSettled=true);
  },old);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.protocolMessages.filter(m=>m.type==='flush').length),count,'old initialized cannot release new initialization');
  assert.equal(await page.evaluate(()=>window.officePptxHarness.edits().length),0,'old change cannot dirty replacement');
  await page.evaluate(()=>{window.protocolHoldInit=false;window.protocolSend(window.protocolHeld[1])});
  await page.waitForFunction(()=>window.flushSettled===true);
  const oldOutput=await frame.evaluate(()=>window.oldPdf);assert.equal(oldOutput.ok,false);assert.match(oldOutput.error,/替换/);
  // Reordered old init and late old native output must be ignored by the current renderer.
  await page.evaluate(()=>{window.protocolSend(window.protocolHeld[0]);window.officePptxHarness.releasePdf()});
  await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const slides=await frame.evaluate(()=>window.slidesApi.getRenderSlides());
  assert.equal(slides[0].nodes.find(n=>n.sourceId==='e_5').text.lines.flatMap(l=>l.runs.map(r=>r.text)).join(''),'最终 B');
  assert.equal(await page.evaluate(()=>window.officePptxHarness.exports().length),0,'old PDF completion cannot export from the new File');
  assert.equal(await page.evaluate(()=>window.officePptxHarness.edits().length),0);assert.deepEqual(errors,[]);
  results.push({browser:name,staleChangeIgnored:true,staleInitializedIgnored:true,reorderedInitIgnored:true,twoExternalReplacements:true,oldPdfRejected:true,lateNativeOutputIgnored:true,errors});console.log(name+': passed');
 }finally{await browser.close()}
}
await writeFile(resolve(out,'protocol-results.json'),JSON.stringify(results,null,2)+'\n');
