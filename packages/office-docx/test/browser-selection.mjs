/** Public Word selection controller creates actual DOCX tracked revisions. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
const {chromium}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/lifecycle');
 const body=page.frameLocator('iframe').locator('.tiptap.doc-page');await body.waitFor();
 await page.evaluate(()=>window.lifecycle.ready());
 async function select(){
  await body.locator('p[data-idx="2"]').evaluate(p=>{
   const walk=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;
   while(node=walk.nextNode()){const start=node.textContent.indexOf('春风拂面');if(start<0)continue;
    p.focus();const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+4);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));return;
   }throw Error('fixture selection missing');
  });
  await page.waitForTimeout(60);
 }
 await body.locator('p[data-idx="2"]').click();
 await assert.rejects(page.evaluate(()=>window.lifecycle.captureSelection()),/请选择/);
 await body.evaluate(root=>{const range=document.createRange();range.setStart(root.querySelector('p[data-idx="2"]'),0);range.setEnd(root.querySelector('p[data-idx="3"]'),1);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));});await page.waitForTimeout(60);
 await assert.rejects(page.evaluate(()=>window.lifecycle.captureSelection()),/跨段落/);
 await select();await body.dispatchEvent('compositionstart');
 await assert.rejects(page.evaluate(()=>window.lifecycle.captureSelection()),/处理输入/);
 await body.dispatchEvent('compositionend');await page.evaluate(()=>window.lifecycle.flush());
 await select();const captured=await page.evaluate(()=>window.lifecycle.captureSelection());assert.equal(captured.text,'春风拂面');
 const surrounding=await body.locator('p[data-idx="2"]').innerText();
 await body.locator('p[data-idx="3"]').click();
 assert.deepEqual(await page.evaluate(input=>window.lifecycle.replaceSelection(input),{selectionId:captured.selectionId,text:'春意轻拂'}),{text:'春意轻拂'});
 assert.equal(await body.locator('p[data-idx="2"]').innerText(),surrounding.replace('春风拂面','春意轻拂'));
 await page.evaluate(()=>window.lifecycle.flush());
 await assert.rejects(page.evaluate(input=>window.lifecycle.replaceSelection(input),{selectionId:captured.selectionId,text:'重复'}),/选区|失效/);
 const edits=await page.evaluate(()=>window.lifecycle.events.filter(e=>e.kind==='change').at(-1).value);
 const {edit,inspect}=await import('../dist/engine.mjs');const source=await(await page.request.get(process.env.OFFICE_ACCEPTANCE_URL+'/bytes')).body();
 const zip=await JSZip.loadAsync(await edit(source,edits));const xml=await zip.file('word/document.xml').async('string');
 assert.match(xml,/<w:del\b[^>]*w:author="Project Mind AI"/);assert.match(xml,/<w:ins\b[^>]*w:author="Project Mind AI"/);assert.match(xml,/春意轻拂/);assert.match(xml,/<w:delText[^>]*>春风拂面<\/w:delText>/);
 await body.locator('p[data-idx="3"]').evaluate(p=>{const range=document.createRange();range.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));});await page.waitForTimeout(60);
 const beforeExternal=await page.evaluate(()=>window.lifecycle.captureSelection());
 const external=await inspect(await edit(source,[{type:'text',nodeId:'docx:2',text:'外部替换文档'}]));
 await page.evaluate(model=>window.lifecycle.replace(model),external);await page.evaluate(()=>window.lifecycle.ready());
 await assert.rejects(page.evaluate(input=>window.lifecycle.replaceSelection(input),{selectionId:beforeExternal.selectionId,text:'external stale'}),/失效/);
 // The same public contract is registered by the React component.
 await page.goto(process.env.OFFICE_ACCEPTANCE_URL);await body.waitFor();
 await select();const reactCaptured=await page.evaluate(()=>window.officeDocxHarness.selection().captureSelection());
 await assert.rejects(page.evaluate(input=>window.officeDocxHarness.selection().applySelection(input),{selectionId:reactCaptured.selectionId,change:{html:'invalid'}}),/text/);
 await body.locator('p[data-idx="3"]').click();await page.keyboard.type('changed');await page.evaluate(()=>window.officeDocxHarness.flush());
 await assert.rejects(page.evaluate(input=>window.officeDocxHarness.selection().replaceSelection(input),{selectionId:reactCaptured.selectionId,text:'stale'}),/失效/);
 await select();const locked=await page.evaluate(()=>window.officeDocxHarness.selection().captureSelection());
 await page.evaluate(()=>window.officeDocxHarness.setReadOnly(true));await page.waitForTimeout(60);
 await assert.rejects(page.evaluate(input=>window.officeDocxHarness.selection().replaceSelection(input),{selectionId:locked.selectionId,text:'readonly'}),/只读/);
 await page.evaluate(()=>window.officeDocxHarness.setReadOnly(false));await page.waitForTimeout(60);
 await assert.rejects(page.evaluate(input=>window.officeDocxHarness.selection().replaceSelection(input),{selectionId:locked.selectionId,text:'unlocked'}),/失效/);
 await select();const generic=await page.evaluate(()=>window.officeDocxHarness.selection().captureSelection());
 assert.deepEqual(await page.evaluate(input=>window.officeDocxHarness.selection().applySelection(input),{selectionId:generic.selectionId,change:{text:'React 润色'}}),{text:'React 润色'});
 await page.evaluate(()=>window.officeDocxHarness.flush());
 await page.evaluate(()=>{window.savedSelection=window.officeDocxHarness.selection();window.officeDocxHarness.unmount();});await page.waitForTimeout(60);
 await assert.rejects(page.evaluate(()=>window.savedSelection.captureSelection()),/关闭/);
 console.log(JSON.stringify({selection:true,frozenCaret:true,trackedDocx:true,stale:true,readonly:true,closed:true}));
}finally{await browser.close();}
