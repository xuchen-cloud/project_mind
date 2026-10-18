/** Delay initial fontsReady I/O so a newer presentation message arrives during init. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  await page.addInitScript(()=>{
   if(window===parent)return;
   const getAll=IDBObjectStore.prototype.getAll;
   const success=Object.getOwnPropertyDescriptor(IDBRequest.prototype,'onsuccess');
   IDBObjectStore.prototype.getAll=function(...args){
    const request=getAll.apply(this,args);
    Object.defineProperty(request,'onsuccess',{set(handler){success.set.call(request,event=>{window.fontGateWaiting=true;window.releaseFontGate=()=>handler.call(request,event)})}});
    return request;
   };
  });
  await page.request.get(url+'/reset');await page.goto(url);await page.locator('iframe').waitFor();
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForFunction(()=>window.fontGateWaiting);
  await page.evaluate(()=>window.officePptxHarness.setPresentationMode('preview'));
  await frame.waitForFunction(()=>document.body.dataset.presentationMode==='preview'&&document.body.dataset.readOnly==='true');
  await frame.evaluate(()=>window.releaseFontGate());await frame.waitForSelector('.stage-rel');
  assert.equal(await frame.locator('body').getAttribute('data-read-only'),'true','initial init must retain newer preview readonly');
  await assert.rejects(frame.evaluate(()=>window.slidesApi.addBlankSlide({sourceIndex:0,fitWidthPx:960})),/read only/);
  console.log(name+': newer preview/readonly during fontsReady init retained');
 }finally{await browser.close()}
}
