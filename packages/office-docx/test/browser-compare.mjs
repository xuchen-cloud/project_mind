/** Review -> Compare keeps the open File and uses the real local DOCX picker. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const {chromium}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),b=await chromium.launch({headless:true,channel:'chrome'});
try{
 const p=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(String(e)));await p.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await p.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=p.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();const before=await body.innerText();
 await f.getByRole('button',{name:'审阅',exact:true}).click();const [chooser]=await Promise.all([p.waitForEvent('filechooser',{timeout:5000}),f.getByRole('button',{name:'比较',exact:true}).click()]);await chooser.setFiles(new URL('fixtures/simple.original.docx',import.meta.url).pathname);await f.locator('.compare-pane').waitFor();assert.match(await f.locator('.compare-meta').innerText(),/simple.original.docx/);assert.ok(await f.locator('.compare-card').count()>0);assert.equal(await body.innerText(),before);assert.equal(await p.evaluate(()=>window.officeDocxHarness.edits().length),0);assert.deepEqual(errors,[]);const result={browser:b.version(),localDocxPicker:true,realParagraphComparison:true,fileUnchanged:true,errors};console.log(JSON.stringify(result));await writeFile(new URL('output/browser/compare-results.json',import.meta.url),JSON.stringify(result,null,2));
}finally{await b.close();}
