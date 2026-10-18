import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,stat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {chromium} from '@playwright/test'
import {withRendererResources} from './renderer-server.mjs'
import {inspect} from '../dist/engine.mjs'
const dist=new URL('../dist/',import.meta.url)

test('external renderer manifest contains the complete ESM/CSS/font graph and byte-identical Carlito faces',async()=>{
 const manifest=JSON.parse(await readFile(new URL('renderer-resources.json',dist),'utf8')),meta=JSON.parse(await readFile(new URL('renderer-meta.json',dist),'utf8'))
 assert.equal(manifest.entry,'renderer.html');assert.equal(new Set(manifest.files).size,manifest.files.length)
 for(const path of manifest.files){assert.ok(!path.startsWith('/')&&!path.split('/').includes('..'));assert.ok((await stat(new URL(path,dist))).isFile())}
 for(const path of Object.keys(meta.outputs))assert.ok(manifest.files.includes(path.replace(/^dist\//,'')),path)
 const html=await readFile(new URL(manifest.entry,dist),'utf8');assert.match(html,/<script type="module" src="\.\/renderer\//);assert.match(html,/<link rel="stylesheet" href="\.\/renderer\//)
 const entry=Object.values(meta.outputs).find(output=>output.entryPoint==='renderer-entry.ts')
 const main=entry.imports.filter(item=>item.kind==='dynamic-import'&&meta.outputs[item.path]?.entryPoint==='vendor/apps/sheets/src/renderer/main.tsx')
 assert.equal(main.length,1)
 const initialInputs=new Set(),visited=new Set(),queue=[Object.keys(meta.outputs).find(path=>meta.outputs[path]===entry),main[0].path]
 while(queue.length){const path=queue.pop();if(visited.has(path))continue;visited.add(path);const output=meta.outputs[path];if(!output)continue;for(const input of Object.keys(output.inputs))initialInputs.add(input);for(const item of output.imports)if(item.kind==='import-statement')queue.push(item.path)}
 const initialDictionaries=[...initialInputs].filter(path=>/\/renderer\/i18n\/(app|dialogs|ai)\//.test(path))
 assert.ok(initialDictionaries.length>=2,'fallback dictionaries remain available before bootstrap')
 for(const path of initialDictionaries)assert.match(path,/\/(zh|en)\.ts$/,'other languages must not enter the initial static graph: '+path)
 assert.ok(![...initialInputs].some(path=>path.includes('/pdf-lib/')),'PDF output implementation loads on use')
 const allInputs=new Set(Object.values(meta.outputs).flatMap(output=>Object.keys(output.inputs)))
 for(const lang of ['ja','ko','fr','de','es','th','id','ru','ar','pt','it','pl','cs','nl','ms','he','hi','vi','zh-TW'])for(const shard of ['app','dialogs','ai'])assert.ok(allInputs.has(`vendor/apps/sheets/src/renderer/i18n/${shard}/${lang}.ts`),`preserve on-demand ${lang}/${shard}`)
 const preloads=[...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(match=>match[1])
 assert.deepEqual(preloads,['./'+main[0].path.replace(/^dist\//,'')],'only the XLSX dynamic main entry is preloaded')
 const browser=await readFile(new URL('browser.mjs',dist),'utf8');assert.ok(Buffer.byteLength(browser)<100_000,'public mount entry must not embed the full renderer');assert.doesNotMatch(browser,/rendererHtml/);assert.doesNotMatch(browser,/new URL\(["']\.\/renderer\.html["']/,'host Vite must not discover an orphan static HTML asset')
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
 for(const face of ['Regular','Bold','Italic','BoldItalic']){
  const output=manifest.files.find(path=>new RegExp(`/Carlito-${face}-[^/]+\\.ttf$`).test(path));assert.ok(output,face)
  assert.equal(hash(await readFile(new URL(output,dist))),hash(await readFile(new URL(`../vendor/packages/ui/src/fonts/Carlito-${face}.ttf`,import.meta.url))),face+' remains unchanged')
 }
})

test('explicit renderer URL boots the real workbook; a failed entry resource rejects ready', {timeout:45000},async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/complex.original.xlsx',import.meta.url))),bundle=await readFile(new URL('browser.mjs',dist)),css=await readFile(new URL('browser.css',dist))
 const html=`<!doctype html><link rel="stylesheet" href="/browser.css"><div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.props={model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(){}};window.editor=null;window.open=async path=>{window.editor?.dispose();window.editor=mount(document.querySelector('#editor'),window.props,path);await window.editor.ready};window.loaded=true</script>`
 const serve=withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)},{prefix:'/relocated/'})
 let breakEntry=false
 const server=createServer((req,res)=>{if(breakEntry&&/\/renderer\/renderer-entry-.*\.mjs$/.test(req.url)){res.statusCode=404;res.end('missing entry fixture');return}return serve(req,res)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true})
 try{
  const page=await browser.newPage(),origin=`http://127.0.0.1:${server.address().port}`
  // No parent initialize message: preload fetches main without executing bootstrap.
  const preloaded=page.waitForResponse(response=>/\/main-[^/]+\.mjs$/.test(response.url()))
  await page.goto(origin+'/relocated/renderer.html');assert.equal((await preloaded).status(),200)
  const beforeInitialize=await page.evaluate(()=>({marks:performance.getEntriesByType('mark').map(mark=>mark.name),children:document.querySelector('#root').childElementCount}))
  assert.ok(!beforeInitialize.marks.includes('office-xlsx:main-import-start'))
  assert.ok(!beforeInitialize.marks.includes('office-xlsx:font-load-start'))
  assert.equal(beforeInitialize.children,0,'preload must not execute React/Univer bootstrap')
  await page.goto(origin);await page.waitForFunction(()=>window.loaded)
  await page.evaluate(()=>window.open('/relocated/renderer.html'))
  assert.match(await page.locator('iframe').getAttribute('src'),/relocated\/renderer\.html/)
  await page.frameLocator('iframe').locator('canvas[id^="univer-sheet-main-canvas"]:visible').waitFor()
  const fonts=await page.frameLocator('iframe').locator('body').evaluate(async()=>{await document.fonts.ready;return performance.getEntriesByType('resource').filter(e=>/Carlito-.*\.ttf/.test(e.name)).map(e=>e.name)})
  assert.ok(fonts.length>=2,'real external fonts are requested')
  breakEntry=true;await page.route('**/renderer/renderer-entry-*.mjs',route=>route.continue())
  await assert.rejects(page.evaluate(()=>window.open('/relocated/renderer.html?broken')),/Excel renderer resource failed/)
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})
