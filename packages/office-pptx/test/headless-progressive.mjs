/** Real App/Canvas/MessagePort/native-byte-harness acceptance; no visible GUI or file watcher. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import JSZip from 'jszip';
if(!process.env.OFFICE_PLAYWRIGHT_MODULE)throw Error('Set OFFICE_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
process.env.OFFICE_PPTX_PROGRESSIVE='1';
const {createServer}=await import('vite');
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href);
const server=await createServer({configFile:fileURLToPath(new URL('./ui/vite.config.mjs',import.meta.url)),server:{watch:null,hmr:false,open:false,port:0}});
await server.listen();
const url=server.resolvedUrls.local[0],results=[];
const out=new URL('../output/playwright/',import.meta.url);await mkdir(out,{recursive:true});
try{
 for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
  const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{})});
  let page;
  try{
   page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
   page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));
   // Fault injection wraps the real built parser; no parser/layout/save is mocked.
   // The far-tail parser is unavailable until explicitly released after both saves.
   await page.route('**/renderer.mjs',async route=>{
    const response=await route.fetch();let source=await response.text();
    const alias=/var [\w$]+=([\w$]+);function [\w$]+\([\w$]+\)\{return!![\w$]+\.projectMindUnloaded\}/.exec(source);
    assert.ok(alias,'checked real materialize parser seam');
    const escaped=alias[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const signature=new RegExp(`function ${escaped}\\(([^,]+),([^)]*)\\)\\{`);
    const match=signature.exec(source);assert.ok(match,'real parser function exists');
    source=source.replace(signature,match[0]+`if(${match[2]}==="ppt/slides/slide48.xml"&&!window.__pptxReleaseTail){window.__pptxBlockedTailAttempts=(window.__pptxBlockedTailAttempts??0)+1;throw Error("PPTX test tail parser held")}`);
    source="(()=>{\n    const draw=CanvasRenderingContext2D.prototype.fillText;\n    CanvasRenderingContext2D.prototype.fillText=function(text,...args){\n     window.__pptxPaintBuffer=((window.__pptxPaintBuffer??'')+String(text)).slice(-3000);\n     if(window.__pptxPaintBuffer.includes('项目进展正常')&&!window.__pptxFirstPaint)window.__pptxFirstPaint={text:'项目进展正常',at:performance.timeOrigin+performance.now()};\n     return draw.call(this,text,...args);\n    };\n})();"+source;
    await route.fulfill({response,body:source});
   });
   await page.request.get(url+'reset');
   const original=new Uint8Array(await (await page.request.get(url+'source-bytes')).body());
   const start=Date.now();
   await page.goto(url+'?progressive=1');
   await page.locator('iframe').waitFor();const frame=page.frames().find(f=>f.parentFrame());
   await frame.waitForSelector('.stage-rel canvas');
   await frame.waitForFunction(()=>window.projectMindPptxViewCoverage?.()?.loadedSlides.includes(0)&&window.__pptxFirstPaint);
   const visible=Date.now()-start;
   // Let actual mount effects and thumbnail observers run before checking coverage.
   await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const coverage=await frame.evaluate(()=>window.projectMindPptxViewCoverage());
   assert.equal(coverage.totalSlides,48);assert.ok(!coverage.loadedSlides.includes(47),'App mount must not parse the far tail');
   console.log(name+': actual first canvas visible; '+JSON.stringify(coverage));
   const view=await page.evaluate(()=>window.officePptxHarness.model());
   const editTarget=async(id,text)=>{
    const previous=frame.locator('.slide-text-editor');if(await previous.count()){await previous.press('Escape');await previous.waitFor({state:'detached'});await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
    const el=view.slides[0].elements.find(e=>e.id===`slide-0:shape-${id}`);assert.ok(el);
    // Read the actual Konva hit canvas; source XML boxes can differ from
    // autofitted text geometry. This never asks getRenderSlides/full-tail layout.
    const point=await frame.evaluate(id=>{
     const stage=window.Konva.stages.find(s=>document.querySelector('.stage-rel')?.contains(s.container()));
     if(!stage)throw Error('Current real Canvas stage missing');
     stage.off('.acceptance');stage.on('mousedown.acceptance mouseup.acceptance click.acceptance dblclick.acceptance',e=>{(window.__pptxEvents??=[]).push({type:e.type,id:e.target.id(),point:stage.getPointerPosition(),x:e.evt.clientX,y:e.evt.clientY})});
     const group=stage.findOne('#node_e_'+id);if(!group)throw Error('Current rendered shape missing: '+id);
     const box=group.getClientRect({relativeTo:stage}),rect=stage.container().getBoundingClientRect();
     for(const fy of [.2,.4,.6,.8])for(const fx of [.1,.3,.5,.7,.9]){
      const x=box.x+box.width*fx,y=box.y+box.height*fy;let hit=stage.getIntersection({x,y});
      while(hit&&hit.id()!=='node_e_'+id)hit=hit.getParent();
      if(hit)return{x:rect.x+x*rect.width/stage.width(),y:rect.y+y*rect.height/stage.height()};
     }
     throw Error('No real Canvas hit inside target '+id+': '+JSON.stringify(box));
    },id);
    await frame.evaluate(({point,id})=>{(window.__pptxPoints??=[]).push({id,point,dom:document.elementFromPoint(point.x,point.y)?.outerHTML.slice(0,240),inert:document.querySelector('.stage-rel').inert,readOnly:document.body.dataset.readOnly})},{point,id});
    const frameBox=await page.locator('iframe').boundingBox();
    console.log(name+': point '+id+' '+JSON.stringify(await page.evaluate(({x,y})=>({x,y,hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,300),frames:[...document.querySelectorAll('iframe')].map(f=>({inert:f.inert,box:f.getBoundingClientRect().toJSON()}))}),{x:frameBox.x+point.x,y:frameBox.y+point.y})));
    await frame.evaluate(()=>{if(!window.__pptxDomEvents){window.__pptxDomEvents=[];for(const type of ['mousedown','mouseup','keydown'])document.addEventListener(type,e=>window.__pptxDomEvents.push({type,key:e.key,x:e.clientX,y:e.clientY,target:e.target.tagName}),true)}});
    await page.mouse.click(frameBox.x+point.x,frameBox.y+point.y);
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const input=frame.locator('.slide-text-editor');
    // A text hit opens directly; a shape/frame hit uses the editor's real F2 entry.
    if(!await input.count()){await frame.locator('body').evaluate(body=>{body.tabIndex=-1;body.focus()});await page.keyboard.press('F2')}
    await input.waitFor();assert.equal(await input.innerText(),view.textElements.find(e=>e.cNvPrId===id).text,'actual DOM overlay belongs to the intended shape');await input.fill(text);
   };
   const settleReceipt=async()=>{
    // The host React model commit and new epoch initialization happen after the
    // save Promise. Old iframe readonly=false alone is not the receipt barrier.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.locator('.editor-loading--overlay').waitFor({state:'detached'});
    await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');
    await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   };
   const inputStart=Date.now();
   await editTarget('5','真实 App 第一笔保存');
   const editResponseMs=Date.now()-inputStart;
   const editable=Date.now()-start;
   await writeFile(new URL(`progressive-${name}-firsteditable.json`,out),JSON.stringify({browser:name,firstContentMs:(await frame.evaluate(()=>window.__pptxFirstPaint)).at-start,firstEditableInputMs:editable,editResponseMs,coverage},null,2)+'\n');
   await page.evaluate(()=>window.officePptxHarness.save());
   await settleReceipt();
   // A separate shape makes dropping the first save observable.
   await editTarget('8','真实 App 第二笔保存');
   await page.evaluate(()=>window.officePptxHarness.save());
   await settleReceipt();
   const afterSave=await frame.evaluate(()=>window.projectMindPptxViewCoverage());
   assert.ok(!afterSave.loadedSlides.includes(47),'save receipts must not replace the lazy session with a parsed full deck');
   console.log(name+': two real App saves complete; '+JSON.stringify(afterSave));
   const model=await (await page.request.get(url+'model')).json();
   const text=id=>model.textElements.find(e=>e.slideIndex===0&&e.cNvPrId===id)?.text;
   assert.equal(text('5'),'真实 App 第一笔保存');assert.equal(text('8'),'真实 App 第二笔保存');
   assert.ok(model.textElements.some(e=>e.slideIndex===47&&e.text.includes('第48页原文。')));
   const final=new Uint8Array(await (await page.request.get(url+'bytes')).body());
   const before=await JSZip.loadAsync(original),after=await JSZip.loadAsync(final),changed=[];
   const names=zip=>Object.keys(zip.files).filter(p=>!zip.files[p].dir).sort();assert.deepEqual(names(after),names(before));
   for(const path of names(before)){
    const a=await before.file(path).async('nodebuffer'),b=await after.file(path).async('nodebuffer');
    if(!a.equals(b))changed.push(path);
   }
   assert.deepEqual(changed,['ppt/slides/slide1.xml']);
   assert.equal(await frame.evaluate(()=>window.__pptxBlockedTailAttempts??0),0,'real App mount/edit/save must not request blocked tail parser');
   // Demonstrate the trap really blocks full parsing, then release it and recover.
   await assert.rejects(frame.evaluate(()=>window.slidesApi.getRenderSlides()),/tail parser held/);
   await frame.evaluate(()=>{window.__pptxReleaseTail=true});
   assert.equal((await frame.evaluate(()=>window.slidesApi.getRenderSlides())).length,48);
   const paint=await frame.evaluate(()=>window.__pptxFirstPaint);
   await page.reload();await page.locator('iframe').waitFor();const reopenedFrame=page.frames().find(f=>f.parentFrame());await reopenedFrame.waitForSelector('.stage-rel canvas');
   await reopenedFrame.waitForFunction(()=>window.projectMindPptxViewCoverage?.()?.loadedSlides.includes(0));
   const reopened=await page.evaluate(()=>window.officePptxHarness.model());
   assert.equal(reopened.textElements.find(e=>e.cNvPrId==='5').text,'真实 App 第一笔保存');
   assert.equal(reopened.textElements.find(e=>e.cNvPrId==='8').text,'真实 App 第二笔保存');
   await writeFile(new URL(`progressive-${name}-content.json`,out),JSON.stringify({browser:name,tailParserHeldThroughBothSaves:true,fixtureBytes:original.length,slides:48,firstContentMs:paint.at-start,contentWitnessObservedMs:visible,firstEditableInputMs:editable,editResponseMs,paint,coverage,afterSave,archiveMs:view.coverage.archiveMs,xmlValidationMs:view.coverage.xmlValidationMs,changedParts:changed},null,2)+'\n');
   // Real status/ribbon/range/keyboard entrances and production wheel gesture handlers.
   const zoom=()=>reopenedFrame.evaluate(()=>window.__projectMindOfficePreview.capture().zoom);
   const waitZoom=value=>reopenedFrame.waitForFunction(value=>Math.abs(window.__projectMindOfficePreview.capture().zoom-value)<.001,value);
   const settle=()=>reopenedFrame.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));
   const restore=async value=>{await reopenedFrame.evaluate(value=>{const access=window.__projectMindOfficePreview;return access.restore({...access.capture(),zoom:value})},value);await waitZoom(Math.max(.5,Math.min(1.5,value)))};
   const slider=reopenedFrame.locator('.pm-status-zoom__range'),status=reopenedFrame.locator('.pm-status-zoom');
   assert.equal(await slider.getAttribute('min'),'50');assert.equal(await slider.getAttribute('max'),'150');
   await slider.press('Home');await waitZoom(.5);const lowWidth=await reopenedFrame.locator('.stage-rel').evaluate(el=>el.getBoundingClientRect().width);await slider.press('ArrowRight');await waitZoom(.51);
   await slider.press('End');await waitZoom(1.5);const highWidth=await reopenedFrame.locator('.stage-rel').evaluate(el=>el.getBoundingClientRect().width);assert.ok(Math.abs(highWidth/lowWidth-3)<.01,'real Canvas stage scales from 50% to 150%');await slider.press('ArrowLeft');await waitZoom(1.49);
   // Mouse input reaches a real intermediate slider value.
   const rangeBox=await slider.boundingBox();
   await page.mouse.click(rangeBox.x+rangeBox.width/2,rangeBox.y+rangeBox.height/2);
   await reopenedFrame.waitForFunction(()=>{const z=window.__projectMindOfficePreview.capture().zoom;return z>.9&&z<1.1});
   await restore(.5);
   for(let step=1;step<=10;step++){await status.getByRole('button',{name:'放大',exact:true}).click();await waitZoom(.5+step*.1)}
   assert.equal(await status.getByRole('button',{name:'放大',exact:true}).isDisabled(),true);
   await status.getByRole('button',{name:'放大',exact:true}).evaluate(button=>{button.click();button.click()});await waitZoom(1.5);
   for(let step=1;step<=10;step++){await status.getByRole('button',{name:'缩小',exact:true}).click();await waitZoom(1.5-step*.1)}
   assert.equal(await status.getByRole('button',{name:'缩小',exact:true}).isDisabled(),true);
   await status.getByRole('button',{name:'缩小',exact:true}).evaluate(button=>{button.click();button.click()});await waitZoom(.5);
   console.log(name+': range and repeated status button endpoints passed');
   await reopenedFrame.getByRole('button',{name:'视图',exact:true}).click();
   const ribbon=reopenedFrame.locator('.ribbon-body');
   for(const value of [.66,.75,1,1.5]){await ribbon.getByRole('button',{name:'放大',exact:true}).click();await waitZoom(value)}
   // Ribbon endpoint controls may be disabled or enabled no-ops depending on upstream presentation.
   await ribbon.getByRole('button',{name:'放大',exact:true}).evaluate(button=>{button.click();button.click()});await waitZoom(1.5);
   for(const value of [1,.75,.66,.5]){await ribbon.getByRole('button',{name:'缩小',exact:true}).click();await waitZoom(value)}
   await ribbon.getByRole('button',{name:'缩小',exact:true}).evaluate(button=>{button.click();button.click()});await waitZoom(.5);
   console.log(name+': repeated ribbon endpoints passed');
   await ribbon.getByRole('button',{name:'100%',exact:true}).click();await waitZoom(1);await restore(.5);
   // Focus the real iframe body so shortcuts do not target the range input.
   await reopenedFrame.locator('body').evaluate(body=>{body.tabIndex=-1;body.focus()});
   for(const value of [.66,.75,1,1.5,1.5]){await page.keyboard.press('Control+=');await waitZoom(value)}
   for(const value of [1,.75,.66,.5,.5]){await page.keyboard.press('Control+-');await waitZoom(value)}
   await page.keyboard.press('Control+0');await waitZoom(1);
   await page.keyboard.press('Meta+=');await waitZoom(1.5);await page.keyboard.press('Meta+-');await waitZoom(1);
   console.log(name+': keyboard shortcuts passed');
   await restore(.1);await restore(4);
   await reopenedFrame.getByRole('button',{name:'适应窗口',exact:true}).click();await settle();
   const fitZoom=await zoom();assert.ok(fitZoom>=.5&&fitZoom<=1.5);
   const fitGeometry=await reopenedFrame.evaluate(()=>{const viewport=document.querySelector('.stage-wrap'),paper=document.querySelector('.stage-rel');return{viewportWidth:viewport.clientWidth,viewportHeight:viewport.clientHeight,paperWidth:paper.offsetWidth,paperHeight:paper.offsetHeight,actualWidth:paper.getBoundingClientRect().width,actualHeight:paper.getBoundingClientRect().height}});
   const expectedFit=Math.max(.5,Math.min(1.5,(fitGeometry.viewportWidth-56)/fitGeometry.paperWidth,(fitGeometry.viewportHeight-72)/fitGeometry.paperHeight));
   assert.ok(Math.abs(fitZoom-expectedFit)<.002,'fit uses the real available viewport and paper dimensions');
   assert.ok(Math.abs(fitGeometry.actualWidth-fitGeometry.paperWidth*fitZoom)<2&&Math.abs(fitGeometry.actualHeight-fitGeometry.paperHeight*fitZoom)<2,'fit changes actual paper geometry');
   // Synthetic browser WheelEvents exercise the actual Ctrl/wheel and fractional
   // pinch classifier/preview/commit path. This does not claim physical hardware acceptance.
   const wheel=async(deltaY,metaKey=false,deltaMode=0)=>{
    await reopenedFrame.evaluate(({deltaY,metaKey,deltaMode})=>{const target=document.querySelector('.stage-rel'),r=target.getBoundingClientRect();target.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:!metaKey,metaKey,deltaY,deltaMode,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))},{deltaY,metaKey,deltaMode});await settle();
   };
   await restore(1);await wheel(-120);await waitZoom(1.1);await wheel(120);await waitZoom(1);
   await wheel(-3,true,1);await waitZoom(1.1);await wheel(3,true,1);await waitZoom(1);
   await restore(1.5);await wheel(-120);await waitZoom(1.5);await wheel(-1.25);await waitZoom(1.5);
   await restore(.5);await wheel(120);await waitZoom(.5);await wheel(1.25);await waitZoom(.5);
   await restore(1);await wheel(-1.25);const pinchUp=await zoom();assert.ok(pinchUp>1&&pinchUp<1.1);
   await wheel(1.25);await waitZoom(1);
   await restore(1);
   await page.evaluate(()=>window.officePptxHarness.setPresentationMode('preview'));
   await reopenedFrame.waitForFunction(()=>document.body.dataset.presentationMode==='preview'&&document.body.dataset.readOnly==='true');await settle();
   await restore(.1);await restore(4);await restore(.75);
   await page.evaluate(()=>window.officePptxHarness.setPresentationMode('edit'));
   await reopenedFrame.waitForFunction(()=>document.body.dataset.presentationMode==='edit'&&document.body.dataset.readOnly==='false');await settle();
   await restore(1);
   const zoomCoverage={rangeMin:50,rangeMax:150,canvasWidthAt50:lowWidth,canvasWidthAt150:highWidth,sliderKeyboardAndMouse:true,statusRepeatedEndpoints:true,ribbonRepeatedEndpoints:true,ribbon100Percent:true,previewModeRestoreBounds:true,keyboardCtrlAndMeta:true,fitZoom,fitGeometry,expectedFit,ctrlAndMetaWheel:true,pinchEvents:true,pinchUp,wheelAndPinchBounds:true,restoreBounds:true,numericScaleDialog:'not applicable (percentage span; slide insertion ZoomDialog is unrelated)'};
   assert.deepEqual(errors,[]);
   results.push({browser:name,tailParserHeldThroughBothSaves:true,fixtureBytes:original.length,slides:48,firstContentMs:paint.at-start,contentWitnessObservedMs:visible,firstEditableInputMs:editable,editResponseMs,paint,coverage,afterSave,archiveMs:view.coverage.archiveMs,xmlValidationMs:view.coverage.xmlValidationMs,zoomCoverage,changedParts:changed});
   await page.screenshot({path:fileURLToPath(new URL(`progressive-${name}.png`,out))});
   await writeFile(new URL(`progressive-${name}-result.json`,out),JSON.stringify(results.at(-1),null,2)+'\n');
   console.log(JSON.stringify(results.at(-1)));
  }catch(error){if(page)await writeFile(new URL(`progressive-${name}-failure.json`,out),JSON.stringify(await Promise.all(page.frames().map(f=>f.evaluate(()=>({url:location.href,coverage:window.projectMindPptxViewCoverage?.(),paint:window.__pptxFirstPaint,zoom:window.__projectMindOfficePreview?.capture(),paintBuffer:window.__pptxPaintBuffer,events:window.__pptxEvents,points:window.__pptxPoints,domEvents:window.__pptxDomEvents,active:document.activeElement?.outerHTML.slice(0,300),inertElements:[...document.querySelectorAll("[inert]")].map(el=>el.tagName+"."+el.className)})).catch(String))),null,2)).catch(()=>{});if(page)await page.screenshot({path:fileURLToPath(new URL(`progressive-${name}-failure.png`,out))}).catch(()=>{});throw error}finally{await browser.close()}
 }
}finally{await writeFile(new URL('progressive-results.json',out),JSON.stringify(results,null,2)+'\n');await server.close()}
