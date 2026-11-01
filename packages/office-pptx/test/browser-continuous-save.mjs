/** Real full slides renderer + upstream package candidate/native serializer. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {inspect,edit} from '../dist/engine.mjs';
const pw=await import(process.env.OFFICE_PLAYWRIGHT_MODULE?pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href:new URL('../../office-xlsx/node_modules/@playwright/test/index.mjs',import.meta.url).href);
const base=await readFile(new URL('./fixtures/complex.pptx',import.meta.url));
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true});
 try{
  let release,arrived;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{arrived=r}),saved=[];
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.exposeFunction('persistCandidate',async edits=>{const bytes=await edit(base,edits);saved.push(await inspect(bytes));if(saved.length===1){arrived();await gate;}});
  await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/continuous.html');await page.locator('iframe').waitFor();
  const frame=page.frames().find(f=>f.parentFrame());await frame.locator('.stage-rel').waitFor();
  const point=await frame.evaluate(async()=>{const slide=(await window.slidesApi.getRenderSlides())[0],node=slide.nodes.find(n=>n.sourceId==='e_5'),rect=document.querySelector('.stage-rel').getBoundingClientRect(),scale=rect.width/slide.widthPx;return{x:rect.x+(node.box.x+node.box.w*.1)*scale,y:rect.y+(node.box.y+node.box.h*.4)*scale}}),offset=await page.locator('iframe').boundingBox();
  await page.mouse.dblclick(point.x+offset.x,point.y+offset.y);const input=frame.locator('.slide-text-editor');await input.waitFor();await input.fill('FIRST');await input.press('End');
  await page.evaluate(()=>window.continuous.flush());await page.waitForFunction(()=>window.continuous.state().editRevision>0);
  const firstRevision=await page.evaluate(()=>window.continuous.state().editRevision);
  await input.evaluate(node=>{window.originalEditor=node});await page.evaluate(()=>{window.inFlight=window.continuous.save()});await started;
  await page.keyboard.insertText(' LATE');await page.evaluate(()=>window.continuous.flush());await page.waitForFunction(revision=>window.continuous.state().editRevision>revision,firstRevision);
  const caret=()=>input.evaluate(node=>{const s=getSelection();return{text:node.innerText,anchor:s.anchorOffset,focus:s.focusOffset,active:document.activeElement===node,same:node===window.originalEditor}});
  const before=await caret();assert.equal(before.active,true);release();await page.evaluate(()=>window.inFlight);await page.waitForFunction(revision=>window.continuous.state().savedEditRevision===revision,firstRevision);assert.deepEqual(await caret(),before);
  assert.equal(await page.evaluate(()=>window.continuous.state().dirty),true);
  await page.evaluate(()=>window.continuous.save());await page.waitForFunction(()=>!window.continuous.state().dirty);
  const text=model=>model.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text;
  assert.equal(text(saved[0]),'FIRST');assert.equal(text(saved[1]),'FIRST LATE');
  await input.press('Escape');await frame.getByRole('button',{name:'撤销',exact:true}).click();await page.evaluate(()=>window.continuous.save());assert.notEqual(text(saved[2]),text(saved[1]));
  assert.deepEqual(pageErrors,[]);
  console.log(`${name}: fixed PPTX model, delayed receipt, late dirty, overlay/caret, second saved bytes and cross-save undo passed`);
 }finally{await browser.close();}
}
