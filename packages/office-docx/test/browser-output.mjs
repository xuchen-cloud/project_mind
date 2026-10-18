import {requestOutput} from './output-command.mjs';
/** User-facing output commands use real upstream HTML and paginated print, no visible OS dialogs. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const b=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await b.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();
 const p=body.locator('p[data-idx="3"]');await p.click();await page.keyboard.press('End');await page.keyboard.insertText('真实HTML导出内容');
 const [file]=await Promise.all([page.waitForEvent('download'),requestOutput(page,'导出 HTML')]);assert.match(file.suggestedFilename(),/\.html$/);const html=await readFile(await file.path(),'utf8');assert.match(await page.evaluate(html=>new DOMParser().parseFromString(html,'text/html').body.textContent,html),/真实HTML导出内容/);assert.match(await page.evaluate(html=>new DOMParser().parseFromString(html,'text/html').body.textContent,html),/分页后内容：第二页保留。/);assert.match(html,/<table/);assert.match(html,/<img/);assert.match(html,/style=/);assert.doesNotMatch(html,/class="ribbon|contenteditable=|<script/);assert.equal(await page.evaluate(()=>window.officeDocxHarness.edits().length),1,'export commits the live draft without saving the File');
 // Real context menu command downloads the original embedded PNG bytes.
 const model=await (await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/model')).json();const img=body.locator('img.doc-protected-img').first();await img.click({button:'right'});const imageDownload=page.waitForEvent('download');await f.getByRole('button',{name:/图片另存为/}).click();const imageFile=await imageDownload;assert.deepEqual(await readFile(await imageFile.path()),Buffer.from(model.assets[0].dataUrl.split(',')[1],'base64'));
 // This replaces only the OS output boundary. The actual upstream dialog,
 // paginator, custom range and print CSS remain real.
 await page.evaluate(()=>{const w=document.querySelector('iframe').contentWindow;w.print=()=>{window.printReceipt={pages:[...w.document.querySelectorAll('.pagination-preview .pv-page')].map(n=>({skip:n.classList.contains('pv-print-skip'),text:n.textContent})),printZoom:w.document.documentElement.style.getPropertyValue('--print-zoom')};};});
 await requestOutput(page,'打印…');const dlg=f.locator('.print-dialog');await dlg.waitFor();const print=dlg.getByRole('button',{name:'打印',exact:true});await print.waitFor();await f.getByLabel('自定义范围',{exact:true}).check();await dlg.locator('.print-range-input').fill('2');await print.click();await page.waitForFunction(()=>!!window.printReceipt);
 const receipt=await page.evaluate(()=>window.printReceipt);assert.ok(receipt.pages.length>=3);assert.equal(receipt.pages.filter(n=>!n.skip).length,1);assert.equal(receipt.pages[1].skip,false);await dlg.waitFor({state:'hidden'});assert.equal(await f.locator('.pagination-preview .pv-print-skip').count(),0,'range classes cleaned after print');
 assert.deepEqual(errors,[]);const result={browser:b.version(),htmlDownload:true,embeddedImageBytes:true,printDialogAndCustomRange:true,osPrintBoundaryStubbed:true,errors};console.log(JSON.stringify(result));await writeFile(new URL('output/browser/output-results.json',import.meta.url),JSON.stringify(result,null,2));
}finally{await b.close();}
