/** Real pointer regression: nested ribbon menus must escape scroll fades and canvas. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href);
const url=process.env.OFFICE_ACCEPTANCE_URL;
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:820,height:600}});page.setDefaultTimeout(3000);
  await page.request.get(url+'/reset');await page.goto(url);await page.locator('iframe').waitFor();
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');
  // Narrow ribbon fades are continuous and never mask anchored menu descendants.
  const ribbon=frame.locator('.ribbon-body');
  await frame.waitForFunction(()=>!!document.querySelector('.pm-ribbon-fades'));
  assert.equal(await ribbon.evaluate(e=>getComputedStyle(e).maskImage),'none');
  await ribbon.evaluate(e=>{e.scrollLeft=16});
  await frame.waitForFunction(()=>{const o=document.querySelector('.pm-ribbon-fades');const opacity=Number(getComputedStyle(o,'::before').opacity);return opacity>0&&opacity<1});
  await ribbon.evaluate(e=>{e.scrollLeft=e.scrollWidth});
  await frame.waitForFunction(()=>getComputedStyle(document.querySelector('.pm-ribbon-fades'),'::after').opacity==='0');
  await ribbon.evaluate(e=>{e.scrollLeft=0});
  await frame.waitForFunction(()=>getComputedStyle(document.querySelector('.pm-ribbon-fades'),'::before').opacity==='0');
  await frame.getByRole('button',{name:'幻灯片',exact:true}).click();
  await frame.locator('[data-tip="选择版式新建幻灯片"]').click();
  await frame.locator('.rb-layout-item').filter({hasText:'标题幻灯片'}).first().click();
  await frame.waitForFunction(()=>document.querySelectorAll('.thumb').length===4);
  assert.equal(await frame.locator('.thumb').count(),4);
  console.log(name+': real nested layout menu and new-slide insertion passed');
 }finally{await browser.close()}
}
