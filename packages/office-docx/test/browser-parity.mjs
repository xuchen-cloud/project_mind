/** Opt-in, headless user-operation and byte-save acceptance for the complete renderer. */
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
const {chromium,webkit}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const out=resolve(import.meta.dirname,'output/browser');await mkdir(out,{recursive:true});
const results=[];
const trace=(stage)=>{if(process.env.OFFICE_TRACE)console.log(stage);};
for(const [name,type] of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.OFFICE_BROWSER||process.env.OFFICE_BROWSER===name)){
 const browser=await type.launch({headless:true,...(name==='chromium'?{channel:'chrome'}:process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{})});
 const errors=[];let page;
 try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');
  const originalBytes=await (await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body();
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto(process.env.OFFICE_ACCEPTANCE_URL);
  let frame=page.frameLocator('iframe[title="Word 文档编辑器"]');
  let body=frame.locator('.tiptap.doc-page');await body.waitFor({timeout:20000});
  trace(`${name}: ready`);
  await frame.locator('html').evaluate(n=>{window.__acceptanceFrameIdentity='original';});
  assert.ok(await frame.getByRole('button',{name:'开始',exact:true}).count());
  assert.equal(await frame.locator('.ai-entry').isVisible().catch(()=>false),false);
  const paragraph=body.locator('p[data-idx="2"]');
  async function selectParagraph(locator){await locator.scrollIntoViewIfNeeded();const r=await locator.boundingBox();await page.mouse.move(r.x+1,r.y+2);await page.mouse.down();await page.mouse.move(r.x+r.width-2,r.y+r.height-2,{steps:8});await page.mouse.up();assert.equal(await locator.evaluate(()=>getSelection().toString().trim()),(await locator.innerText()).trim());}
  await selectParagraph(paragraph);await page.keyboard.insertText(`${name}真实中文编辑`);
  assert.equal(await paragraph.innerText(),`${name}真实中文编辑`);
  await selectParagraph(paragraph);
  await frame.getByRole('button',{name:/^加粗/}).click();
  await frame.getByRole('button',{name:/^居中/}).click();
  await selectParagraph(paragraph);await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await page.keyboard.insertText(`${name}新增结构段落`);
  const cell=body.locator('tr').nth(1).locator('td').nth(1).locator('p');
  const originalCell=await cell.innerText();
  await selectParagraph(cell);await page.keyboard.insertText(`${name}真实表格编辑`);
  trace(`${name}: edited`);
  // An IME composition cannot be silently saved as a partial word.
  await body.dispatchEvent('compositionstart',{data:'组'});
  const ime=await page.evaluate(async()=>{try{await window.officeDocxHarness.flush();return '';}catch(error){return String(error);}});
  assert.match(ime,/输入法/);
  trace(`${name}: IME rejected`);
  await body.dispatchEvent('compositionend',{data:'组合'});
  const model=await page.evaluate(()=>window.officeDocxHarness.save());
  trace(`${name}: first save`);
  assert.ok(model.nodes.some(n=>n.text===`${name}真实中文编辑`));
  assert.ok(model.nodes.some(n=>n.text===`${name}新增结构段落`));
  assert.ok(model.nodes.some(n=>n.text===`${name}真实表格编辑`));
  const p=model.document.content.find(n=>n.content?.some(t=>t.text===`${name}真实中文编辑`));
  assert.equal(p.attrs.align,'center');assert.ok(p.content[0].marks.some(m=>m.type==='bold'));
  frame=page.frameLocator('iframe[title="Word 文档编辑器"]');body=frame.locator('.tiptap.doc-page');await body.waitFor();
  assert.equal(await frame.locator('html').evaluate(()=>window.__acceptanceFrameIdentity),'original','save receipt must retain renderer identity');
  assert.equal(await frame.locator('.tiptap.doc-page').evaluate(()=>window.getSelection()?.anchorNode?.parentElement?.closest('td')!==null),true,'save preserves the table caret');
  await frame.getByRole('button',{name:'撤销',exact:true}).click();
  await cell.waitFor();assert.equal(await cell.innerText(),originalCell,'undo survives the first save');
  const second=await page.evaluate(()=>window.officeDocxHarness.save());
  trace(`${name}: second save`);
  assert.ok(second.nodes.some(n=>n.text===originalCell),'second native save includes undo');
  assert.equal(await frame.locator('html').evaluate(()=>window.__acceptanceFrameIdentity),'original');
  const beforeZip=await JSZip.loadAsync(originalBytes),afterZip=await JSZip.loadAsync(await (await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body());
  for(const path of Object.keys(beforeZip.files).filter(p=>!beforeZip.files[p].dir&&!['word/document.xml','docProps/core.xml'].includes(p)))assert.deepEqual(await afterZip.file(path)?.async('uint8array'),await beforeZip.file(path)?.async('uint8array'),path);
  // Read-only freezes the canvas and all editing commands.
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(true));
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('.tiptap.doc-page')?.getAttribute('contenteditable')==='false');
  assert.equal(await frame.locator('.ribbon-body').evaluate(n=>n.inert),true);
  await page.evaluate(()=>window.officeDocxHarness.setReadOnly(false));
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('.tiptap.doc-page')?.getAttribute('contenteditable')==='true');
  await frame.getByRole('button',{name:'恢复',exact:true}).click();
  assert.equal(await cell.innerText(),`${name}真实表格编辑`,'redo survives a second save');
  // Parent theme/font changes propagate without remounting or leaking CSS.
  await page.evaluate(()=>{document.documentElement.classList.add('dark');document.documentElement.style.setProperty('--font-ui','Georgia, serif');});
  await frame.locator('html[data-theme=dark]').waitFor();
  assert.match(await frame.locator('body').evaluate(n=>getComputedStyle(n).fontFamily),/Georgia/);
  assert.equal(await page.locator('html').getAttribute('data-doc-theme'),null);
  await page.evaluate(()=>{document.documentElement.classList.remove('dark');document.documentElement.style.removeProperty('--font-ui');});
  await frame.locator('html[data-theme=light]').waitFor();
  await page.screenshot({path:resolve(out,`parity-${name}-wide.png`)});
  await page.setViewportSize({width:480,height:800});
  await page.screenshot({path:resolve(out,`parity-${name}-narrow.png`)});
  assert.deepEqual(errors,[]);
  const result={name,version:browser.version(),headless:true,fullRenderer:true,chinese:true,paragraphStructure:true,toolbarSelection:true,tableInput:true,realDocxReopen:true,imeGuard:true,readOnly:true,saveReceiptPreservesHistoryAndCaret:true,twoSaveCycles:true,themeAndFont:true,errors};results.push(result);console.log(JSON.stringify(result));
 }catch(error){if(page){console.log('ERRORS',errors);for(const f of page.frames())try{console.log(f.url(),(await f.locator('body').innerText({timeout:1000})).slice(-1500));}catch{}await page.screenshot({path:resolve(out,`parity-${name}-failure.png`)});}throw error;}
 finally{await browser.close();}
}
await writeFile(resolve(out,'parity-results.json'),JSON.stringify(results,null,2));
