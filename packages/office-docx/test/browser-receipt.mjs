/** Upstream's public e2e save hook must await and propagate the File save receipt. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage();await page.goto(process.env.OFFICE_ACCEPTANCE_URL);const f=page.frameLocator('iframe');await f.locator('.tiptap.doc-page').waitFor();
 // The test host controls the native receipt, without mutating editor internals.
 await page.evaluate(()=>{
  window.officeDocxHarness.save=()=>new Promise(resolve=>{window.releaseNative=resolve;});
  window.saveResult='waiting';
  document.querySelector('iframe').contentWindow.__aidocs.save().then(value=>{window.saveResult=value;},error=>{window.saveResult=String(error);});
 });
 await page.waitForFunction(()=>!!window.releaseNative);assert.equal(await page.evaluate(()=>window.saveResult),'waiting');
 await page.evaluate(()=>window.releaseNative());await page.waitForFunction(()=>window.saveResult===true);
 await page.evaluate(()=>{
  window.officeDocxHarness.save=async()=>{throw Error('Native CAS save failed');};
  window.saveResult='waiting';
  document.querySelector('iframe').contentWindow.__aidocs.save().then(value=>{window.saveResult=value;},error=>{window.saveResult=String(error);});
 });
 await page.waitForFunction(()=>window.saveResult!=='waiting');assert.match(await page.evaluate(()=>window.saveResult),/Native CAS save failed/);
 const result={browser:browser.version(),awaitsNativeReceipt:true,success:true,failurePropagates:true};console.log(JSON.stringify(result));await writeFile(new URL('output/browser/receipt-results.json',import.meta.url),JSON.stringify(result,null,2));
}finally{await browser.close();}
