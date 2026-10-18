/** OfficeEditSession -> cloned React props -> wrapper -> real upstream frame. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const results=[],out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:980,height:640}});page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.request.get(url+'/reset');await page.goto(url);await page.locator('iframe').waitFor();
  await page.addStyleTag({content:'button[aria-label="主 File 保存"],input[aria-label="宿主其他输入"]{display:none!important}'});
  const frame=page.frames().find(f=>f.parentFrame());
  try{await frame.waitForSelector('.stage-rel',{timeout:15000})}catch(error){console.error({browser:name,errors,frameText:await frame.locator('body').innerText(),hostText:await page.locator('body').innerText()});throw error}
  await frame.locator('.thumb').first().click();await page.keyboard.press('Meta+c');
  await frame.getByText('已复制幻灯片，可在其他文件中粘贴',{exact:false}).waitFor();await page.keyboard.press('Meta+v');
  await frame.waitForFunction(()=>document.querySelectorAll('.thumb').length===4);
  await page.waitForFunction(()=>window.officePptxHarness.echoCount()>0);
  await frame.locator('.thumb').nth(1).click();await frame.getByRole('button',{name:'切换',exact:true}).click();
  const stage=await frame.locator('.stage-col').elementHandle();
  const before=await page.evaluate(()=>window.officePptxHarness.echoCount());
  await frame.getByRole('button',{name:'淡入',exact:true}).click();
  await page.waitForFunction(before=>window.officePptxHarness.echoCount()>before,before);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(()=>window.officePptxHarness.clonedEcho()),true);
  assert.equal(await stage.evaluate(e=>e.isConnected),true,'clone echo must retain App DOM');
  const checkState=async()=>{
   assert.match(await frame.locator('.status-item').innerText(),/2\s*\/\s*4/);
   assert.equal(await frame.locator('.ribbon-tab.active').innerText(),'切换');
   assert.equal(await frame.getByRole('button',{name:'撤销',exact:true}).isEnabled(),true);
  };
  await checkState();
  await frame.getByRole('button',{name:'撤销',exact:true}).click();await frame.getByRole('button',{name:'恢复',exact:true}).click();
  await page.evaluate(()=>window.officePptxHarness.save());await checkState();
  assert.equal(await stage.evaluate(e=>e.isConnected),true,'native model acknowledgment must retain App DOM');
  await frame.getByRole('button',{name:'无',exact:true}).click();await page.evaluate(()=>window.officePptxHarness.save());await checkState();
  const widths=[],chrome=[];
  for(const width of [490,640]){
   await page.setViewportSize({width,height:640});
   const geometry=await frame.locator('.ribbon-tabs').evaluate(e=>{
    const s=getComputedStyle(e),r=e.getBoundingClientRect();return {left:parseFloat(s.paddingLeft),right:parseFloat(s.paddingRight),width:r.width,scroll:e.scrollWidth};
   });
   assert.ok(geometry.left<20&&geometry.right<20,JSON.stringify(geometry));
   assert.ok(geometry.scroll<=width,'top row must not overflow viewport');
   const tabs=frame.locator('.pm-ribbon-tab-list');
   const overflow=await tabs.evaluate(e=>e.scrollWidth>e.clientWidth);
   if(overflow){
    await tabs.evaluate(e=>{e.scrollLeft=16});
    await frame.waitForFunction(()=>Number(document.querySelector('.pm-ribbon-tab-list').dataset.fadeLeft)>0&&Number(document.querySelector('.pm-ribbon-tab-list').dataset.fadeLeft)<1);
    await tabs.evaluate(e=>{e.scrollLeft=e.scrollWidth});
   }
   await frame.waitForFunction(()=>document.querySelector('.pm-ribbon-tab-list').dataset.fadeRight==='0');
   await frame.getByRole('button',{name:'视图',exact:true}).click();
   assert.equal(await frame.locator('.pm-ribbon-tab-list .ribbon-tab').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height<40)),true,'labels must stay on one line');
   const status=await frame.locator('.status-bar').evaluate(e=>{
    const style=getComputedStyle(e),rect=e.getBoundingClientRect();
    const color=(value)=>{const probe=document.createElement('span');probe.style.color=value;document.body.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result};
    const controls=[...e.querySelectorAll('button')].map(button=>({height:button.getBoundingClientRect().height,width:button.getBoundingClientRect().width,right:button.getBoundingClientRect().right}));
    return {width:e.clientWidth,scroll:e.scrollWidth,left:e.querySelector('.status-item').getBoundingClientRect().width,height:rect.height,font:style.fontSize,background:style.backgroundColor,expectedBackground:color('var(--surface-subtle)'),border:style.borderTopColor,expectedBorder:color('var(--border)'),controls,slider:e.querySelector('.zoom-slider').getBoundingClientRect().width};
   });
   assert.ok(status.scroll<=width&&status.left>45,JSON.stringify(status));
   assert.equal(status.height,28);assert.equal(status.font,'12px');assert.equal(status.background,status.expectedBackground);assert.equal(status.border,status.expectedBorder);
   assert.ok(status.controls.every(control=>control.height===24&&control.width>=24&&control.right<=width));assert.equal(status.slider,100);
   const message=frame.locator('.status-msg');
   if(await message.count()&&await message.evaluate(e=>e.scrollWidth>e.clientWidth)){
    await message.evaluate(e=>{e.scrollLeft=e.scrollWidth});await frame.waitForFunction(()=>document.querySelector('.status-msg').dataset.fadeRight==='0');
    await message.evaluate(e=>{e.scrollLeft=0});
   }
   const notes=frame.locator('.status-notes-btn'),wasOpen=await frame.locator('.notes-pane').isVisible();
   assert.equal(await notes.isVisible(),true);await notes.click();assert.equal(await frame.locator('.notes-pane').isVisible(),!wasOpen);await notes.click();
   const zoom=frame.locator('.zoom-slider'),priorZoom=Number(await zoom.inputValue());await frame.locator('.zoom-btn').last().click();
   await frame.waitForFunction(previous=>Number(document.querySelector('.zoom-slider').value)>previous,priorZoom);
   assert.equal(await frame.locator('.file-tab-wrap,.autosave-toggle').count(),0);
   assert.equal(await frame.locator('button[aria-label="保存"]').count(),0);
   chrome.push({width,status});
   await frame.getByRole('button',{name:'开始',exact:true}).click();
   await frame.getByRole('button',{name:'幻灯片',exact:true}).click();
   await frame.locator('[data-tip="选择版式新建幻灯片"]').click();
   await frame.locator('.rb-layout-item').filter({hasText:'标题幻灯片'}).first().click();
   await frame.waitForFunction(expected=>document.querySelectorAll('.thumb').length===expected,width===490?5:6);
   await frame.locator('.status-play-btn').click();
   await frame.locator('.ss-counter').waitFor();await page.keyboard.press('Escape');await frame.locator('.slideshow').waitFor({state:'detached'});
   await page.screenshot({path:resolve(out,`pptx-${name}-${width}.png`)});widths.push(width);
  }
  await page.evaluate(()=>window.officePptxHarness.setReadOnly(true));
  await frame.waitForFunction(()=>document.body.dataset.readOnly==='true');
  await assert.rejects(frame.evaluate(()=>window.slidesApi.addBlankSlide({sourceIndex:0,fitWidthPx:960})),/read only/);
  await page.evaluate(()=>window.officePptxHarness.setReadOnly(false));await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');
  await page.evaluate(()=>window.officePptxHarness.external());await frame.waitForFunction(()=>document.querySelectorAll('.thumb').length===3&&document.querySelector('button[aria-label="撤销"]')?.disabled);
  assert.equal(await stage.evaluate(e=>e.isConnected),false,'external source must replace App');
  assert.deepEqual(errors,[]);results.push({browser:name,realSessionClone:true,retainedAppUndoPageAndTab:true,twoNativeSaveAcks:true,externalReset:true,readOnly:true,widths,chrome,errors});
  console.log(name+': cloned host snapshots, save acknowledgments and split-pane layout passed');
 }finally{await browser.close()}
}
await writeFile(resolve(out,'host-echo-results.json'),JSON.stringify(results,null,2)+'\n');
