/** Same upstream App/Canvas/session for preview and edit, through the real cloned host. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const pixelHashes=values=>values.map(value=>createHash('sha256').update(value).digest('hex'));
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});const results=[];
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:980,height:700}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.request.get(url+'/reset');await page.goto(url+'/?presentation=preview');await page.locator('iframe').waitFor();
  await page.addStyleTag({content:'button[aria-label="主 File 保存"],input[aria-label="宿主其他输入"]{display:none!important}'});
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel',{timeout:15000});
  const settled=()=>frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const mode=async value=>{await page.evaluate(value=>window.officePptxHarness.setPresentationMode(value),value);await frame.waitForFunction(value=>document.body.dataset.presentationMode===value,value);await settled()};
  const pixels=()=>frame.locator('.stage-rel canvas').evaluateAll(canvases=>canvases.map(c=>c.toDataURL()));
  const render=()=>frame.evaluate(()=>window.slidesApi.getRenderSlides());
  const context=()=>page.evaluate(()=>({model:window.officePptxHarness.model(),edits:window.officePptxHarness.edits(),echoes:window.officePptxHarness.echoCount()}));
  const previewChrome=async()=>{
   assert.equal(await frame.getByRole('button',{name:'文件',exact:true}).count(),0);
   for(const selector of ['.ribbon','.ribbon-body','.pm-ribbon-tab-list','.notes-pane','.status-notes-btn'])assert.equal(await frame.locator(selector).isVisible(),false,selector);
   assert.equal(await frame.locator('.slide-list').isVisible(),true);assert.equal(await frame.locator('.zoom-slider').isVisible(),true);
   assert.equal(await frame.locator('.thumb[draggable="true"]').count(),0);
   assert.equal(await frame.locator('body').getAttribute('data-read-only'),'true');
   const status=await frame.locator('.status-bar').evaluate(e=>({height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize,buttons:[...e.querySelectorAll('button')].filter(button=>getComputedStyle(button).display!=='none').map(button=>button.getBoundingClientRect().height),slider:e.querySelector('.zoom-slider').getBoundingClientRect().width}));
   assert.equal(status.height,28);assert.equal(status.font,'12px');assert.ok(status.buttons.every(height=>height===24));assert.equal(status.slider,100);
  };
  await previewChrome();assert.equal(await frame.locator('.stage-rel canvas').count()>0,true);
  const app=await frame.locator('.app').elementHandle(),canvas=await frame.locator('.stage-rel canvas').first().elementHandle();
  // A user zoom uses precisely the original control/geometry in both presentations.
  const slider=frame.locator('.zoom-slider');await slider.focus();await slider.press('Home');await slider.press('ArrowRight');await settled();
  const zoom=await slider.inputValue(),initialRender=await render(),initialContext=await context(),initialPixels=await pixels();
  await mode('edit');assert.equal(await frame.locator('.ribbon-body').isVisible(),true);
  // Original zoom controls commit a gesture after their 150ms debounce.
  await frame.waitForFunction(expected=>document.querySelector('.zoom-slider').value===expected,zoom);await settled();assert.equal(await slider.inputValue(),zoom);
  assert.deepEqual(await render(),initialRender);assert.deepEqual(await context(),initialContext);assert.deepEqual(pixelHashes(await pixels()),pixelHashes(initialPixels),'same canvas pixels at the same zoom');
  assert.equal(await app.evaluate(e=>e.isConnected),true);assert.equal(await canvas.evaluate(e=>e.isConnected),true);
  await frame.locator('.thumb').nth(1).click();await frame.getByRole('button',{name:'切换',exact:true}).click();
  const before=initialContext.echoes;await frame.getByRole('button',{name:'淡入',exact:true}).click();await page.waitForFunction(before=>window.officePptxHarness.echoCount()>before,before);
  assert.equal(await frame.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true);
  const editedContext=await context(),editedRender=await render();
  await mode('preview');await previewChrome();assert.match(await frame.locator('.status-item').innerText(),/2\s*\/\s*3/);
  assert.deepEqual(await context(),editedContext);assert.deepEqual(await render(),editedRender);
  await frame.locator('.thumb').nth(1).click();await page.keyboard.press('ArrowRight');await frame.locator('.status-item').filter({hasText:/3\s*\/\s*3/}).waitFor();
  await page.keyboard.press('ArrowLeft');await frame.locator('.status-item').filter({hasText:/2\s*\/\s*3/}).waitFor();
  await frame.locator('.thumb').nth(1).click({button:'right'});assert.equal(await frame.locator('.ctx-menu').isVisible(),false);
  await assert.rejects(frame.evaluate(()=>window.slidesApi.addBlankSlide({sourceIndex:0,fitWidthPx:960})),/read only/);
  assert.deepEqual(await context(),editedContext);assert.deepEqual(await render(),editedRender);
  await mode('edit');assert.equal(await frame.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true);
  assert.equal(await frame.locator('.ribbon-tab.active').innerText(),'切换');assert.equal(await slider.inputValue(),zoom);
  assert.deepEqual(await context(),editedContext);assert.deepEqual(await render(),editedRender);
  await frame.getByRole('button',{name:'撤销',exact:true}).click();await frame.getByRole('button',{name:'恢复',exact:true}).click();
  await page.evaluate(()=>window.officePptxHarness.flush());
  // Selection handles are Canvas content: the adapter removes only those in preview,
  // while retaining the original editor selection for the return to edit.
  await frame.locator('.thumb').first().click();await frame.getByRole('button',{name:'开始',exact:true}).click();await settled();
  await frame.locator('.stage-wrap').click({position:{x:4,y:4}});await settled();const plain=await pixels();
  const point=await frame.evaluate(async()=>{const slide=(await window.slidesApi.getRenderSlides())[0],node=slide.nodes.find(n=>n.sourceId==='e_5'),r=document.querySelector('.stage-rel').getBoundingClientRect();return{x:r.x+(node.box.x+node.box.w*.1)*r.width/slide.widthPx,y:r.y+(node.box.y+node.box.h*.4)*r.height/slide.heightPx}});
  const offset=await page.locator('iframe').boundingBox();await page.mouse.click(point.x+offset.x,point.y+offset.y);await settled();
  // A text hit enters the upstream overlay; a real ribbon tab click commits it
  // and leaves the underlying shape selected (Escape also clears selection).
  if(await frame.locator('.slide-text-editor').count()){await frame.getByRole('button',{name:'切换',exact:true}).click();await frame.getByRole('button',{name:'开始',exact:true}).click();}
  await frame.locator('.slide-text-editor').waitFor({state:'detached'});await page.evaluate(()=>window.officePptxHarness.flush());await settled();
  assert.equal(await frame.locator('.slide-text-editor').count(),0);
  const selected=await pixels();assert.notDeepEqual(pixelHashes(selected),pixelHashes(plain),'real selection handles must exist in edit');
  await page.screenshot({path:resolve(out,`pptx-${name}-selection-before.png`)});
  const selectedContext=await context();await mode('preview');assert.deepEqual(pixelHashes(await pixels()),pixelHashes(plain),'preview uses original canvas without editing handles');
  assert.deepEqual(await context(),selectedContext);await mode('edit');
  await page.screenshot({path:resolve(out,`pptx-${name}-selection-after.png`)});
  assert.deepEqual(pixelHashes(await pixels()),pixelHashes(selected),'selection state survives presentation switches; zoom='+await slider.inputValue());
  for(const width of [490,640]){await mode('preview');await page.setViewportSize({width,height:700});await settled();await previewChrome();await page.screenshot({path:resolve(out,`pptx-${name}-preview-${width}.png`)})}
  assert.equal(await app.evaluate(e=>e.isConnected),true);assert.equal(await canvas.evaluate(e=>e.isConnected),true);assert.deepEqual(errors,[]);
  results.push({browser:name,sameAppCanvas:true,identicalSlidePixels:true,modelEditsUnchanged:true,undoPreserved:true,selectionPreserved:true,hostOnlyFileMenu:true,pageNavigation:true,originalZoomControl:true,widths:[490,640],errors});console.log(name+': same renderer preview/edit presentation passed');
 }finally{await browser.close()}
}
await writeFile(resolve(out,'presentation-results.json'),JSON.stringify(results,null,2)+'\n');
