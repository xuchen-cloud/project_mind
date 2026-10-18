/** Real output seam: native PDF bytes -> original group merge -> PDF/PNG ZIP. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import JSZip from 'jszip';
const fixture=await PDFDocument.create(),font=await fixture.embedFont(StandardFonts.Helvetica);
const sheet=fixture.addPage([360,504]);sheet.drawText('Native PDF fixture',{x:20,y:450,size:18,font});sheet.drawRectangle({x:20,y:20,width:80,height:80,color:rgb(1,0,0)});
const fixtureBytes=Array.from(await fixture.save());
const other=await PDFDocument.create();const otherSheet=other.addPage([450,600]);otherSheet.drawRectangle({x:30,y:30,width:120,height:90,color:rgb(0,0,1)});const otherBytes=Array.from(await other.save());
const metrics={unitsPerEm:2048,hheaAscender:1900,hheaDescender:-500,hheaLineGap:0,typoAscender:1500,typoDescender:-400,typoLineGap:50,winAscent:2000,winDescent:500,useTypoMetrics:false};
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href),kind=process.env.OFFICE_BROWSER??'chromium',browser=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
let page;
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?nativePdf&nativeExport&nativeFonts');const f=page.frameLocator('iframe');await f.locator('.tiptap.doc-page').waitFor();
 await page.evaluate(({bytes,otherBytes})=>{window.pdfInputs=[];window.exports=[];window.renderPdf=async document=>{window.pdfInputs.push(document);return new Uint8Array(document.html.includes('size:600px 800px')?otherBytes:bytes);};window.officeDocxHarness.export=async file=>{window.exports.push({...file,bytes:Array.from(file.bytes)});return true;};window.getSystemFonts=async()=>['Project Mind Test Serif','Arial'];},{bytes:fixtureBytes,otherBytes});
 await f.locator('.ribbon-tabs').getByRole('button',{name:'导出 PDF',exact:true}).click({timeout:10000});
 await page.waitForFunction(()=>window.exports.length===1);
 const first=await page.evaluate(()=>({file:window.exports[0],inputs:window.pdfInputs}));assert.equal(first.file.mime,'application/pdf');assert.deepEqual(first.file.bytes,fixtureBytes);assert.deepEqual(first.inputs[0].pageSize,{widthPt:595.45,heightPt:841.7});assert.match(first.inputs[0].html,/data-native-page/);assert.match(first.inputs[0].html,/data:font\//);
 // Actual upstream mixed-paper grouping: preserve each measured sheet and
 // merge genuine PDFs in original order. Geometry is an independent UI fact.
 await f.locator('.pv-page').last().evaluate(n=>{n.style.width='600px';n.style.height='800px';});
 await f.locator('.pv-toolbar').getByRole('button',{name:'导出 PDF',exact:true}).click();await page.waitForFunction(()=>window.exports.length===2);
 const second=await page.evaluate(()=>({file:window.exports[1],inputs:window.pdfInputs.slice(1)}));assert.equal(second.inputs.length,2);assert.deepEqual(second.inputs.map(input=>input.pageSize),[{widthPt:595.45,heightPt:841.7},{widthPt:450,heightPt:600}]);assert.match(second.inputs[1].html,/size:600px 800px/);
 const merged=await PDFDocument.load(new Uint8Array(second.file.bytes));assert.equal(merged.getPageCount(),2);assert.deepEqual(merged.getPages().map(p=>p.getSize()),[{width:360,height:504},{width:450,height:600}]);
 await f.locator('.pv-toolbar').getByRole('button',{name:'导出图片',exact:true}).click();await page.waitForFunction(()=>window.exports.length===3,undefined,{timeout:15000});
 const zipFile=await page.evaluate(()=>window.exports[2]);assert.equal(zipFile.mime,'application/zip');const zip=await JSZip.loadAsync(new Uint8Array(zipFile.bytes)),pngs=Object.keys(zip.files).filter(n=>n.endsWith('.png'));assert.equal(pngs.length,2);
 for(const [i,name]of pngs.entries()){const bytes=await zip.file(name).async('nodebuffer');assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(bytes.readUInt32BE(16),i===0?960:1200);assert.equal(bytes.readUInt32BE(20),i===0?1344:1600);assert.ok(bytes.length>3000);}
 // Native failure is surfaced, never replaced by HTML or raster PDF.
 await page.evaluate(()=>{window.renderPdf=async()=>{throw Error('Native PDF fixture failure');};});await f.locator('.pv-toolbar').getByRole('button',{name:'导出 PDF',exact:true}).click();await f.locator('.status-msg').filter({hasText:'Native PDF fixture failure'}).waitFor();assert.equal(await page.evaluate(()=>window.exports.length),3);
 // System families come from host on the real font picker interaction.
 await f.locator('.pv-toolbar').getByRole('button',{name:'关闭',exact:true}).click();
 await page.evaluate(value=>{window.fontMetrics=async family=>family==='Project Mind Test Serif'?value:null;},metrics);assert.deepEqual(await f.locator('body').evaluate(()=>window.desktop.fontMetrics('Project Mind Test Serif')),metrics);assert.equal(await f.locator('body').evaluate(()=>window.desktop.fontMetrics('Absent family')),null);await page.evaluate(()=>{window.fontMetrics=async()=>{throw Error('Native metrics failure');};});assert.match(await f.locator('body').evaluate(async()=>{try{await window.desktop.fontMetrics('Project Mind Test Serif');return 'unexpected success';}catch(error){return String(error);}}),/Native metrics failure/);
 const caret=f.locator('.rb-font-family').locator('..').locator('button.rb-combo-caret');if(!(await caret.isVisible()))await f.getByRole('button',{name:'开始',exact:true}).click();await caret.click();await f.getByText('Project Mind Test Serif',{exact:true}).waitFor();
 const result={browser:browser.version(),nativePdfBytes:true,mixedPageGroups:true,realPdfMerge:true,pngZip192Dpi:true,nativeFailure:true,systemFonts:true,nativeFontMetrics:true};console.log(JSON.stringify(result));await writeFile(new URL(`output/browser/native-pdf-${kind}-results.json`,import.meta.url),JSON.stringify(result,null,2));
}catch(error){if(page)console.log(await page.frameLocator('iframe').locator('.status-msg').innerText());throw error;}finally{await browser.close();}
