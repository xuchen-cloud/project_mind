/** User image paste must settle before File takes its real DOCX snapshot. */
import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {writeFile} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),b=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await b.newPage({viewport:{width:1440,height:1000}});await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();
 async function caretInParagraph(){const p=body.locator('p[data-idx]').filter({hasText:'第三页保留'}).first();await p.scrollIntoViewIfNeeded();const r=await p.boundingBox();await page.mouse.move(r.x+1,r.y+2);await page.mouse.down();await page.mouse.move(r.x+r.width-2,r.y+r.height-2,{steps:8});await page.mouse.up();assert.match(await p.evaluate(()=>getSelection().toString()),/第三页保留/);await page.keyboard.press('ArrowRight');assert.equal(await p.evaluate(n=>n.contains(getSelection().anchorNode)),true);}
 const initial=await(await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/model')).json(),png=Buffer.from(initial.assets[0].dataUrl.split(',')[1],'base64');let release;const gate=new Promise(r=>{release=r;});
 await page.route('https://word-image.test/picture.png',async route=>{await gate;await route.fulfill({contentType:'image/png',headers:{'access-control-allow-origin':'*'},body:png});});
 await caretInParagraph();
 await body.evaluate(n=>{const data=new DataTransfer();data.setData('text/html','<img src="https://word-image.test/picture.png">');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
 await page.waitForFunction(()=>window.officeDocxHarness.pending(),undefined,{timeout:2500});
 const save=page.evaluate(async()=>{window.pasteSaveDone=false;const model=await window.officeDocxHarness.save();window.pasteSaveDone=true;return model;});assert.equal(await page.evaluate(()=>window.pasteSaveDone),false);release();const saved=await save;
 assert.equal(saved.document.content.filter(n=>n.type==='docProtected'&&n.attrs.blockType==='image').length,2);assert.equal(await page.evaluate(()=>window.officeDocxHarness.pending()),false);
 await page.reload();await body.waitFor();assert.equal(await body.locator('img.doc-protected-img').count(),2);
 // Hold the real FileReader I/O boundary; beforeSave must also await the
 // interval before the image decoder/insert helper has even started.
 await caretInParagraph();await body.evaluate((n,bytes)=>{
  const Reader=window.FileReader;window.FileReader=class extends Reader{readAsDataURL(blob){window.FileReader=Reader;window.releaseFileRead=()=>super.readAsDataURL(blob);}};
  const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'clipboard.png',{type:'image/png'}));n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
 },Array.from(png));
 await page.waitForFunction(()=>window.officeDocxHarness.pending(),undefined,{timeout:2500});const bitmapSave=page.evaluate(()=>window.officeDocxHarness.save());await body.evaluate(()=>window.releaseFileRead());const bitmapModel=await bitmapSave;assert.equal(bitmapModel.document.content.filter(n=>n.type==='docProtected'&&n.attrs.blockType==='image').length,3);
 let releaseBad;const badGate=new Promise(r=>{releaseBad=r;});await page.route('https://word-image.test/bad.png',async route=>{await badGate;await route.fulfill({contentType:'text/html',headers:{'access-control-allow-origin':'*'},body:'not an image'});});
 await caretInParagraph();await body.evaluate(n=>{const data=new DataTransfer();data.setData('text/html','<img src="https://word-image.test/bad.png">');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});await page.waitForFunction(()=>window.officeDocxHarness.pending());
 const failedSave=page.evaluate(async()=>{try{await window.officeDocxHarness.save();return 'unexpected success';}catch(error){return String(error);}});releaseBad();assert.match(await failedSave,/图片|image/i);await page.getByRole('alert').filter({hasText:/图片|image/i}).waitFor();
 const result={browser:b.version(),remoteImagePaste:true,saveWaitsForFetchAndInsertion:true,fileReaderPaste:true,pasteFailureRejectsSave:true,realDocxReopen:true};console.log(JSON.stringify(result));await writeFile(new URL('output/browser/paste-results.json',import.meta.url),JSON.stringify(result,null,2));
}finally{await b.close();}
