/** Whole-file encryption is excluded; real settings protection remains editable/savable. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import JSZip from 'jszip';
import {inspect,edit} from '../dist/engine.mjs';
const {chromium,webkit}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const browser=await(process.env.OFFICE_BROWSER==='webkit'?webkit.launch({headless:true}):chromium.launch({headless:true,channel:'chrome'}));
const zip=await JSZip.loadAsync(await readFile(new URL('fixtures/complex.original.docx',import.meta.url)));
const settings=await zip.file('word/settings.xml').async('string');zip.file('word/settings.xml',settings.replace('</w:settings>','<w:writeProtection w:recommended="1"/></w:settings>'));
const original=await zip.generateAsync({type:'uint8array'}),initial=await inspect(original);
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.addInitScript(initial=>window.lifecycleInitial=initial,initial);await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/lifecycle');const f=page.frameLocator('iframe');await f.locator('.tiptap.doc-page').waitFor();await page.evaluate(()=>window.lifecycle.flush());
 await f.getByRole('button',{name:'审阅',exact:true}).click();const protect=f.getByRole('button',{name:'保护文档',exact:true});await protect.click();const dialog=f.locator('.protect-dialog');await dialog.waitFor();
 assert.equal(await dialog.getByText('打开此文档的密码',{exact:false}).count(),0,'excluded encryption field must be removed');assert.doesNotMatch(await dialog.locator('.modal-desc').innerText(),/打开|加密/);assert.doesNotMatch(await protect.getAttribute('title'),/打开|加密/);
 assert.equal(await dialog.locator('.fld-row input').count(),2,'writeProtection password/confirm fields remain');await dialog.locator('label.protect-check').filter({hasText:/^限制编辑方式$/}).click();assert.equal(await dialog.getByLabel('限制编辑方式').isChecked(),true);await dialog.locator('label.protect-check').filter({hasText:/^只读$/}).click();assert.equal(await dialog.getByLabel('只读',{exact:true}).isChecked(),true);await dialog.getByRole('button',{name:'确定',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.evaluate(()=>window.lifecycle.flush());const edits=await page.evaluate(()=>window.lifecycle.events.filter(event=>event.kind==='change').at(-1)?.value);assert(edits?.length,'real protection update must emit a saveable snapshot');
 const bytes=await edit(original,edits),savedZip=await JSZip.loadAsync(bytes),savedSettings=await savedZip.file('word/settings.xml').async('string');assert.match(savedSettings,/<w:writeProtection\b[^>]*w:recommended="(?:1|true)"/);assert.match(savedSettings,/<w:documentProtection\b[^>]*w:edit="readOnly"/);assert.match(savedSettings,/<w:documentProtection\b[^>]*w:enforcement="(?:1|true)"/);
 const reopened=await inspect(bytes);await page.evaluate(model=>window.lifecycle.replace(model),reopened);await f.locator('.tiptap.doc-page').waitFor();await page.evaluate(()=>window.lifecycle.flush());assert.equal(await f.locator('.tiptap.doc-page').getAttribute('contenteditable'),'false');
 await page.evaluate(()=>window.lifecycle.dispose());const result={browser:browser.version(),openEncryptionAbsent:true,tooltipAndDescriptionAccurate:true,modifyPasswordFieldsRetained:true,writeProtectionPreserved:true,editingRestrictionSavedAndReopened:true};console.log(JSON.stringify(result));await writeFile(new URL(`output/browser/protection-${process.env.OFFICE_BROWSER??'chromium'}-results.json`,import.meta.url),JSON.stringify(result,null,2));
}finally{await browser.close();}
