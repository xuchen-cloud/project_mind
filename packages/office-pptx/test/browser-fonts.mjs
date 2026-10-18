/** Authorized real font bytes → exact upstream layout → export/save/reload. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PDFDocument} from 'pdf-lib';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const results=[];
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.request.get(url+'/reset');
  const prepared=await page.request.post(url+'/save',{data:{edits:[
   {kind:'command',name:'slides:edit-text',args:[{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'iiiiiiiiiiiiiiiiiiii WWWWWWWW iiiiiiiiii WWWWWWWW',fontFamily:'Caladea',fontSize:24}]}]}]},
   {kind:'command',name:'slides:edit-transform',args:[{slideIndex:0,sourceId:'e_5',fitWidthPx:1280,xPx:100,yPx:100,wPx:240,hPx:200}]},
   {kind:'command',name:'slides:set-text-body-props',args:[{slideIndex:0,sourceId:'e_5',props:{wrap:true,autofit:'none'}}]},
  ]}});assert.equal(prepared.ok(),true);const source=await prepared.json();
  await page.goto(url);await page.locator('iframe').waitFor();let frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');
  const node=f=>f.evaluate(async()=>(await window.slidesApi.getRenderSlides())[0].nodes.find(n=>n.sourceId==='e_5'));
  const before=await node(frame),lines=n=>n.text.lines.map(l=>l.runs.map(r=>r.text).join(''));
  const fixture=await PDFDocument.create();for(let i=0;i<3;i++)fixture.addPage([source.size.cx/12700,source.size.cy/12700]);await page.evaluate(bytes=>{window.officePptxHarness.setPdfFixture(bytes);window.officePptxHarness.setExportMode('write')},[...await fixture.save()]);
  // Hold a real FontFace load so export must wait before it bakes SVG positions.
  await frame.evaluate(()=>{const original=FontFace.prototype.load;const gate=new Promise(resolve=>{window.__releaseMetricsFont=resolve});FontFace.prototype.load=function(){if(this.family.replaceAll('"','')==='Caladea'){window.__metricsFontLoading=true;return gate.then(()=>original.call(this))}return original.call(this)}});
  const chooser=page.waitForEvent('filechooser');const installing=frame.evaluate(()=>window.slidesApi.fontInstallLocal());installing.catch(()=>{});
  await(await chooser).setFiles(resolve(import.meta.dirname,'../vendor/apps/docs/src/renderer/fonts/Caladea-Regular.ttf'));await frame.waitForFunction(()=>window.__metricsFontLoading);
  await page.evaluate(()=>{window.metricsExport=window.officePptxHarness.output('pdf')});await frame.getByText('正在导出 PDF…',{exact:false}).waitFor();
  await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.evaluate(()=>window.officePptxHarness.pdfRequests().length),0);assert.equal(await page.evaluate(()=>window.officePptxHarness.exports().length),0);
  await frame.evaluate(()=>window.__releaseMetricsFont());assert.deepEqual((await installing).families,['Caladea']);await page.evaluate(()=>window.metricsExport);await page.waitForFunction(()=>window.officePptxHarness.exports().length===1);
  const after=await node(frame);assert.notDeepEqual(lines(after),lines(before));assert.equal(await frame.evaluate(()=>document.fonts.check('16px Caladea')),true);
  const vector=await page.evaluate(()=>window.officePptxHarness.pdfRequests()[0]);assert.deepEqual(vector.pageSize,{widthPt:source.size.cx/12700,heightPt:source.size.cy/12700});assert.match(vector.html,/@font-face\{font-family:"Caladea";src:url\(data:font\/ttf;base64,/);
  // Merely loading/layouting fonts is not an edit: native save receives no candidate.
  await page.evaluate(()=>window.officePptxHarness.flush());assert.deepEqual(await page.evaluate(()=>window.officePptxHarness.edits()),[]);const unchanged=await page.evaluate(()=>window.officePptxHarness.save());assert.equal(unchanged.sourceBase64,source.sourceBase64);assert.equal(unchanged.originalHash,source.originalHash);
  await page.reload();await page.locator('iframe').waitFor();frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');const reloaded=await node(frame);assert.deepEqual(reloaded.text,after.text);assert.ok((await frame.evaluate(()=>window.slidesApi.fontCatalog())).some(f=>f.family==='Caladea'&&f.installed));
  const offset=await page.locator('iframe').boundingBox(),point=await frame.evaluate(async()=>{const s=(await window.slidesApi.getRenderSlides())[0],n=s.nodes.find(n=>n.sourceId==='e_5'),r=document.querySelector('.stage-rel').getBoundingClientRect(),z=r.width/s.widthPx;return {x:r.x+(n.box.x+n.box.w*.1)*z,y:r.y+(n.box.y+n.text.insets.t+12)*z}});
  await page.mouse.dblclick(offset.x+point.x,offset.y+point.y);await frame.locator('.slide-text-editor').fill('Caladea 编辑后保存');const edited=await page.evaluate(()=>window.officePptxHarness.save());const text=edited.textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5');assert.equal(text.text,'Caladea 编辑后保存');assert.equal(text.originalRichText.paragraphs[0].runs[0].fontFamily,'Caladea');assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(import.meta.dirname,`../output/playwright/pptx-${name}-font-metrics.png`)});
  results.push({browser:name,realCaladea:true,beforeLines:lines(before),afterLines:lines(after),fontReadinessBeforeSvg:true,indexedDbRelayout:true,sourceBytesUnchanged:true,editedNativeSave:true,pageSize:vector.pageSize,errors});console.log(name+': exact Caladea reflow, export wait, reload, unchanged source and edited native save passed');
 }finally{await browser.close()}
}
await writeFile(resolve(import.meta.dirname,'../output/playwright/font-results.json'),JSON.stringify(results,null,2)+'\n');
