/** Product scope: standard single-window playback stays; presenter/swap are not exposed. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href),url=process.env.OFFICE_ACCEPTANCE_URL;
const results=[];
for(const name of (process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit'])){
 const browser=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.request.get(url+'/reset');await page.goto(url);await page.locator('iframe').waitFor();
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForSelector('.stage-rel');
  await frame.getByRole('button',{name:'幻灯片放映',exact:true}).click();
  assert.equal(await frame.getByRole('button',{name:/演示者视图|演讲者视图|交换显示器/}).count(),0,'Excluded presenter/swap controls must not be rendered');
  await frame.getByRole('button',{name:'从头开始',exact:true}).click();
  await frame.locator('.ss-counter').filter({hasText:'1 / 3'}).waitFor();
  assert.equal(await frame.locator('.slideshow canvas').count()>0,true);
  await page.keyboard.press('ArrowRight');await frame.locator('.ss-counter').filter({hasText:'2 / 3'}).waitFor();
  await page.keyboard.press('ArrowLeft');await frame.locator('.ss-counter').filter({hasText:'1 / 3'}).waitFor();
  await page.keyboard.press('Escape');await frame.locator('.slideshow').waitFor({state:'detached'});
  await frame.locator('.thumb').nth(1).click();
  await frame.getByRole('button',{name:'从当前幻灯片开始',exact:true}).click();
  await frame.locator('.ss-counter').filter({hasText:'2 / 3'}).waitFor();
  assert.equal(await frame.locator('.presenter').count(),0);
  await page.keyboard.press('Escape');await frame.locator('.slideshow').waitFor({state:'detached'});
  assert.equal(await frame.locator('.thumb.active').evaluate(e=>Array.from(e.parentElement.children).filter(n=>n.classList.contains('thumb')).indexOf(e)),1);
  assert.deepEqual(errors,[]);
  results.push({browser:name,presenterControlsAbsent:true,normalFromBeginning:true,nextPrevious:true,normalFromCurrent:true,escapeReturnsToEditor:true,sameIframe:true,errors});
  console.log(name+': ordinary slideshow start/current/next/previous/exit passed; presenter controls absent');
 }finally{await browser.close()}
}
const out=resolve(import.meta.dirname,'../output/playwright');await mkdir(out,{recursive:true});await writeFile(resolve(out,'slideshow-results.json'),JSON.stringify(results,null,2)+'\n');
