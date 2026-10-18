/** Real upstream overlay + native receipt: save must keep the current DOM selection. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(!process.env.OFFICE_PLAYWRIGHT_MODULE||!process.env.OFFICE_ACCEPTANCE_URL)throw Error('Set OFFICE_PLAYWRIGHT_MODULE and OFFICE_ACCEPTANCE_URL');
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});const results=[];
for(const name of (process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit'])){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.request.get(`${url}/reset`);await page.goto(url);await page.locator('iframe').waitFor();const frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');
  const input=frame.locator('.slide-text-editor');
  const point=await frame.evaluate(async()=>{const s=(await window.slidesApi.getRenderSlides())[0],n=s.nodes.find(n=>n.sourceId==='e_5'),r=document.querySelector('.stage-rel').getBoundingClientRect(),z=r.width/s.widthPx;return {x:r.x+(n.box.x+n.box.w*.1)*z,y:r.y+(n.box.y+n.box.h*.4)*z}}),offset=await page.locator('iframe').boundingBox();
  await page.mouse.dblclick(point.x+offset.x,point.y+offset.y);await input.waitFor();await input.fill('中文 Alpha 中间 Beta 尾部');
  await input.press('Meta+ArrowLeft');await input.press('ArrowRight');await input.press('ArrowRight');await input.press('ArrowRight');
  const selection=()=>input.evaluate(root=>{const s=window.getSelection();const at=(node,n)=>{const r=document.createRange();r.selectNodeContents(root);r.setEnd(node,n);return r.toString().length};return {anchor:at(s.anchorNode,s.anchorOffset),focus:at(s.focusNode,s.focusOffset),text:s.toString(),active:document.activeElement===root}});
  const before=await selection();assert.equal(before.anchor,3);assert.equal(before.active,true);
  await page.evaluate(()=>window.officePptxHarness.save());
  assert.equal(await input.count(),1,'native save receipt must retain the active TextEditOverlay');
  await frame.waitForFunction(()=>document.activeElement===document.querySelector('.slide-text-editor'));
  assert.deepEqual(await selection(),before,'native save must retain the same caret');
  await page.keyboard.insertText('续');await page.evaluate(()=>window.officePptxHarness.save());
  const model=await(await page.request.get(`${url}/model`)).json();assert.equal(model.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'中文 续Alpha 中间 Beta 尾部');assert.deepEqual(errors,[]);
  await frame.waitForFunction(()=>document.activeElement===document.querySelector('.slide-text-editor'));
  // Backward range, true host File button, and a native receipt held while readOnly.
  await input.fill('中文 Alpha 中间 Beta 尾部');await input.press('Meta+ArrowLeft');
  for(let i=0;i<8;i++)await input.press('ArrowRight');
  for(let i=0;i<5;i++)await input.press('Shift+ArrowLeft');
  const range=await selection();assert.equal(range.text,'Alpha');assert.equal(range.anchor,8);assert.equal(range.focus,3);
  const original=await input.elementHandle();
  let release,arrived;const gate=new Promise(r=>{release=r}),native=new Promise(r=>{arrived=r});
  await page.route('**/save',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response})});
  await page.getByRole('button',{name:'主 File 保存',exact:true}).click();await native;
  await frame.waitForFunction(()=>document.body.dataset.readOnly==='true');
  assert.equal(await original.evaluate(e=>e.isConnected&&e===document.querySelector('.slide-text-editor')),true,'same overlay DOM during native save');
  const pendingText=await input.innerText();await page.keyboard.insertText('不能写入');assert.equal(await input.innerText(),pendingText);
  release();await frame.waitForFunction(()=>document.body.dataset.readOnly==='false'&&document.activeElement===document.querySelector('.slide-text-editor'));
  await page.unroute('**/save');assert.deepEqual(await selection(),range);
  await page.keyboard.insertText('续B');await page.getByRole('button',{name:'主 File 保存',exact:true}).click();
  await frame.waitForFunction(()=>document.body.dataset.readOnly==='false'&&document.activeElement===document.querySelector('.slide-text-editor'));
  let saved=await(await page.request.get(url+'/model')).json();assert.equal(saved.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'中文 续B 中间 Beta 尾部');
  // Existing original File menu uses the same checkpoint and leaves the caret in place.
  await input.press('Meta+ArrowLeft');for(let i=0;i<3;i++)await input.press('ArrowRight');await page.keyboard.insertText('菜单');
  await page.evaluate(()=>window.officePptxHarness.holdSaveCompletion());
  await frame.evaluate(()=>{const original=window.slidesApi.save;window.slidesApi.save=(...args)=>original(...args).then(result=>{window.internalSaveReceipt=result;return result})});
  const menuCaret=await selection();await frame.getByRole('button',{name:'文件',exact:true}).click();
  await frame.locator('.file-menu button').filter({hasText:/^保存/}).first().click();
  await frame.waitForFunction(()=>document.body.dataset.readOnly==='false'&&document.activeElement===document.querySelector('.slide-text-editor'));
  await frame.waitForFunction(()=>window.internalSaveReceipt?.ok===true);
  // Native model acknowledgement has already settled the request while the host callback is still held.
  await page.evaluate(()=>window.officePptxHarness.releaseSaveCompletion());
  assert.deepEqual(await selection(),menuCaret);await page.keyboard.insertText('C');
  await page.evaluate(()=>window.officePptxHarness.save());await frame.waitForFunction(()=>document.activeElement===document.querySelector('.slide-text-editor'));
  saved=await(await page.request.get(url+'/model')).json();assert.equal(saved.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'中文 菜单C续B 中间 Beta 尾部');
  await page.screenshot({path:resolve(out,'pptx-'+name+'-caret-saved.png')});
  await input.press('Escape');await frame.getByRole('button',{name:'撤销',exact:true}).click();await page.evaluate(()=>window.officePptxHarness.save());
  saved=await(await page.request.get(url+'/model')).json();assert.equal(saved.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'中文 菜单续B 中间 Beta 尾部');
  await frame.getByRole('button',{name:'恢复',exact:true}).click();await page.evaluate(()=>window.officePptxHarness.save());
  // Moving to another host input during pending native I/O must not steal focus back.
  await page.mouse.dblclick(point.x+offset.x,point.y+offset.y);await input.waitFor();
  let releaseFocus,focusArrived;const focusGate=new Promise(r=>{releaseFocus=r}),focusNative=new Promise(r=>{focusArrived=r});
  await page.route('**/save',async route=>{const response=await route.fetch();focusArrived();await focusGate;await route.fulfill({response})});
  await page.getByRole('button',{name:'主 File 保存',exact:true}).click();await focusNative;
  await page.getByRole('textbox',{name:'宿主其他输入'}).click();await page.keyboard.insertText('保持宿主焦点');
  releaseFocus();await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');await page.unroute('**/save');
  const hostFocused=await page.getByRole('textbox',{name:'宿主其他输入'}).evaluate(e=>document.activeElement===e);
  assert.equal(hostFocused,true);
  // A genuine readonly transition and true historical replacement cannot revive the prior editor.
  await input.click();
  await page.evaluate(()=>window.officePptxHarness.failNextSave());
  const failed=await frame.evaluate(()=>window.slidesApi.save());assert.equal(failed.ok,false);assert.match(failed.error,/CAS conflict/);
  await page.mouse.dblclick(point.x+offset.x,point.y+offset.y);await input.waitFor();
  await page.evaluate(()=>window.officePptxHarness.setReadOnly(true));await input.waitFor({state:'detached'});
  await page.evaluate(()=>window.officePptxHarness.setReadOnly(false));await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');assert.equal(await input.count(),0);
  await page.mouse.dblclick(point.x+offset.x,point.y+offset.y);await input.waitFor();await input.press('Meta+ArrowLeft');await page.keyboard.insertText('旧草稿');
  await page.evaluate(()=>window.officePptxHarness.external());await input.waitFor({state:'detached'});
  await frame.waitForFunction(()=>document.querySelector('button[aria-label="撤销"]')?.disabled);
  assert.equal((await frame.evaluate(()=>window.slidesApi.getRenderSlides()))[0].nodes.find(n=>n.sourceId==='e_5').text.lines.flatMap(l=>l.runs.map(r=>r.text)).join(''),'项目进展正常');
  assert.deepEqual(errors,[]);
  results.push({browser:name,caret:true,backwardRange:true,pendingNativeReceipt:true,sameOverlayDom:true,hostFileSave:true,internalFileSave:true,ackBeforeSaveCallbackSettles:true,noHostFocusTheft:true,internalSaveErrorSettles:true,secondNativeSave:true,crossSaveUndo:true,readOnlyDropsOverlay:true,externalDropsOverlay:true,errors});console.log(`${name}: passed`);
 }finally{await browser.close()}
}
await writeFile(resolve(out,'caret-results.json'),JSON.stringify(results,null,2)+'\n');
