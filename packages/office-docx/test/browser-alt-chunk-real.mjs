/** Actual HTML -> DOCX helper -> Word renderer -> original-byte save/reopen. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {richAltChunkHtml} from './fixtures/alt-chunk.mjs';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),results=[];
for(const kind of (process.env.OFFICE_BROWSER?[process.env.OFFICE_BROWSER]:['chromium','webkit'])){
 const b=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
 try{
  const page=await b.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');
  await page.addInitScript(()=>{
   window.convertedHtml=[];window.convertedDocx=[];
   window.convertAltChunk=async html=>{
    const helper=await import(new URL('/html2docx.mjs',location.href).href);
    window.convertedHtml.push(html);
    const bytes=await helper.convertAltChunkHtml(html);
    window.convertedDocx.push(bytes?Array.from(bytes):null);
    return bytes;
   };
  });
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?nativeAltChunk');
  const frame=page.frameLocator('iframe[title="Word 文档编辑器"]'),body=frame.locator('.tiptap.doc-page');
  await body.waitFor();await body.getByText('HTML 导入片段：格式与原件保留',{exact:true}).waitFor({timeout:20000});
  assert.deepEqual(await page.evaluate(()=>window.convertedHtml),[richAltChunkHtml]);
  const converted=await JSZip.loadAsync(new Uint8Array(await page.evaluate(()=>window.convertedDocx[0])));
  const conversionXml=await converted.file('word/document.xml').async('string');
  assert.match(conversionXml,/<w:b\b/);assert.match(conversionXml,/<w:i\b/);assert.match(conversionXml,/<w:tbl\b/);assert.match(conversionXml,/<w:numPr\b/);assert.match(conversionXml,/<w:drawing\b/);
  assert.ok(Object.keys(converted.files).some(n=>/^word\/media\//.test(n)&&!converted.files[n].dir),'real embedded image part');
  assert.equal(await body.getByText('HTML 导入片段：格式与原件保留',{exact:true}).evaluate(n=>getComputedStyle(n).fontWeight),'700');
  await body.getByText('转换器真实斜体',{exact:true}).waitFor();await body.getByText('导入列表第二项',{exact:true}).waitFor();
  await body.getByText('转换表格丁',{exact:true}).waitFor();assert.ok(await body.locator('img').count()>=2);
  const original=await JSZip.loadAsync(await(await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body());
  const paragraph=body.locator('p[data-idx="2"]');await paragraph.click();await page.keyboard.press('End');await page.keyboard.insertText('真实转换后的另段编辑');
  const model=await page.evaluate(()=>window.officeDocxHarness.save()),saved=await JSZip.loadAsync(Buffer.from(model.sourceBase64,'base64'));
  assert.ok(model.nodes.some(n=>n.text.includes('真实转换后的另段编辑')));
  assert.equal(await saved.file('word/altChunk1.html').async('string'),richAltChunkHtml);
  assert.match(await saved.file('word/document.xml').async('string'),/<w:altChunk r:id="rAltChunk"\s*\/>/);
  assert.deepEqual(await saved.file('word/_rels/document.xml.rels').async('uint8array'),await original.file('word/_rels/document.xml.rels').async('uint8array'));
  await page.reload();await body.getByText('转换表格丁',{exact:true}).waitFor({timeout:20000});await body.getByText('HTML 导入片段：格式与原件保留',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  results.push({browser:kind,version:b.version(),actualBuiltHelper:true,boldItalicListTableImage:true,otherParagraphEditSaved:true,originalHtmlAndRelationshipRetained:true,reopenExpanded:true,errors});
 }finally{await b.close();}
}
await writeFile(new URL('output/browser/alt-chunk-real-results.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
