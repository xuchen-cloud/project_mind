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
  const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
  try{
   const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
   page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));
   await page.request.get(url+'reset');
   const original=new Uint8Array(await (await page.request.get(url+'source-bytes')).body());
   await page.addInitScript(()=>{
    const draw=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){
     window.__pptxPaintBuffer=((window.__pptxPaintBuffer??'')+String(text)).slice(-3000);
     if(window.__pptxPaintBuffer.includes('项目进展正常')&&!window.__pptxFirstPaint)window.__pptxFirstPaint={text:'项目进展正常',at:performance.timeOrigin+performance.now()};
     return draw.call(this,text,...args);
    };
   });
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
   const view=await (await page.request.get(url+'view-model')).json();
   const editTarget=async(id,text)=>{
    const el=view.slides[0].elements.find(e=>e.id===`slide-0:shape-${id}`);assert.ok(el);
    const point=await frame.evaluate(({size,offset})=>{const r=document.querySelector('.stage-rel').getBoundingClientRect();return{x:r.x+(offset.x+offset.cx*.1)*r.width/size.cx,y:r.y+(offset.y+offset.cy*.4)*r.height/size.cy}}, {size:view.size,offset:el.transform.offset});
    const frameBox=await page.locator('iframe').boundingBox();
    await page.mouse.dblclick(frameBox.x+point.x,frameBox.y+point.y);
    const input=frame.locator('.slide-text-editor');await input.waitFor();await input.fill(text);
   };
   const inputStart=Date.now();
   await editTarget('5','真实 App 第一笔保存');
   const editResponseMs=Date.now()-inputStart;
   const editable=Date.now()-start;
   await page.evaluate(()=>window.officePptxHarness.save());
   await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');
   // A separate shape makes dropping the first save observable.
   await editTarget('8','真实 App 第二笔保存');
   await page.evaluate(()=>window.officePptxHarness.save());
   await frame.waitForFunction(()=>document.body.dataset.readOnly==='false');
   const afterSave=await frame.evaluate(()=>window.projectMindPptxViewCoverage());
   assert.ok(!afterSave.loadedSlides.includes(47),'save receipts must not replace the lazy session with a parsed full deck');
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
   const paint=await frame.evaluate(()=>window.__pptxFirstPaint);
   await page.reload();await page.locator('iframe').waitFor();const reopenedFrame=page.frames().find(f=>f.parentFrame());await reopenedFrame.waitForSelector('.stage-rel canvas');
   await reopenedFrame.waitForFunction(()=>window.projectMindPptxViewCoverage?.()?.loadedSlides.includes(0));
   const reopened=await page.evaluate(()=>window.officePptxHarness.model());
   assert.equal(reopened.textElements.find(e=>e.cNvPrId==='5').text,'真实 App 第一笔保存');
   assert.equal(reopened.textElements.find(e=>e.cNvPrId==='8').text,'真实 App 第二笔保存');
   // Actual range input, +/- controls, ribbon presets/fit, wheel and restored views.
   const zoom=()=>reopenedFrame.evaluate(()=>window.__projectMindOfficePreview.capture().zoom);
   const waitZoom=value=>reopenedFrame.waitForFunction(value=>Math.abs(window.__projectMindOfficePreview.capture().zoom-value)<.001,value);
   const slider=reopenedFrame.locator('.pm-status-zoom__range');
   assert.equal(await slider.getAttribute('min'),'50');assert.equal(await slider.getAttribute('max'),'150');
   await slider.press('Home');await waitZoom(.5);assert.equal(await reopenedFrame.locator('.pm-status-zoom').getByRole('button',{name:'缩小',exact:true}).isDisabled(),true);
   await slider.press('End');await waitZoom(1.5);assert.equal(await reopenedFrame.locator('.pm-status-zoom').getByRole('button',{name:'放大',exact:true}).isDisabled(),true);
   const restore=async value=>{await reopenedFrame.evaluate(value=>{const access=window.__projectMindOfficePreview;return access.restore({...access.capture(),zoom:value})},value);await waitZoom(Math.max(.5,Math.min(1.5,value)))};
   await restore(1);await reopenedFrame.locator('.pm-status-zoom').getByRole('button',{name:'放大',exact:true}).click();await waitZoom(1.1);
   await reopenedFrame.locator('.pm-status-zoom').getByRole('button',{name:'缩小',exact:true}).click();await waitZoom(1);
   await restore(.1);await restore(4);
   await reopenedFrame.getByRole('button',{name:'视图',exact:true}).click();
   await reopenedFrame.locator('.ribbon-body').getByRole('button',{name:'缩小',exact:true}).click();
   await waitZoom(1);await reopenedFrame.locator('.ribbon-body').getByRole('button',{name:'放大',exact:true}).click();await waitZoom(1.5);
   await reopenedFrame.getByRole('button',{name:'适应窗口',exact:true}).click();
   await reopenedFrame.waitForFunction(()=>{const z=window.__projectMindOfficePreview.capture().zoom;return z>=.5&&z<=1.5});
   await reopenedFrame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const fitZoom=await zoom();
   await restore(1.5);await reopenedFrame.evaluate(()=>document.querySelector('.stage-rel').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-300})));await reopenedFrame.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));await waitZoom(1.5);
   await restore(.5);await reopenedFrame.evaluate(()=>document.querySelector('.stage-rel').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:300})));await reopenedFrame.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));await waitZoom(.5);
   await restore(1);
   const zoomCoverage={rangeMin:50,rangeMax:150,buttons:true,presets:true,fitZoom,wheelBounds:true,restoreBounds:true};
   assert.deepEqual(errors,[]);
   results.push({browser:name,fixtureBytes:original.length,slides:48,firstContentMs:paint.at-start,contentWitnessObservedMs:visible,firstEditableInputMs:editable,editResponseMs,paint,coverage,afterSave,archiveMs:view.coverage.archiveMs,xmlValidationMs:view.coverage.xmlValidationMs,zoomCoverage,changedParts:changed});
   await page.screenshot({path:fileURLToPath(new URL(`progressive-${name}.png`,out))});
   console.log(JSON.stringify(results.at(-1)));
  }finally{await browser.close()}
 }
}finally{await writeFile(new URL('progressive-results.json',out),JSON.stringify(results,null,2)+'\n');await server.close()}
