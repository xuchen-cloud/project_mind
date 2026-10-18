/** Real upstream object/layout commands and native-byte reopen, explicitly opt-in. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const name of ['chromium','webkit'].filter(n=>!process.env.OFFICE_BROWSER||process.env.OFFICE_BROWSER===n)){
 const b=await pw[name].launch({headless:true,...(name==='chromium'?{channel:'chrome'}:{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE})});const page=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 try{
  await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();
  let img=body.locator('img.doc-protected-img').first();await img.click();
  const before=await img.boundingBox(),handle=body.locator('.img-resize-handle-se').first();await handle.waitFor();let r=await handle.boundingBox();
  await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+60,r.y+r.height/2+30,{steps:10});await page.mouse.up();
  let model=await page.evaluate(()=>window.officeDocxHarness.save());let image=model.document.content.find(n=>n.type==='docProtected'&&n.attrs.blockType==='image');assert.ok(Math.abs(image.attrs.imageWidthPx-(before.width+60))<2);assert.ok(Math.abs(image.attrs.imageHeightPx-(before.height+30))<2);
  console.log(name,'image resize/save');
  await f.locator('.zoom-btn').last().click();await f.locator('.zoom-btn').last().click();assert.equal(await f.locator('.zoom-value').innerText(),'120%');
  await img.click();r=await handle.boundingBox();const oldWidth=image.attrs.imageWidthPx;await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+60,r.y+r.height/2+30,{steps:10});await page.mouse.up();
  model=await page.evaluate(()=>window.officeDocxHarness.save());image=model.document.content.find(n=>n.type==='docProtected'&&n.attrs.blockType==='image');assert.ok(Math.abs(image.attrs.imageWidthPx-(oldWidth+50))<2,'resize compensates the actual document zoom');
  await img.scrollIntoViewIfNeeded();r=await img.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+45,r.y+r.height/2+25,{steps:10});await page.mouse.up();
  model=await page.evaluate(()=>window.officeDocxHarness.save());image=model.document.content.find(n=>n.type==='docProtected'&&n.attrs.blockType==='image');assert.match(image.attrs.imageWrap,/square/);assert.ok(Number.isFinite(image.attrs.imageOffsetXEmu));
  console.log(name,'zoom + drag/save');
  const cell=body.locator('tr').nth(1).locator('td').first().locator('p');await cell.click();await f.getByRole('button',{name:'表格布局',exact:true}).click();
  const rowButton=f.getByRole('button',{name:'下方插入',exact:true});await rowButton.click();assert.equal(await body.locator('tr').count(),3);
  model=await page.evaluate(()=>window.officeDocxHarness.save());assert.equal(model.document.content.find(n=>n.type==='docTable').content.length,3);
  // Browser picker adaptation, selected through the real upstream Picture command.
  await body.locator('p[data-idx="3"]').click();await f.getByRole('button',{name:'插入',exact:true}).click();
  const chooser=page.waitForEvent('filechooser');await f.getByRole('button',{name:'图片',exact:true}).click();const input=await chooser;
  const png=Buffer.from(model.assets[0].dataUrl.split(',')[1],'base64');await input.setFiles({name:'本地图片.png',mimeType:'image/png',buffer:png});
  await body.locator('img.doc-protected-img').nth(1).waitFor();await page.waitForFunction(()=>!window.officeDocxHarness.pending());
  model=await page.evaluate(()=>window.officeDocxHarness.save());assert.equal(model.document.content.filter(n=>n.type==='docProtected'&&n.attrs.blockType==='image').length,2);
  console.log(name,'table row + picture insert/save');
  const header=f.locator('.page-hf-header').first();await header.dblclick();const hf=header.locator('.ProseMirror');await hf.waitFor();await hf.click();await page.keyboard.press('Meta+A');await page.keyboard.insertText(`${name}真实页眉修改`);
  await page.waitForFunction(()=>window.officeDocxHarness.pending());
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(true));await page.waitForFunction(()=>!document.querySelector('iframe').contentDocument.querySelector('.page-hf-edit-surface .ProseMirror[contenteditable="true"]'));
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(false));await header.dblclick();await hf.waitFor();await hf.click();await page.keyboard.press('Meta+A');await page.keyboard.insertText(`${name}真实页眉修改`);await page.waitForFunction(()=>window.officeDocxHarness.pending());
  // beforeSave commits the active nested editor without requiring a click outside.
  await page.evaluate(()=>window.officeDocxHarness.save());let bytes=await (await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body();let zip=await JSZip.loadAsync(bytes);assert.ok((await Promise.all(Object.keys(zip.files).filter(p=>/^word\/header.*xml$/.test(p)).map(p=>zip.file(p).async('string')))).some(xml=>xml.includes(`${name}真实页眉修改`)));
  console.log(name,'active header commit/save');
  await body.locator('p[data-idx="2"]').click();await f.getByRole('button',{name:'布局',exact:true}).click();await f.getByRole('button',{name:'纸张方向',exact:true}).click();await f.getByRole('button',{name:'横向',exact:true}).click();
  await page.evaluate(()=>window.officeDocxHarness.save());bytes=await (await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body();zip=await JSZip.loadAsync(bytes);assert.match(await zip.file('word/document.xml').async('string'),/w:orient="landscape"/);
  assert.deepEqual(errors,[]);const result={name,version:b.version(),pictureSelectionResize:true,zoomCoordinates:true,pictureDrag:true,browserPictureInsert:true,tableRowInsert:true,activeHeaderCommit:true,sectionOrientation:true,realDocxSaveReopen:true,errors};results.push(result);console.log(JSON.stringify(result));
 }catch(e){console.log(name,'ERRORS',errors);for(const frame of page.frames())try{console.log((await frame.locator('body').innerText({timeout:1000})).slice(-2000));}catch{}await page.screenshot({path:new URL(`output/browser/objects-${name}-failure.png`,import.meta.url).pathname});throw e;}
 finally{await b.close();}
}
await writeFile(new URL('output/browser/objects-results.json',import.meta.url),JSON.stringify(results,null,2));
