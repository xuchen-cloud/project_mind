/** Real table border drag, row selection, merge/split and OOXML saves. */
import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {writeFile} from 'node:fs/promises';import JSZip from 'jszip';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of ['chromium','webkit']){
 const b=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await b.newPage({viewport:{width:1440,height:1000}});await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe'),body=f.locator('.tiptap.doc-page');await body.waitFor();const table=body.locator('table').first(),cell=table.locator('tr').first().locator('td').first();await cell.click();
  const before=await cell.boundingBox();await page.mouse.move(before.x+before.width-1,before.y+before.height/2);await page.mouse.down();await page.mouse.move(before.x+before.width+39,before.y+before.height/2,{steps:10});await page.mouse.up();
  const after=await cell.boundingBox();assert.ok(after.width-before.width>30,'real column border drag widens the first column');let model=await page.evaluate(()=>window.officeDocxHarness.save());const savedTable=model.document.content.find(n=>n.type==='docTable');assert.ok(savedTable.content[0].content[0].attrs.colwidth[0]>before.width+30);
  await cell.click();await f.getByRole('button',{name:'表格布局',exact:true}).click();await f.getByRole('button',{name:'选择',exact:true}).click();await f.getByRole('button',{name:'选择行',exact:true}).click();await f.getByRole('button',{name:'合并单元格',exact:true}).click();assert.equal(await table.locator('tr').first().locator('td').count(),1);
  model=await page.evaluate(()=>window.officeDocxHarness.save());let zip=await JSZip.loadAsync(Buffer.from(model.sourceBase64,'base64'));assert.match(await zip.file('word/document.xml').async('string'),/<w:gridSpan w:val="2"\s*\/>/);
  await table.locator('tr').first().locator('td').click();await f.getByRole('button',{name:'拆分单元格',exact:true}).click();const dialog=f.locator('.split-cells-dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'确定',exact:true}).click();assert.equal(await table.locator('tr').first().locator('td').count(),2);model=await page.evaluate(()=>window.officeDocxHarness.save());assert.equal(model.document.content.find(n=>n.type==='docTable').content[0].content.length,2);
  await page.reload();await body.waitFor();assert.equal(await body.locator('table tr').first().locator('td').count(),2);results.push({browser:kind,version:b.version(),columnDrag:true,rowSelection:true,mergeSplit:true,realDocxReopen:true});
 }finally{await b.close();}
}
console.log(JSON.stringify(results));await writeFile(new URL('output/browser/table-results.json',import.meta.url),JSON.stringify(results,null,2));
