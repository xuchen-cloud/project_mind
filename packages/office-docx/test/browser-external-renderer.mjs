/** Static relocation and on-demand print assets, using the real same-origin renderer. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {requestOutput} from './output-command.mjs';
const pw=await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const manifest=JSON.parse(await readFile(new URL('../dist/renderer-resources.json',import.meta.url)));
const results=[];
for(const kind of(process.env.OFFICE_BROWSER?[process.env.OFFICE_BROWSER]:['chromium','webkit'])){
  const browser=await pw[kind].launch(kind==='chromium'?{headless:true,channel:'chrome'}:{headless:true,executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),requests=[],errors=[];
    page.on('request',request=>requests.push(new URL(request.url()).pathname));
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/standalone');
    await page.waitForFunction(()=>!!window.standalone);
    await page.evaluate(()=>window.standalone.ready);
    const frame=page.frameLocator('iframe'),body=frame.locator('.tiptap.doc-page');await body.waitFor();
    assert.equal(await page.locator('iframe').getAttribute('srcdoc'),null);
    assert.equal(new URL(await page.locator('iframe').getAttribute('src')).pathname,'/word-package/renderer.html','default URL resolves beside the unbundled package host module');
    assert.match(await body.innerText(),/中文文档往返验证/);
    assert.ok(requests.includes('/word-package/renderer.mjs'));
    assert.ok(requests.includes('/word-package/renderer.css'));
    assert.equal(requests.some(url=>url.includes('/print-fonts')),false,'initial rendering neither fetches mapping nor decodes print-only fonts');
    await page.evaluate(()=>window.standalone.destroy());

    requests.length=0;
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?nativePrint');
    await page.frameLocator('iframe').locator('.tiptap.doc-page').waitFor();
    assert.equal(requests.some(url=>url.includes('/print-fonts')),false);
    await page.evaluate(()=>{window.officeDocxHarness.print=async document=>{window.printedDocument=document;};});
    await requestOutput(page,'打印…');
    const dialog=page.frameLocator('iframe').locator('.print-dialog');await dialog.waitFor();
    await dialog.getByRole('button',{name:'打印',exact:true}).click();
    await page.waitForFunction(()=>!!window.printedDocument);
    const output=await page.evaluate(()=>window.printedDocument.html);
    assert.ok(requests.includes('/word-renderer/print-fonts.json'));
    const printFonts=requests.filter(url=>url.startsWith('/word-renderer/print-fonts/'));
    assert.ok(printFonts.length>0&&printFonts.length<5,'only used print-only faces are requested');
    assert.match(output,/data:font\/woff2;base64,/);
    assert.equal(await page.evaluate(html=>{
      const copy=new DOMParser().parseFromString(html,'text/html');
      return [...copy.querySelectorAll('[style]')].some(element=>element.style.fontSynthesis==='style'&&element.style.getPropertyValue('-webkit-text-stroke-width')==='0.01em');
    },output),true,'print-only bold retains its single fill+stroke treatment in both CSSOM serializers');
    assert.doesNotMatch(output,/url\(["']?(?:blob:|https?:|\.\/?(?:assets|print-fonts))/i);
    for(const url of requests.filter(url=>url.startsWith('/word-renderer/')))assert.ok(manifest.files.includes(url.slice('/word-renderer/'.length)),`Unmanifested renderer request: ${url}`);
    assert.deepEqual(errors,[]);
    // A broken print mapping must remain a visible output failure, not silently
    // switch to screen CFF fonts or invoke the host with an incomplete document.
    await page.route('**/print-fonts.json',route=>route.fulfill({status:503,body:'unavailable'}));
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL+'/?nativePrint');
    await page.frameLocator('iframe').locator('.tiptap.doc-page').waitFor();
    await page.evaluate(()=>{window.printCalled=false;window.officeDocxHarness.print=async()=>{window.printCalled=true;};});
    await requestOutput(page,'打印…');const failedDialog=page.frameLocator('iframe').locator('.print-dialog');await failedDialog.waitFor();
    await failedDialog.getByRole('button',{name:'打印',exact:true}).click();
    await page.frameLocator('iframe').locator('.status-msg').filter({hasText:'打印字体映射无法加载：503'}).waitFor();
    assert.equal(await failedDialog.isVisible(),true);
    assert.equal(await page.evaluate(()=>window.printCalled),false);
    assert.deepEqual(errors,[]);
    results.push({browser:kind,defaultUrl:true,sameOriginStaticIframe:true,noPrintFontsOnOpen:true,printFontsRequested:printFonts,manifestClosed:true,printResourceFailureVisible:true,errors});
  }finally{await browser.close();}
}
await writeFile(new URL('output/browser/external-renderer-results.json',import.meta.url),JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
