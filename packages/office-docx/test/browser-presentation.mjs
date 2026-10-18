/** Full document layout, pagination, zoom and editor identity survive preview/edit. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {requestOutput} from './output-command.mjs';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of (process.env.OFFICE_BROWSER?[process.env.OFFICE_BROWSER]:['chromium','webkit'])){
 const browser=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:640,height:800}}),errors=[];page.setDefaultTimeout(15000);const phase=(name)=>console.log(kind+': '+name);page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.presentationExport=file=>{window.exportFile=file;return new Promise(resolve=>{window.releaseExport=resolve;});};});
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/presentation?earlyOutput');await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentDocument?.querySelector('.tiptap.doc-page'));const f=page.frames().find(frame=>frame.parentFrame()===page.mainFrame()),body=f.locator('.tiptap.doc-page');await body.waitFor();
  await f.evaluate(async()=>{await document.fonts.ready;});
  await f.locator('.pagination-preview').waitFor();assert.equal(await f.locator('.pv-page').count(),3);await page.evaluate(()=>window.firstOutput);await f.locator('.pv-toolbar').getByRole('button',{name:'关闭',exact:true}).click();
  await f.locator('.status-page').filter({hasText:/共\s*3\s*页/}).waitFor();
  await f.evaluate(()=>{window.__presentationDocument=document;window.__presentationBody=document.querySelector('.tiptap.doc-page');});
  await page.evaluate(()=>{window.__presentationFrame=document.querySelector('iframe');});
  async function settle(){await f.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
  async function metrics(){await settle();return body.evaluate(node=>{
   const zoom=Number.parseFloat(getComputedStyle(document.querySelector('.doc-zoom')).zoom)||1,base=node.getBoundingClientRect(),round=n=>Math.round(n*10)/10;
   const box=n=>{const r=n.getBoundingClientRect();return{top:round((r.top-base.top)/zoom),width:round(r.width/zoom),height:round(r.height/zoom)};};
   return{zoom,zoomLabel:document.querySelector('.zoom-value').textContent.trim(),width:box(node).width,height:box(node).height,text:node.textContent,
    gaps:[...node.querySelectorAll('.page-gap')].map(box),blocks:[...node.querySelectorAll('[data-idx]')].map(box),
    pageTotal:document.querySelector('.status-page').textContent.match(/共\s*(\d+)\s*页/)?.[1]};
  });}
  let maxPhysicalDrift=0;
  function sameLayout(actual,expected,message){
   const {blocks:a,gaps:g,...rest}=actual,{blocks:b,gaps:h,...baseline}=expected;
   assert.deepEqual(rest,baseline,message);assert.equal(a.length,b.length);assert.equal(g.length,h.length);
   // Upstream rounds page-gap CSS heights to integers at fractional zoom. A
   // focus/scroll change can move a following block by one rendered CSS pixel.
   for(const [left,right]of [[a,b],[g,h]])for(let i=0;i<left.length;i++)for(const key of ['top','width','height']){
    const drift=Math.abs(left[i][key]-right[i][key])*actual.zoom;maxPhysicalDrift=Math.max(maxPhysicalDrift,drift);
    assert.ok(drift<=1.01,`${message??'pagination'}: ${key} drift ${drift}px exceeds one rendered pixel`);
   }
  }
  async function mode(value,locked=false){await page.evaluate(([value,locked])=>window.presentation.set(value,locked),[value,locked]);await body.locator(`xpath=self::*[@contenteditable="${value==='edit'&&!locked?'true':'false'}"]`).waitFor();await settle();
   assert.equal(await page.evaluate(()=>document.querySelector('iframe')===window.__presentationFrame),true);
   assert.equal(await body.evaluate(n=>n===window.__presentationBody&&document===window.__presentationDocument),true,'same iframe document and live editor DOM');
   assert.equal(await f.locator('.pm-file-trigger,.pm-file-menu').count(),0);assert.equal(await f.locator('.ribbon').isVisible(),value==='edit');assert.equal(await f.locator('.status-page').isVisible(),true);assert.equal(await f.locator('.zoom-slider').isVisible(),true);
   assert.equal(await f.locator('.ribbon-tabs').isVisible(),value==='edit');assert.equal(await f.locator('.ribbon-body').isVisible(),value==='edit');
  }
  assert.equal(await body.getAttribute('contenteditable'),'false','presentation mode enforces read-only even without a separate lock');
  assert.equal(await f.locator('.pm-preview-state').isVisible(),true);
  phase('initial');const initial=await metrics();assert.equal(initial.pageTotal,'3');assert.ok(initial.gaps.length>=2,'real full-renderer pagination, not a plain reading document');
  const text=await body.innerText();await body.locator('p[data-idx="3"]').click();await page.keyboard.type('MUST_NOT_EDIT');assert.equal(await body.innerText(),text);assert.deepEqual(await page.evaluate(()=>window.presentation.edits()),[]);
  phase('initial edit');await mode('edit');phase('initial edit metrics');sameLayout(await metrics(),initial,'preview and editor share paper dimensions, page breaks, fonts and zoom');
  // Set an explicit user zoom through the real dialog while in preview.
  await mode('preview');await f.locator('.zoom-value').click();let dialog=f.locator('.zoom-dialog');await dialog.waitFor();assert.equal(await dialog.evaluate(n=>!!n.closest('[inert]')),false);
  await dialog.locator('input[type=number]').fill('40');await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'hidden'});phase('manual');const manual=await metrics();assert.equal(manual.zoomLabel,'40%');
  for(const next of ['edit','preview','edit']){await mode(next);sameLayout(await metrics(),manual,'manual zoom and pagination persist');}
  // Fit-to-page used to refit on the height change caused by showing the ribbon.
  await f.locator('.zoom-value').click();await dialog.getByLabel('整页',{exact:true}).check();await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'hidden'});phase('fit');const fit=await metrics();
  phase('fit preview');await mode('preview');sameLayout(await metrics(),fit,'fit ratio is not reset on a chrome-only change');phase('fit edit');await mode('edit');phase('fit edit metrics');sameLayout(await metrics(),fit);
  phase('edit history');const p=body.locator('p[data-idx="3"]'),original=await p.innerText();await p.click();await page.keyboard.press('End');await page.keyboard.insertText('模式切换保留撤销');await page.evaluate(()=>window.presentation.flush());const edited=await metrics();
  await mode('preview');sameLayout(await metrics(),edited);await mode('edit');sameLayout(await metrics(),edited);await f.locator('.qa-btn').nth(0).click();await page.waitForFunction(original=>document.querySelector('iframe').contentDocument.querySelector('p[data-idx="3"]').textContent===original,original);await f.locator('.qa-btn').nth(1).click();await p.filter({hasText:'模式切换保留撤销'}).waitFor();
  await mode('edit',true);assert.equal(await body.getAttribute('contenteditable'),'false','history/version lock is independent of presentation');await mode('preview');
  await requestOutput(page,'打印预览');await f.locator('.pagination-preview').waitFor();assert.equal(await f.locator('.pv-page').count(),3);await f.locator('.pv-toolbar').getByRole('button',{name:'关闭',exact:true}).click();
  await page.setViewportSize({width:490,height:800});await settle();const narrow=await metrics();await mode('edit');sameLayout(await metrics(),narrow,'same narrow-pane zoom strategy');await mode('preview');sameLayout(await metrics(),narrow);
  await page.screenshot({path:new URL(`output/browser/presentation-${kind}-490.png`,import.meta.url).pathname});assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.presentation.errors),[]);
  // Native output stays pending for its real receipt; closing the instance cancels it.
  await requestOutput(page,'导出 HTML');await page.waitForFunction(()=>!!window.releaseExport);assert.equal(await page.evaluate(()=>window.outputResult.state),'pending');await page.evaluate(()=>window.presentation.dispose());await page.waitForFunction(()=>window.outputResult.state==='rejected');assert.match(await page.evaluate(()=>window.outputResult.error),/已关闭/);await page.evaluate(()=>window.releaseExport(true));await page.evaluate(()=>window.outputPromise);assert.equal(await page.evaluate(()=>window.outputResult.state),'rejected');
  const result={browser:kind,version:browser.version(),sameInstance:true,outputReadyAndDispose:true,fullPagination:true,previewLocked:true,hostOutputAndPageZoom:true,zoomManual:manual.zoomLabel,fitZoom:fit.zoomLabel,layoutAndZoomPreserved:true,undoRedoRetained:true,historyLock:true,narrow490:true,maxPhysicalDrift,errors};results.push(result);await writeFile(new URL(`output/browser/presentation-${kind}-results.json`,import.meta.url),JSON.stringify(result,null,2));
 }finally{await browser.close();}
}
console.log(JSON.stringify(results));
