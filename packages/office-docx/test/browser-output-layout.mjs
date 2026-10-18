/** Host-owned output, real editor commands and one bounded status row. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {requestOutput} from './output-command.mjs';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of(process.env.OFFICE_BROWSER?[process.env.OFFICE_BROWSER]:['chromium','webkit'])){
 const browser=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:800},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?nativeFonts');await page.waitForFunction(()=>!!document.querySelector('iframe')?.contentDocument?.querySelector('.tiptap.doc-page'));
  const f=page.frames().find(frame=>frame.parentFrame()===page.mainFrame()),tabs=f.locator('.ribbon-tabs');
  await page.evaluate(()=>{window.getSystemFonts=async()=>['Arial','Times New Roman'];window.fontMetrics=async()=>null;});
  await f.evaluate(async()=>{await document.fonts.ready;});
  assert.equal(await f.locator('.pm-file-trigger,.pm-file-menu,.autosave-toggle,.ai-dock,.ai-ask-pop,.ai-entry,.qa-sep').count(),0,'obsolete controls are absent from DOM');
  assert.equal(await f.locator('.qa-btn').count(),2,'real QAT undo/redo remain');
  assert.match(await f.locator('.qa-btn').nth(0).getAttribute('aria-label'),/撤销/);assert.match(await f.locator('.qa-btn').nth(1).getAttribute('aria-label'),/恢复/);
  assert.ok(await f.locator('.ribbon-body').evaluate(n=>n.firstElementChild?.classList.contains('ribbon-group')&&!!n.firstElementChild.querySelector('.rb-big-split')),'clipboard is the first home group; no leading separator');
  const samples=[];
  async function edges(locator){return locator.evaluate(async n=>{
   const max=n.scrollWidth-n.clientWidth,d=Math.min(64,max/2);
   const at=async x=>{n.scrollLeft=x;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=n.getBoundingClientRect();
    const edge=side=>[...document.querySelectorAll('.office-docx-scroll-edge--'+side)].find(e=>Math.abs(parseFloat(e.style.top)-box.top)<1&&Math.abs(parseFloat(e.style.height)-n.clientHeight)<1);
    return{left:Number(edge('left')?.dataset.opacity),right:Number(edge('right')?.dataset.opacity)};};
   return{max,d,start:await at(0),partial:await at(Math.min(16,max)),end:await at(max),reverse:await at(Math.min(16,max))};
  });}
  function assertEdges(fade){assert.equal(fade.start.left,0);assert.equal(fade.end.right,0);if(fade.max>0){assert.equal(fade.start.right,1);assert.equal(fade.partial.left,Math.min(1,Math.min(16,fade.max)/fade.d));assert.equal(fade.reverse.left,fade.partial.left);}else assert.equal(fade.start.right,0);}
  for(const width of[1440,640,490]){
   await page.setViewportSize({width,height:800});await tabs.evaluate(n=>{n.scrollLeft=0;});await f.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const layout=await f.evaluate(()=>{
    const box=n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width};},bar=document.querySelector('.status-bar'),info=document.querySelector('.pm-status-info'),page=document.querySelector('.status-page'),zoom=document.querySelector('.status-right');
    const strip=document.querySelector('.ribbon-tabs'),bounds=box(strip),buttons=[...strip.querySelectorAll('.ribbon-tab')].map(b=>{const r=box(b),visible=r.left>=bounds.left&&r.right<=bounds.right;return{...r,text:b.textContent.trim(),visible,nowrap:getComputedStyle(b).whiteSpace==='nowrap',hit:!visible||document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)?.closest('button')===b};});
    const controls=[page,...zoom.querySelectorAll('button,input')].map(n=>({...box(n),nowrap:getComputedStyle(n).whiteSpace==='nowrap',hit:document.elementFromPoint((box(n).left+box(n).right)/2,(box(n).top+box(n).bottom)/2)===n}));
    return{width:innerWidth,bar:box(bar),font:getComputedStyle(bar).fontSize,page:box(page),info:box(info),infoOverflow:getComputedStyle(info).overflowX,zoom:box(zoom),controls,buttons,stripLeft:bounds.left};
   });
   assert.equal(layout.bar.height,28);assert.equal(layout.font,'12px');assert.equal(layout.infoOverflow,'auto');assert.ok(layout.stripLeft<16,'no standalone window caption inset');
   assert.ok(layout.page.right<=layout.info.left&&layout.info.right<=layout.zoom.left,'only secondary info can scroll');
   assert.ok(layout.controls.every(c=>c.left>=0&&c.right<=width+1&&c.top>=layout.bar.top&&c.bottom<=layout.bar.bottom&&c.height===24&&c.hit),'24px page/zoom controls fit and receive clicks');
   assert.ok(layout.buttons.every(b=>b.hit&&b.nowrap));assert.ok(layout.buttons.find(b=>b.text==='开始')?.visible);assert.ok(!layout.buttons.some(b=>/导出|打印|文件/.test(b.text)));
   const tabEdges=await edges(tabs),statusEdges=await edges(f.locator('.pm-status-info'));assertEdges(tabEdges);assertEdges(statusEdges);
   const before=await f.locator('.status-page').boundingBox();await f.locator('.pm-status-info').evaluate(n=>{n.scrollLeft=n.scrollWidth;});assert.deepEqual(await f.locator('.status-page').boundingBox(),before,'page counter stays fixed while info scrolls');
   await requestOutput(page,'打印预览');await f.locator('.pagination-preview').waitFor();assert.equal(await f.locator('.pv-page').count(),3);await f.locator('.pv-toolbar').getByRole('button',{name:'关闭',exact:true}).click();await page.waitForFunction(()=>window.outputResult.state==='resolved');
   const caret=f.locator('.rb-font-family').locator('..').locator('button.rb-combo-caret');await caret.click();const fontMenu=f.locator('.rb-font-family-menu');await fontMenu.waitFor();assert.ok(await fontMenu.evaluate(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1;}));await page.keyboard.press('Escape');
   await page.screenshot({path:new URL(`output/browser/output-layout-${kind}-${width}.png`,import.meta.url).pathname});samples.push({layout,tabEdges,statusEdges});
  }
  assert.deepEqual(errors,[]);const result={browser:kind,version:browser.version(),noAiOrInternalFile:true,clipboardAndUndoRedo:true,status28:true,hostPreview:true,samples,errors};results.push(result);await writeFile(new URL(`output/browser/output-layout-${kind}-results.json`,import.meta.url),JSON.stringify(result,null,2));
 }finally{await browser.close();}
}
console.log(JSON.stringify(results.map(({browser,version})=>({browser,version,noAiOrInternalFile:true,clipboardAndUndoRedo:true,status28:true,splitPane490and640:true,hostPreview:true,continuousEdges:true}))));
