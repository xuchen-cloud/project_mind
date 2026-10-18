/** Current output controls at wide/narrow sizes, with actual pointer targets. */
import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of ['chromium','webkit']){
 const b=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await b.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe');await f.locator('.tiptap.doc-page').waitFor();
  const tabs=f.locator('.ribbon-tabs');
  async function layout(){return tabs.evaluate(n=>{
   const strip=n.getBoundingClientRect(),buttons=[...n.querySelectorAll('.ribbon-tab')].filter(b=>getComputedStyle(b).display!=='none').map(b=>{const r=b.getBoundingClientRect(),visible=r.left>=strip.left&&r.right<=strip.right;return{text:b.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible,nowrap:getComputedStyle(b).whiteSpace==='nowrap',hit:!visible||document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b};});
   const body=document.querySelector('.ribbon-body').getBoundingClientRect();return{strip:{left:strip.left,right:strip.right,top:strip.top,bottom:strip.bottom},bodyTop:body.top,max:n.scrollWidth-n.clientWidth,scroll:n.scrollLeft,buttons};
  });}
  function valid(l){assert.ok(l.strip.bottom<=l.bodyTop+1,'tab strip does not cover ribbon body');for(let i=1;i<l.buttons.length;i++)assert.ok(l.buttons[i].left>=l.buttons[i-1].right-1,'buttons do not overlap');assert.ok(l.buttons.every(b=>b.hit),'visible button center is clickable');assert.ok(l.buttons.every(b=>b.nowrap),'tab labels stay on one line inside read-only wrapper');}
  const wide=await layout();valid(wide);assert.equal(wide.buttons.filter(b=>['导出 PDF','导出图片','导出 HTML','打印…'].includes(b.text)&&b.visible).length,4);
  await page.screenshot({path:new URL(`output/browser/output-layout-${kind}-wide.png`,import.meta.url).pathname});
  await page.setViewportSize({width:480,height:800});await tabs.evaluate(n=>{n.scrollLeft=0;});const narrow=await layout();valid(narrow);assert.ok(narrow.max>128);
  await page.screenshot({path:new URL(`output/browser/output-layout-${kind}-narrow-start.png`,import.meta.url).pathname});
  const fade=await tabs.evaluate(async n=>{n.scrollLeft=16;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=n.getBoundingClientRect(),edge=[...document.querySelectorAll('.office-docx-scroll-edge--left')].find(e=>Math.abs(parseFloat(e.style.top)-box.top)<1&&Math.abs(parseFloat(e.style.height)-n.clientHeight)<1);return Number(edge?.dataset.opacity);});assert.equal(fade,.25);
  await tabs.getByRole('button',{name:'视图',exact:true}).scrollIntoViewIfNeeded();const end=await layout();valid(end);assert.ok(end.buttons.find(b=>b.text==='视图').visible);
  await page.screenshot({path:new URL(`output/browser/output-layout-${kind}-narrow-end.png`,import.meta.url).pathname});
  results.push({browser:kind,version:b.version(),wide,narrow,end,continuousFade16px:fade,reducedMotion:true});
 }finally{await b.close();}
}
await writeFile(new URL('output/browser/output-layout-results.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({browser,version,continuousFade16px})=>({browser,version,allFourButtons:true,wideNarrowNoOverlap:true,continuousFade16px}))));
