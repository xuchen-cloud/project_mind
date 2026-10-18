import {requestOutput} from './output-command.mjs';
/** Historical documents can output real bytes without gaining any editing authority. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import JSZip from 'jszip';
const fixture=await PDFDocument.create();fixture.addPage([360,504]);const pdf=Array.from(await fixture.save());
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of (process.env.OFFICE_BROWSER?[process.env.OFFICE_BROWSER]:['chromium','webkit'])){
 const b=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await b.newPage({viewport:{width:1440,height:1000}});await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');
  const original=Buffer.from(await(await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body());
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?readOnly&nativeExport&nativePdf&nativePrint');const f=page.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();
  await page.evaluate(bytes=>{window.exports=[];window.prints=[];window.officeDocxHarness.export=async file=>{window.exports.push({...file,bytes:Array.from(file.bytes)});return true;};window.renderPdf=async()=>new Uint8Array(bytes);window.officeDocxHarness.print=async doc=>{window.prints.push(doc);};},pdf);
  assert.equal(await body.getAttribute('contenteditable'),'false');
  const originalText=await body.innerText();await body.click();await page.keyboard.type('MUST_NOT_EDIT');assert.equal(await body.innerText(),originalText);
  assert.equal(await f.locator('.ribbon-body').evaluate(n=>!!n.closest('[inert]')),true,'editing tools remain inert');
  assert.equal(await f.locator('.pm-file-trigger,.pm-file-menu').count(),0,'File output belongs to the outer host');
  await requestOutput(page,'导出 HTML');await page.waitForFunction(()=>window.exports.length===1);assert.match(await page.evaluate(()=>new TextDecoder().decode(new Uint8Array(window.exports[0].bytes))),/中文文档往返验证/);
  await requestOutput(page,'导出 PDF');await page.waitForFunction(()=>window.exports.length===2);assert.equal(await page.evaluate(()=>window.exports[1].mime),'application/pdf');assert.deepEqual(await page.evaluate(()=>window.exports[1].bytes),pdf);
  await requestOutput(page,'导出图片');await page.waitForFunction(()=>window.exports.length===3,undefined,{timeout:15000});const zipFile=await page.evaluate(()=>window.exports[2]);assert.equal(zipFile.mime,'application/zip');assert.ok(Object.keys((await JSZip.loadAsync(new Uint8Array(zipFile.bytes))).files).some(n=>n.endsWith('.png')));
  await f.locator('.pv-toolbar').getByRole('button',{name:'关闭',exact:true}).click();await requestOutput(page,'打印…');const dialog=f.locator('.print-dialog');await dialog.waitFor();assert.equal(await dialog.evaluate(n=>!!n.closest('[inert]')),false);await dialog.getByLabel('自定义范围',{exact:true}).check();await dialog.locator('.print-range-input').fill('2');await dialog.getByRole('button',{name:'打印',exact:true}).click();await page.waitForFunction(()=>window.prints.length===1);const html=await page.evaluate(()=>window.prints[0].html);assert.match(html,/data-pv-page="1"/);assert.doesNotMatch(html,/<script|<button/);await dialog.waitFor({state:'hidden'});
  assert.equal(await body.getAttribute('contenteditable'),'false');assert.doesNotMatch(await body.innerText(),/MUST_NOT_EDIT/);assert.deepEqual(await page.evaluate(()=>window.officeDocxHarness.edits()),[]);assert.equal(await page.evaluate(()=>window.officeDocxHarness.pending()),false);assert.deepEqual(Buffer.from(await(await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body()),original);
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(false));await body.locator('xpath=self::*[@contenteditable="true"]').waitFor();assert.equal(await f.locator('.ribbon-body').evaluate(n=>n.inert),false);
  results.push({browser:kind,version:b.version(),readonlyHtmlPdfPngPrint:true,bodyAndToolsLocked:true,noEditsOrOriginalWrites:true});
 }finally{await b.close();}
}
await writeFile(new URL('output/browser/readonly-output-results.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
