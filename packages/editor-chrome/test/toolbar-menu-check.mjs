import assert from 'node:assert/strict';

/** Real anchored panels must escape the 80px scrolling ribbon, including hit testing. */
export async function checkToolbarMenu(page,frame,format,screenshot){
 await page.setViewportSize({width:490,height:800});
 let menu,option,before;
 if(format==='word'){
  await frame.locator('.tiptap.doc-page p').first().click();
  await frame.locator('.rb-split-wrap').filter({has:frame.locator('.rb-font-size')}).locator('button.rb-combo-caret').click();
  menu=frame.locator('.rb-font-size-menu');
  option=menu.getByRole('button',{name:'20',exact:true});
 }else if(format==='xlsx'){
  await frame.locator('.menu-select').filter({has:frame.locator('.font-size')}).locator('.menu-select-caret').click();
  menu=frame.locator('.menu-select-drop');
  option=menu.getByRole('option',{name:'18',exact:true});
 }else{
  before=await frame.locator('.thumb').count();
  const home=frame.getByRole('button',{name:'开始',exact:true});
  // Pressing the already active upstream tab intentionally collapses its band.
  if(!await home.evaluate(el=>el.classList.contains('active')))await home.click();
  await frame.getByRole('button',{name:'幻灯片',exact:true}).click();
  await frame.locator('[data-tip="选择版式新建幻灯片"]').click();
  menu=frame.locator('.rb-layout-panel');
  option=menu.locator('.rb-layout-item').filter({hasText:'标题幻灯片'}).first();
 }
 await menu.waitFor({state:'visible'});await option.scrollIntoViewIfNeeded();
 await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const geometry=await menu.evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,viewport:{width:innerWidth,height:innerHeight},position:getComputedStyle(el).position}});
 assert.ok(geometry.x>=0&&geometry.y>=0&&geometry.right<=geometry.viewport.width+1&&geometry.bottom<=geometry.viewport.height+1,JSON.stringify(geometry));
 const hit=await option.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,front=document.elementFromPoint(x,y);return{inFront:el.contains(front),x,y,front:front?.outerHTML.slice(0,500),ancestors:[...function*(n){while(n){yield n;n=n.parentElement}}(el)].map(n=>{const s=getComputedStyle(n);return{tag:n.tagName,cls:n.className,overflow:s.overflow,position:s.position,zIndex:s.zIndex,transform:s.transform,contain:s.contain}})}});
 await page.screenshot({path:screenshot});
 assert.equal(hit.inFront,true,format+': option must not be clipped/covered '+JSON.stringify(hit));
 await option.click();await menu.waitFor({state:'detached'});
 if(format==='ppt')await frame.waitForFunction(n=>document.querySelectorAll('.thumb').length===n,before+1);
 else await frame.waitForFunction(format=>{
  const input=document.querySelector(format==='word'?'.rb-font-size':'.font-size input');
  return input?.value===(format==='word'?'20':'18');
 },format);
 return{width:490,geometry,hit,action:format==='ppt'?'add-title-slide':format==='word'?'font-size:20':'font-size:18',closed:true};
}
