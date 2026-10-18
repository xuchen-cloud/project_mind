/** Mount identity at actual async conversion and JSZip serialization boundaries. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {inspect,edit} from '../dist/engine.mjs';
import {altChunkFixture,convertedAltChunkFixture} from './fixtures/alt-chunk.mjs';
const {chromium,webkit}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const browser=await(process.env.OFFICE_BROWSER==='webkit'?webkit.launch({headless:true}):chromium.launch({headless:true,channel:'chrome'}));
const original=new Uint8Array(await readFile(new URL('fixtures/complex.original.docx',import.meta.url)));
const plain=await inspect(original),altBytes=await altChunkFixture(),alt=await inspect(altBytes);
async function replacement(bytes){return inspect(await edit(bytes,[{type:'text',nodeId:'docx:2',text:'外部替换：新的真实文档。'}]));}
const external=await replacement(original),externalAlt=await replacement(altBytes),converted=Array.from(await convertedAltChunkFixture());
const results=[];
try{
 for(const kind of (process.env.OFFICE_LIFECYCLE_CASE?[process.env.OFFICE_LIFECYCLE_CASE]:['conversion','serialization']))for(const action of (kind==='serialization'?['replace','dispose','destroy-renderer']:['replace','dispose']).filter(action=>!process.env.OFFICE_LIFECYCLE_ACTION||action===process.env.OFFICE_LIFECYCLE_ACTION)){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(({initial,converted})=>{
   window.lifecycleInitial=initial;window.conversions=[];
   window.lifecycleConvert=(_html,file)=>new Promise(resolve=>{window.conversions.push({file,release:()=>resolve(new Uint8Array(converted))});});
  },{initial:kind==='conversion'?alt:plain,converted});
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/lifecycle');
  await page.waitForFunction(()=>window.lifecycle);
  if(kind==='conversion')await page.waitForFunction(()=>window.conversions.length===1);
  else{
   const body=page.frameLocator('iframe').locator('.tiptap.doc-page');await body.waitFor();
   await page.evaluate(()=>window.lifecycle.flush());
   await page.evaluate(()=>{
    const w=document.querySelector('iframe').contentWindow;
    window.serializeHeld=[];const run=(callback,...args)=>window.setTimeout(()=>callback(...args),0);
    w.setImmediate=(callback,...args)=>{window.serializeHeld.push(()=>run(callback,...args));return window.serializeHeld.length;};
    window.releaseSerialize=()=>{w.setImmediate=run;window.serializeHeld.splice(0).forEach(fn=>fn());};
   });
   const paragraph=body.locator('p[data-idx="2"]');await paragraph.click();await page.keyboard.press('End');await page.keyboard.insertText('序列化中的旧文档编辑');
   await page.waitForFunction(()=>window.serializeHeld.length>0,undefined,{timeout:5000});
  }
  await page.evaluate(async action=>{
   const frame=document.querySelector('iframe');window.oldSettings=frame.__projectMindDocxOptions;window.oldHost=frame.contentWindow.__projectMindDocxHost;
   window.oldSave={state:'pending'};window.lifecycle.flush().then(()=>window.oldSave.state='resolved',error=>{window.oldSave={state:'rejected',error:String(error)};});
   if(action==='destroy-renderer'){
    window.oldRawSave='pending';window.oldHost.flush(true).then(()=>window.oldRawSave='resolved',error=>window.oldRawSave=String(error));
    // Let the real flush reach its already-held ZIP promise before detaching.
    await new Promise(resolve=>frame.contentWindow.requestAnimationFrame(resolve));
   }
  },action);
  assert.equal(await page.evaluate(()=>window.oldSave.state),'pending');
  if(action==='destroy-renderer'){
   // Keep this iframe attached until its real ZIP result returns. WebKit stops
   // a removed realm's Promise jobs, so the public mount cancellation above is
   // what releases a removed frame's callers. This separate check exercises
   // renderer-host's late-result guard without relying on that browser detail.
   await page.evaluate(()=>{window.oldHost.destroy();window.releaseSerialize();});
   await page.waitForFunction(()=>window.oldRawSave!=='pending',undefined,{timeout:1200});
   assert.match(await page.evaluate(()=>window.oldRawSave),/关闭|失效/,'destroyed renderer must reject its own late real serializer result');
  }
  await page.evaluate(({action,model})=>action==='replace'?window.lifecycle.replace(model):window.lifecycle.dispose(),{action,model:kind==='conversion'?externalAlt:external});
  await page.waitForFunction(()=>window.oldSave.state!=='pending',undefined,{timeout:1200});
  assert.equal(await page.evaluate(()=>window.oldSave.state),'rejected','invalidated beforeSave must reject without waiting for old I/O');
  assert.match(await page.evaluate(()=>window.oldSave.error),/替换|关闭|失效/);
  if(action==='replace'&&kind==='conversion'){
   await page.waitForFunction(()=>window.conversions.length===2);
   await page.evaluate(()=>{window.newSave='pending';window.lifecycle.flush().then(()=>window.newSave='resolved',error=>window.newSave=String(error));window.oldSettings.onReady();});
   await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>window.newSave),'pending','old ready must not release new ready');
  }
  const before=await page.evaluate(()=>window.lifecycle.events.length);
  const late=await page.evaluate(async kind=>{
   window.oldSettings.onChange([{type:'snapshot',baselineHash:'stale',base64:'stale'}]);window.oldSettings.onPending(true);window.oldSettings.onError('旧 frame 错误');
   let save;try{await window.oldSettings.onSaveRequest();save='resolved';}catch(error){save=String(error);}
   if(kind==='conversion')window.conversions[0].release();else window.releaseSerialize();
   return save;
  },kind);
  assert.match(late,/替换|关闭|失效/,'stale save must never invoke a host callback');
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(before=>window.lifecycle.events.slice(before),before),[],'old frame cannot publish into new File');
  if(action==='replace'){
   if(kind==='conversion'){assert.equal(await page.evaluate(()=>window.newSave),'pending');await page.evaluate(()=>window.conversions[1].release());}
   await page.frameLocator('iframe').locator('.tiptap.doc-page').waitFor();
   await page.evaluate(()=>window.lifecycle.flush());
   assert.match(await page.frameLocator('iframe').locator('.tiptap.doc-page').innerText(),/外部替换：新的真实文档/);
   await page.evaluate(()=>window.lifecycle.dispose());
  }
  results.push({kind,action,oldWaitRejected:true,lateCallbacksIgnored:true,newReadyIsolated:action==='replace'});await page.close();
 }
 const result={browser:browser.version(),cases:results};console.log(JSON.stringify(result));await writeFile(new URL(`output/browser/lifecycle-${process.env.OFFICE_BROWSER??'chromium'}${process.env.OFFICE_LIFECYCLE_CASE?'-'+process.env.OFFICE_LIFECYCLE_CASE:''}-results.json`,import.meta.url),JSON.stringify(result,null,2));
}finally{await browser.close();}
