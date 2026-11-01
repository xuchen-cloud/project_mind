/** Real full renderer + real DOCX serializer; receipts never replace its fixed model. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {inspect,edit} from '../dist/engine.mjs';
const pw=await import(process.env.OFFICE_PLAYWRIGHT_MODULE?pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href:new URL('../../office-xlsx/node_modules/@playwright/test/index.mjs',import.meta.url).href);
const base=await readFile(new URL('./fixtures/complex.original.docx',import.meta.url));
for(const name of process.env.OFFICE_BROWSERS?.split(',')??['chromium','webkit']){
 const browser=await pw[name].launch({headless:true});
 try{
  let release,arrived;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{arrived=r}),saved=[];
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.exposeFunction('persistCandidate',async edits=>{const bytes=await edit(base,edits);saved.push(await inspect(bytes));if(saved.length===1){arrived();await gate;}});
  await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/continuous');await page.waitForFunction(()=>!!window.continuous);await page.evaluate(()=>window.continuous.ready());
  const frame=page.frames().find(f=>f.parentFrame()),body=frame.locator('.tiptap.doc-page').first(),paragraph=body.locator('p[data-idx="2"]');
  await paragraph.evaluate(p=>{p.closest('[contenteditable]').focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);});
  await page.keyboard.insertText(' FIRST');await page.evaluate(()=>window.continuous.flush());
  await page.waitForFunction(()=>window.continuous.state().editRevision>0);
  const firstRevision=await page.evaluate(()=>window.continuous.state().editRevision);
  await body.evaluate(node=>{window.originalEditor=node;});await page.evaluate(()=>{window.inFlight=window.continuous.save()});await started;
  await page.keyboard.insertText(' LATE');await page.evaluate(()=>window.continuous.flush());await page.waitForFunction(revision=>window.continuous.state().editRevision>revision,firstRevision);
  const caret=()=>frame.evaluate(()=>{const s=getSelection();return{anchor:s.anchorOffset,focus:s.focusOffset,text:s.anchorNode?.textContent,active:document.activeElement===window.originalEditor,connected:window.originalEditor.isConnected}});
  const before=await caret();assert.equal(before.active,true);
  release();await page.evaluate(()=>window.inFlight);assert.deepEqual(await caret(),before);
  const pending=await page.evaluate(()=>window.continuous.state());assert.equal(pending.savedEditRevision,firstRevision);assert.equal(pending.dirty,true);
  await page.evaluate(()=>window.continuous.save());assert.equal(await page.evaluate(()=>window.continuous.state().dirty),false);
  assert.match(JSON.stringify(saved[0]),/FIRST/);assert.doesNotMatch(JSON.stringify(saved[0]),/LATE/);assert.match(JSON.stringify(saved[1]),/FIRST LATE/);
  await page.evaluate(()=>window.continuous.undo());await page.evaluate(()=>window.continuous.flush());await page.evaluate(()=>window.continuous.save());
  assert.notDeepEqual(saved[2],saved[1]);assert.doesNotMatch(JSON.stringify(saved[2]),/FIRST LATE/);
  assert.deepEqual(await page.evaluate(()=>window.continuous.errors),[]);
  assert.deepEqual(pageErrors,[]);
  console.log(`${name}: fixed DOCX model, delayed receipt, late dirty, caret, second saved bytes and cross-save undo passed`);
 }finally{await browser.close();}
}
