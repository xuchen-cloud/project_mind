/** Native receipt at real user paste/save seam; transport security lives in Rust tests. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import JSZip from 'jszip';
import {inspect,edit} from '../dist/engine.mjs';
const {chromium,webkit}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const browser=await(process.env.OFFICE_BROWSER==='webkit'?webkit.launch({headless:true}):chromium.launch({headless:true,channel:'chrome'}));
const base=process.env.OFFICE_ACCEPTANCE_URL,results=[];
const original=new Uint8Array(await readFile(new URL('fixtures/complex.original.docx',import.meta.url))),initial=await inspect(original);
const external=await inspect(await edit(original,[{type:'text',nodeId:'docx:2',text:'外部替换：新的真实文档。'}]));
const receipt={mime:'image/png',base64:initial.assets[0].dataUrl.split(',')[1]};
async function caret(page){const body=page.frameLocator('iframe').locator('.tiptap.doc-page');await body.waitFor();const p=body.locator('p[data-idx]').filter({hasText:'第三页保留'}).first();await p.scrollIntoViewIfNeeded();const r=await p.boundingBox();await page.mouse.move(r.x+1,r.y+2);await page.mouse.down();await page.mouse.move(r.x+r.width-2,r.y+r.height-2,{steps:8});await page.mouse.up();assert.match(await p.evaluate(()=>getSelection().toString()),/第三页保留/);await page.keyboard.press('ArrowRight');return body;}
async function paste(page){const body=await caret(page);await body.evaluate(n=>{const data=new DataTransfer();data.setData('text/html','<img src="https://no-cors-image.test/private-signed.png?token=fixture">');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});}
async function setup(page){await page.route('https://no-cors-image.test/**',route=>{throw Error('native failure must never fall back to browser fetch');});await page.addInitScript(receipt=>{
 window.imageCalls=[];window.fetchRemoteImage=url=>new Promise((resolve,reject)=>window.imageCalls.push({url,resolve:()=>resolve(receipt),reject:()=>reject({code:'blocked_target',message:'原生拒绝：图片目标不是公网地址。'})}));
 window.lifecycleFetchImage=(url,file)=>{window.imageFile=file;return window.fetchRemoteImage(url);};
},receipt);}
try{
 if(!process.env.OFFICE_IMAGE_CASE||process.env.OFFICE_IMAGE_CASE==='paste'){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);await page.request.post(base+'/reset');await page.goto(base+'/?nativeImage');await paste(page);
  await page.waitForFunction(()=>window.imageCalls.length===1,undefined,{timeout:1800});assert.equal(await page.evaluate(()=>window.officeDocxHarness.pending()),true);
  await page.evaluate(()=>{window.saveResult='pending';window.officeDocxHarness.save().then(model=>{window.savedModel=model;window.saveResult='done';},error=>window.saveResult=String(error));});
  assert.equal(await page.evaluate(()=>window.saveResult),'pending');await page.evaluate(()=>window.imageCalls[0].resolve());await page.waitForFunction(()=>window.saveResult!=='pending');assert.equal(await page.evaluate(()=>window.saveResult),'done');
  assert.equal((await page.evaluate(()=>window.savedModel.document.content)).filter(n=>n.type==='docProtected'&&n.attrs.blockType==='image').length,2);
  const zip=await JSZip.loadAsync(await(await page.request.get(base+'/bytes')).body());const media=await Promise.all(Object.keys(zip.files).filter(n=>/^word\/media\//.test(n)&&!zip.files[n].dir).map(n=>zip.files[n].async('nodebuffer')));assert(media.some(bytes=>bytes.equals(Buffer.from(receipt.base64,'base64'))));
  await page.reload();await page.frameLocator('iframe').locator('.tiptap.doc-page').waitFor();assert.equal(await page.frameLocator('iframe').locator('img.doc-protected-img').count(),2);
  await paste(page);await page.waitForFunction(()=>window.imageCalls.length===1);await page.evaluate(()=>{window.failedSave='pending';window.officeDocxHarness.save().then(()=>window.failedSave='unexpected success',error=>window.failedSave=error.message);window.imageCalls[0].reject();});
  await page.waitForFunction(()=>window.failedSave!=='pending');assert.equal(await page.evaluate(()=>window.failedSave),'原生拒绝：图片目标不是公网地址。');await page.getByRole('alert').filter({hasText:'原生拒绝：图片目标不是公网地址。'}).waitFor();
  assert.equal((await(await page.request.get(base+'/model')).json()).document.content.filter(n=>n.type==='docProtected'&&n.attrs.blockType==='image').length,2);
  // Native callback is still forbidden when the editing host changes to history.
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(true));await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.__projectMindDocxHost.locked);
  const count=await page.evaluate(()=>window.imageCalls.length);const denied=await page.frameLocator('iframe').locator('body').evaluate(async()=>{try{await window.desktop.fetchImage('https://no-cors-image.test/a.png');return 'allowed';}catch(error){return error.message;}});assert.match(denied,/只读|不可编辑/);assert.equal(await page.evaluate(()=>window.imageCalls.length),count);
  results.push({case:'native-paste',pendingSave:true,realDocxMediaAndReopen:true,exactNativeError:true,noBrowserFallback:true,readOnlyDenied:true});await page.close();
 }
 if(!process.env.OFFICE_IMAGE_CASE||process.env.OFFICE_IMAGE_CASE==='lifetime')for(const action of ['replace','dispose']){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);await page.addInitScript(initial=>window.lifecycleInitial=initial,initial);await page.goto(base+'/lifecycle');await paste(page);await page.waitForFunction(()=>window.imageCalls.length===1);
  await page.evaluate(()=>{window.oldSettings=document.querySelector('iframe').__projectMindDocxOptions;window.waiting='pending';window.lifecycle.flush().then(()=>window.waiting='unexpected success',error=>window.waiting=error.message);});
  assert.equal(await page.evaluate(()=>window.waiting),'pending');await page.evaluate(({action,external})=>action==='replace'?window.lifecycle.replace(external):window.lifecycle.dispose(),{action,external});await page.waitForFunction(()=>window.waiting!=='pending',undefined,{timeout:1200});assert.match(await page.evaluate(()=>window.waiting),/替换|关闭|失效/);
  if(action==='replace'){await page.frameLocator('iframe').locator('.tiptap.doc-page').waitFor();await page.evaluate(()=>window.lifecycle.flush());}
  const before=await page.evaluate(()=>window.lifecycle.events.length);const oldCall=await page.evaluate(async()=>{window.imageCalls[0].resolve();try{await window.oldSettings.onFetchImage('https://no-cors-image.test/new.png');return 'allowed';}catch(error){return error.message;}});assert.match(oldCall,/替换|关闭|失效/);await page.waitForTimeout(100);assert.deepEqual(await page.evaluate(before=>window.lifecycle.events.slice(before),before),[]);assert.equal(await page.evaluate(()=>window.imageCalls.length),1);
  if(action==='replace'){assert.match(await page.frameLocator('iframe').locator('.tiptap.doc-page').innerText(),/外部替换：新的真实文档/);await page.evaluate(()=>window.lifecycle.dispose());}
  results.push({case:action,oldWaitRejected:true,lateImageIgnored:true,staleCallbackDenied:true});await page.close();
 }
 if(!process.env.OFFICE_IMAGE_CASE||process.env.OFFICE_IMAGE_CASE==='readonly'){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);await page.request.post(base+'/reset');await page.goto(base+'/?nativeImage');await paste(page);await page.waitForFunction(()=>window.imageCalls.length===1);
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(true));await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.__projectMindDocxHost.locked);
  await page.evaluate(()=>{window.lockedSave='pending';window.officeDocxHarness.flush().then(()=>window.lockedSave='unexpected success',error=>window.lockedSave=error.message);window.imageCalls[0].resolve();});await page.waitForFunction(()=>window.lockedSave!=='pending');assert.match(await page.evaluate(()=>window.lockedSave),/只读|不可编辑/);await page.getByRole('alert').filter({hasText:/只读|不可编辑/}).waitFor();
  assert.equal(await page.frameLocator('iframe').locator('img.doc-protected-img').count(),1);assert.deepEqual(await page.evaluate(()=>window.officeDocxHarness.edits()),[]);results.push({case:'readonly-during-fetch',lateImageRejected:true,noMutation:true});await page.close();
 }
 const result={browser:browser.version(),cases:results};console.log(JSON.stringify(result));await writeFile(new URL(`output/browser/native-image-${process.env.OFFICE_BROWSER??'chromium'}${process.env.OFFICE_IMAGE_CASE?'-'+process.env.OFFICE_IMAGE_CASE:''}-results.json`,import.meta.url),JSON.stringify(result,null,2));
}finally{await browser.close();}
