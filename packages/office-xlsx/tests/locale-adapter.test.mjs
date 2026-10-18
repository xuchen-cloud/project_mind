import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve,dirname} from 'node:path'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {adaptLocaleStrings,adaptLocaleProvider,adaptLocaleBootstrap} from '../scripts/locale-adapter.mjs'
const directory=resolve(import.meta.dirname,'../vendor/apps/sheets/src/renderer/i18n')
const read=name=>readFileSync(resolve(directory,name),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
function dictionaries(adapted){
 const cache=new Map(),loads=[]
 const load=path=>{
  if(cache.has(path))return cache.get(path)
  const exports={};cache.set(path,exports);loads.push(path)
  const source=path===resolve(directory,'strings.ts')&&adapted?adaptLocaleStrings(read('strings.ts')):readFileSync(path,'utf8')
  runInNewContext(compile(source),{exports,Map,Promise,require(specifier){
   if(specifier==='@genoffice/i18n')return {defineStrings:value=>value}
   return load(resolve(dirname(path),specifier+'.ts'))
  }})
  return exports
 }
 return {module:load(resolve(directory,'strings.ts')),loads}
}

test('all 21 on-demand dictionaries exactly preserve pinned app/dialog/AI translations',async()=>{
 const original=dictionaries(false).module.strings,after=dictionaries(true)
 assert.deepEqual(Object.keys(after.module.strings).sort(),['en','zh'])
 assert.equal(after.loads.some(path=>path.endsWith('/app/ru.ts')),false)
 for(const [lang,expected]of Object.entries(original)){
  const a=after.module.ensureLanguage(lang),b=after.module.ensureLanguage(lang)
  if(lang!=='zh'&&lang!=='en')assert.equal(a,b,'concurrent requests share dictionary loading')
  await a;await b
  assert.deepEqual(JSON.parse(JSON.stringify(after.module.strings[lang])),JSON.parse(JSON.stringify(expected)),lang)
 }
 assert.equal(Object.keys(after.module.strings).length,21)
})

function events(){
 const pending=new Map(),listeners=new Set(),errors=[],hostErrors=[]
 const ensureLanguage=lang=>new Promise((resolve,reject)=>{const group=pending.get(lang)??[];group.push({resolve,reject});pending.set(lang,group)})
 const exports={}
 const window={desktopApi:{},dispatchEvent:event=>errors.push(event)}
 runInNewContext(compile(adaptLocaleProvider(read('locale.tsx'))),{exports,window,ErrorEvent:class{constructor(type,options){Object.assign(this,{type},options)}},require(path){
  if(path.endsWith('renderer-channel.ts'))return {sendHostMessage:message=>hostErrors.push(message)}
  if(path==='react')return {createContext:()=>({})}
  if(path==='@genoffice/i18n')return {createI18n:()=>()=>''}
  if(path==='./strings')return {strings:{zh:{}},ensureLanguage}
  return {}
 }})
 const api={onLanguageChanged(callback){listeners.add(callback);return()=>listeners.delete(callback)}}
 exports.prepareLanguageEvents(api)
 return {api,errors,hostErrors,pending,emit:lang=>{for(const callback of listeners)callback(lang)},resolve:lang=>{for(const item of pending.get(lang))item.resolve()},reject:(lang,error)=>{for(const item of pending.get(lang))item.reject(error)}}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))

test('React and menu receive only complete latest language; stale events and unsubscribe stay silent',async()=>{
 const h=events(),react=[],menu=[]
 h.api.onLanguageChanged(lang=>react.push(lang));const dispose=h.api.onLanguageChanged(lang=>menu.push(lang))
 h.emit('ru');h.emit('ja');assert.deepEqual(react,[]);assert.deepEqual(menu,[])
 h.resolve('ja');await settle();assert.deepEqual(react,['ja']);assert.deepEqual(menu,['ja'])
 h.resolve('ru');await settle();assert.deepEqual(react,['ja']);assert.deepEqual(menu,['ja'])
 h.emit('he');dispose();h.resolve('he');await settle()
 assert.deepEqual(react,['ja','he']);assert.deepEqual(menu,['ja'])
})

test('failed language load retains prior language and reports the real error',async()=>{
 const h=events(),changes=[],error=Error('language chunk unavailable')
 h.api.onLanguageChanged(lang=>changes.push(lang));h.emit('ru');h.reject('ru',error);await settle()
 assert.deepEqual(changes,[]);assert.equal(h.errors.length,1);assert.equal(h.errors[0].error,error);assert.equal(h.hostErrors.length,1);assert.match(h.hostErrors[0].value,/language chunk unavailable/)
})

test('first language is awaited before language publication and first React render; pinned drift fails',()=>{
 const source=readFileSync(resolve(directory,'../main.tsx'),'utf8'),adapted=adaptLocaleBootstrap(source)
 assert.ok(adapted.indexOf('await ensureLanguage(lang)')<adapted.indexOf('  setModuleLang(lang)'))
 assert.ok(adapted.indexOf('await ensureLanguage(lang)')<adapted.indexOf('ReactDOM.createRoot'))
 assert.ok(adapted.indexOf('prepareLanguageEvents(window.desktopApi)')<adapted.indexOf('void bootstrap()'))
 assert.throws(()=>adaptLocaleStrings(read('strings.ts').replace('...appStrings.zh','...appStrings.en')),/Pinned XLSX/)
 assert.throws(()=>adaptLocaleBootstrap(source.replace('  setModuleLang(lang)','  setModuleLang(other)')),/Pinned XLSX/)
})
