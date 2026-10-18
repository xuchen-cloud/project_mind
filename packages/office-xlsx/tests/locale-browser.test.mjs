import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {chromium,expect} from '@playwright/test'
import {withRendererResources} from './renderer-server.mjs'
import {inspect} from '../dist/engine.mjs'
const dist=new URL('../dist/',import.meta.url)

test('non-default first language and gated rapid switches preserve complete UI; missing chunks report errors',{timeout:45000},async()=>{
 const model=await inspect(await readFile(new URL('./fixtures/simple.original.xlsx',import.meta.url)))
 const bundle=await readFile(new URL('browser.mjs',dist)),css=await readFile(new URL('browser.css',dist)),meta=JSON.parse(await readFile(new URL('renderer-meta.json',dist),'utf8'))
 const chunk=lang=>'/'+Object.keys(meta.outputs).find(path=>meta.outputs[path].entryPoint===`vendor/apps/sheets/src/renderer/i18n/app/${lang}.ts`).replace(/^dist\//,'')
 const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/browser.css"><div id="editor" style="height:100vh"></div><script type="module">import{mount}from'/browser.mjs';window.officeErrors=[];document.querySelector('#editor').addEventListener('office-error',event=>window.officeErrors.push(event.detail));window.editor=mount(document.querySelector('#editor'),{model:${JSON.stringify(model)},edits:[],readOnly:false,onChange(){}});await window.editor.ready;window.ready=true</script>`
 const server=createServer(withRendererResources((req,res)=>{res.setHeader('Content-Type',req.url==='/browser.mjs'?'text/javascript':req.url==='/browser.css'?'text/css':'text/html');res.end(req.url==='/browser.mjs'?bundle:req.url==='/browser.css'?css:html)}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,release
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
   Object.defineProperty(window,'desktopApi',{configurable:true,set(api){
    const listeners=new Set();api.getLanguage=async()=> 'ru'
    api.onLanguageChanged=callback=>{listeners.add(callback);return()=>listeners.delete(callback)}
    window.emitLanguage=lang=>{for(const callback of listeners)callback(lang)}
    window.languageErrors=[];window.addEventListener('error',event=>window.languageErrors.push(event.message))
    Object.defineProperty(window,'desktopApi',{configurable:true,writable:true,value:api})
   }})
  })
  const origin=`http://127.0.0.1:${server.address().port}`
  await page.goto(origin);await page.waitForFunction(()=>window.ready)
  const frame=page.frameLocator('iframe'),body=frame.locator('body')
  await expect(frame.getByRole('button',{name:'Главная',exact:true})).toBeVisible()
  assert.equal(await body.evaluate(()=>document.documentElement.lang),'ru-RU')
  let requested;const requestStarted=new Promise(resolve=>{requested=resolve}),held=new Promise(resolve=>{release=resolve})
  await page.route(origin+chunk('ja'),async route=>{requested();await held;await route.continue()})
  await body.evaluate(()=>window.emitLanguage('ja'));await requestStarted
  await expect(frame.getByRole('button',{name:'Главная',exact:true})).toBeVisible()
  await body.evaluate(()=>window.emitLanguage('en'))
  await expect(frame.getByRole('button',{name:'Home',exact:true})).toBeVisible()
  const japaneseResponse=page.waitForResponse(origin+chunk('ja'));release();await japaneseResponse
  await body.evaluate(()=>window.emitLanguage('ja'))
  await expect(frame.getByRole('button',{name:'ホーム',exact:true})).toBeVisible()
  assert.equal(await body.evaluate(()=>document.documentElement.lang),'ja-JP')
  await page.route(origin+chunk('he'),route=>route.abort('failed'))
  await body.evaluate(()=>window.emitLanguage('he'))
  await expect.poll(()=>body.evaluate(()=>window.languageErrors.length)).toBeGreaterThan(0)
  await expect(frame.getByRole('button',{name:'ホーム',exact:true})).toBeVisible()
  assert.equal(await body.evaluate(()=>document.documentElement.lang),'ja-JP')
  assert.ok((await body.evaluate(()=>window.languageErrors)).some(message=>/fetch|import|module/i.test(message)))
  await expect.poll(()=>page.evaluate(()=>window.officeErrors.length)).toBeGreaterThan(0)
  await page.evaluate(()=>window.editor.dispose());assert.equal(await page.locator('iframe').count(),0)
  assert.deepEqual(errors,[],'synthetic locale error event is separately observed above')
 }finally{release?.();await browser?.close();await new Promise(resolve=>server.close(resolve))}
})
