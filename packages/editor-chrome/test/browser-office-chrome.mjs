/** Real three-editor renderers: one shared DOM/style, native zoom and narrow chrome. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkToolbarMenu} from './toolbar-menu-check.mjs';
const root=resolve(import.meta.dirname,'../../..'),out=process.env.OFFICE_EVIDENCE_DIR??resolve(root,'output/playwright/shared-chrome');await mkdir(out,{recursive:true});
const menusOnly=process.argv.includes('--menus-only');
const valuesOnly=process.argv.includes('--zoom-values-only');
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const {inspect}=await import(pathToFileURL(resolve(root,'packages/office-xlsx/dist/engine.mjs')).href);
const model=await inspect(await readFile(resolve(root,'packages/office-xlsx/tests/fixtures/complex.original.xlsx')));
const bundle=await readFile(resolve(root,'packages/office-xlsx/dist/browser.mjs')),css=await readFile(resolve(root,'packages/office-xlsx/dist/browser.css'));
const appCss=await readFile(resolve(root,'src/styles/app.css'),'utf8'),tokens=appCss.slice(appCss.indexOf(':root {'),appCss.indexOf('\n}\n',appCss.indexOf(':root {'))+2);
const html=`<!doctype html><style>${tokens}html,body,#editor{margin:0;height:100%}</style><link rel="stylesheet" href="/browser.css"><div id="editor"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],presentationMode:'edit',readOnly:false,onChange(){}};window.editor=mount(document.querySelector('#editor'),window.props);await window.editor.ready;window.ready=true</script>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const results=[];
try{for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{for(const format of process.env.OFFICE_FORMATS?.split(',')??['word','xlsx','ppt']){
  console.log(name+' '+format+': start');
  const page=await browser.newPage({viewport:{width:640,height:800}}),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(String(e)));
  if(format==='xlsx')await page.addInitScript(()=>Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,set(host){const attach=host.attach;host.attach=function(runtime){window.zoomRuntime=runtime;return attach(runtime)};Object.defineProperty(window,'__projectMindSheetsHost',{value:host,writable:true,configurable:true})}}));
  await page.goto(format==='word'?process.env.OFFICE_DOCX_URL+'/presentation':format==='ppt'?process.env.OFFICE_PPTX_URL:`http://127.0.0.1:${server.address().port}`);
  await page.locator('iframe').waitFor();const f=page.frames().find(f=>f.parentFrame()===page.mainFrame());
  await f.locator('.pm-status-zoom').waitFor();
  if(format==='word'){await f.locator('.tiptap.doc-page').waitFor();await page.evaluate(()=>window.presentation.set('edit'));}
  if(format==='xlsx'){await page.waitForFunction(()=>window.ready);await f.locator('.xlsx-print-visual img').first().waitFor();}
  if(format==='ppt'){await f.locator('.stage-rel').waitFor();await page.addStyleTag({content:'button[aria-label="主 File 保存"],input[aria-label="宿主其他输入"]{display:none!important}'})}
  if(menusOnly){
   let menu,tabs;try{
    await page.setViewportSize({width:490,height:800});
    // Excel's real tab buttons intentionally have no .ribbon-tab alias.
    const tabSelector='.pm-editor-ribbon .ribbon-tabs .ribbon-tab,.pm-editor-header>.ribbon-tabs>button:not(.qa-btn)';
    const readTabs=()=>f.evaluate(selector=>{
     const color=token=>{const probe=document.createElement('span');probe.style.color=`var(${token})`;document.body.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result};
     return{accent:color('--editor-chrome-accent'),text:color('--editor-chrome-text'),items:[...document.querySelectorAll(selector)].filter(el=>el.textContent.trim()&&el.getBoundingClientRect().width).map(el=>{
      const s=getComputedStyle(el),indicator=getComputedStyle(el,'::after'),r=el.getBoundingClientRect();
      return{label:el.textContent.trim(),className:el.className,active:el.matches('.active,.on'),width:r.width,height:r.height,fontSize:s.fontSize,fontWeight:s.fontWeight,fontStyle:s.fontStyle,lineHeight:s.lineHeight,color:s.color,nowrap:s.whiteSpace,borderInline:parseFloat(s.borderLeftWidth)+parseFloat(s.borderRightWidth),indicator:{content:indicator.content,width:parseFloat(indicator.width),height:parseFloat(indicator.height),left:indicator.left,right:indicator.right,bottom:indicator.bottom,color:indicator.backgroundColor}};
     })};
    },tabSelector);
    const states=[];
    for(const label of ['插入','开始']){
     // Switch to a different tab: pressing an already active tab collapses upstream ribbons.
     await f.locator(tabSelector).filter({hasText:new RegExp('^'+label+'$')}).click();
     await f.waitForFunction(({selector,label})=>[...document.querySelectorAll(selector)].some(el=>el.textContent.trim()===label&&el.matches('.active,.on')),{selector:tabSelector,label});
     await page.mouse.move(0,500);
     const state=await readTabs();assert.ok(state.items.length>=5,format+': real tabs must be collected');
     assert.equal(state.items.filter(tab=>tab.active).length,1,JSON.stringify(state));
     for(const tab of state.items){
      const message=format+' '+label+' '+JSON.stringify(tab);
      assert.equal(tab.height,28,message);assert.equal(tab.fontSize,'13px',message);assert.equal(tab.fontStyle,'normal',message);assert.equal(tab.lineHeight,'18px',message);assert.equal(tab.nowrap,'nowrap',message);
      assert.equal(tab.fontWeight,tab.active?'600':'400',message);assert.equal(tab.color,tab.active?state.accent:state.text,message);
      if(tab.active){
       assert.ok(!['none','normal'].includes(tab.indicator.content),message);assert.equal(tab.indicator.height,2,message);
       assert.ok(tab.indicator.width>0&&Math.abs(tab.indicator.width-(tab.width-tab.borderInline-16))<.5,message);
       assert.equal(tab.indicator.left,'8px',message);assert.equal(tab.indicator.right,'8px',message);assert.equal(tab.indicator.bottom,'0px',message);assert.equal(tab.indicator.color,state.accent,message);
      }else assert.ok(['none','normal'].includes(tab.indicator.content),message);
     }
     states.push({selected:label,...state});
    }
    tabs=states;
    menu=await checkToolbarMenu(page,f,format,resolve(out,`${name}-${format}-490-menu.png`));
   }
   catch(error){await page.screenshot({path:resolve(out,`${name}-${format}-490-failed.png`)});await writeFile(resolve(out,`${name}-${format}-failed.txt`),await f.locator('body').innerText());throw error;}
   assert.deepEqual(errors,[]);results.push({browser:name,format,tabs,menu,errors});
   console.log(name+' '+format+': 490px native active/normal tabs (13px/28px/400/600/accent/2px indicator), real toolbar menu in viewport, hit-tested option, native action and close passed');await page.close();continue;
  }
  const zoom=f.locator('.pm-status-zoom'),slider=zoom.locator('input');
  const set=async value=>{await slider.evaluate((e,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,String(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},value);await f.waitForFunction(v=>document.querySelector('.zoom-value').textContent.trim()===`${v}%`,value);};
  const metric=()=>f.evaluate(format=>{
   if(format==='word')return{zoom:parseFloat(getComputedStyle(document.querySelector('.doc-zoom')).zoom),width:document.querySelector('.tiptap.doc-page').getBoundingClientRect().width};
   if(format==='xlsx')return{zoom:window.zoomRuntime.univerAPI.getActiveWorkbook().getActiveSheet().getZoom(),width:document.querySelector('.xlsx-print-visual img').getBoundingClientRect().width};
   return{zoom:Number(document.querySelector('.zoom-slider').value)/100,width:document.querySelector('.stage-rel').getBoundingClientRect().width};
  },format);
  const settle=()=>f.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  if(valuesOnly){
   await page.setViewportSize({width:490,height:800});await set(100);await settle();const before=await metric(),values=[];
   for(const value of [72,49]){
    await set(value);await settle();const actual=await metric();
    assert.equal(await slider.inputValue(),String(value));assert.equal(await slider.getAttribute('step'),'1');
    assert.equal(await slider.getAttribute('aria-valuetext'),`${value}%`);assert.ok(Math.abs(actual.zoom-value/100)<.001);
    assert.ok(Math.abs(actual.width/before.width-value/100)<.02,format+': non-notch canvas scale');values.push({value,actual});
   }
   await page.screenshot({path:resolve(out,`${name}-${format}-490-exact-zoom.png`)});
   assert.deepEqual(errors,[]);results.push({browser:name,format,values,errors});console.log(name+' '+format+': exact 72%/49% range, AX and native canvas scale passed');await page.close();continue;
  }
  const widths=[];
  for(const width of [490,640,1440]){
   await page.setViewportSize({width,height:800});await settle();await set(100);await settle();
   const geometry=await zoom.evaluate(e=>{
    const pick=n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return{width:r.width,height:r.height,margin:s.margin,padding:s.padding,border:s.borderWidth,font:s.fontSize,line:s.lineHeight,appearance:s.appearance,color:s.color,background:s.backgroundColor}};
    const status=e.closest('.pm-editor-status'),s=getComputedStyle(status),r=status.getBoundingClientRect();
    return{markup:[...e.children].map(n=>({tag:n.tagName,cls:n.className,label:n.getAttribute('aria-label'),svg:n.querySelector('path')?.getAttribute('d')})),root:pick(e),controls:[...e.children].map(pick),gap:getComputedStyle(e).gap,status:{height:r.height,font:s.fontSize,padding:s.padding,background:s.backgroundColor,border:s.borderTopColor},within:e.getBoundingClientRect().right<=innerWidth,statusScroll:status.scrollWidth,statusWidth:status.clientWidth};
   });
   assert.equal(geometry.status.height,28);assert.equal(geometry.status.font,'12px');assert.equal(geometry.gap,'4px');assert.equal(geometry.within,true,format+width);assert.ok(geometry.statusScroll<=geometry.statusWidth,JSON.stringify(geometry));
   assert.deepEqual(geometry.controls.map(c=>[c.width,c.height]),[[24,24],[100,24],[24,24],[44,24]]);
   const before=await metric();await zoom.getByRole('button',{name:'放大',exact:true}).click();await f.waitForFunction(()=>document.querySelector('.zoom-value').textContent.trim()==='110%');await settle();
   const after=await metric();assert.ok(Math.abs(after.zoom-1.1)<.001,format+': native zoom');assert.ok(Math.abs(after.width/before.width-1.1)<.02,format+': actual document/visual/canvas scales '+JSON.stringify({before,after}));
   await zoom.getByRole('button',{name:'缩小',exact:true}).click();await f.waitForFunction(()=>document.querySelector('.zoom-value').textContent.trim()==='100%');
   // Native range updates, not a component-only echo.
   await set(130);await settle();assert.ok(Math.abs((await metric()).zoom-1.3)<.001);await set(100);
   const bar=await f.locator('.pm-editor-status').boundingBox(),offset=await page.locator('iframe').boundingBox();await page.screenshot({path:resolve(out,`${name}-${format}-${width}-status.png`),clip:{x:offset.x+bar.x,y:offset.y+bar.y,width:bar.width,height:bar.height}});
   await page.screenshot({path:resolve(out,`${name}-${format}-${width}.png`)});
   widths.push({width,geometry,before,after});
  }
  // The same percent button retains Word/Excel native zoom dialogs.
  if(format!=='ppt'){await zoom.locator('.zoom-value').click();await f.locator('.zoom-dialog').waitFor();await f.locator('.zoom-dialog').getByRole('button',{name:'取消',exact:true}).click();}
  await slider.press('Home');await settle();assert.equal(await slider.inputValue(),'10');assert.equal(await zoom.getByRole('button',{name:'缩小',exact:true}).isDisabled(),true);
  await slider.press('End');await settle();assert.equal(await slider.inputValue(),format==='word'?'500':'400');assert.equal(await zoom.getByRole('button',{name:'放大',exact:true}).isDisabled(),true);
  await set(100);
  // Real shared chrome roots; all original tab labels stay on one line.
  const chrome=await f.evaluate(()=>({roots:document.querySelectorAll('.pm-editor-ribbon,.pm-editor-header').length,tabs:[...document.querySelectorAll('.ribbon-tab')].filter(n=>n.getBoundingClientRect().width).map(n=>({height:n.getBoundingClientRect().height,nowrap:getComputedStyle(n).whiteSpace})),toolbar:[...document.querySelectorAll('.pm-editor-ribbon .ribbon-body,.pm-editor-ribbon[data-ribbon-body]')].filter(n=>n.getBoundingClientRect().width).map(n=>({height:n.getBoundingClientRect().height,overflow:getComputedStyle(n).overflowX}))}));
  assert.ok(chrome.roots>0);assert.ok(chrome.tabs.every(t=>t.height===28&&t.nowrap==='nowrap'));assert.ok(chrome.toolbar.every(t=>t.height===80&&t.overflow==='scroll'));assert.deepEqual(errors,[]);
  results.push({browser:name,format,widths,chrome,errors});console.log(name+' '+format+': shared DOM/style, native range/buttons/dialog/bounds and 490/640/1440 canvas scale passed');await page.close();
 }}finally{await browser.close()}
}
// Structure and all zoom dimensions must match across actual formats and widths.
if(!menusOnly&&!valuesOnly){const baseline=results[0].widths[0].geometry;
for(const result of results)for(const {geometry}of result.widths){assert.deepEqual(geometry.markup,baseline.markup);assert.deepEqual(geometry.controls.map(({color,background,...rest})=>rest),baseline.controls.map(({color,background,...rest})=>rest));}}
await writeFile(resolve(out,menusOnly?`menus-${process.env.OFFICE_FORMATS??'all'}-results.json`:valuesOnly?`zoom-values-${process.env.OFFICE_FORMATS??'all'}-results.json`:'results.json'),JSON.stringify(results,null,2)+'\n');
}finally{await new Promise(r=>server.close(r))}
