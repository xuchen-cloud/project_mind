import {fileURLToPath} from 'node:url'
// Build-only adaptations over the pinned upstream locale protocol. Vendor stays intact.
const languages=['zh','en','ja','ko','fr','de','es','th','id','ru','ar','pt','it','pl','cs','nl','ms','he','hi','vi','zh-TW']
const property=lang=>lang==='zh-TW'?"'zh-TW'":lang
const member=lang=>lang==='zh-TW'?"['zh-TW']":'.'+lang
const symbol=lang=>lang==='zh-TW'?'zhTW':lang
function replaceOnce(source,from,to){
 if(source.split(from).length!==2)throw Error('Pinned XLSX locale point changed: '+from)
 return source.replace(from,to)
}
export function adaptLocaleStrings(source){
 const expected=`import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { dialogStrings } from './strings-dialogs'
export const strings = {${languages.map(lang=>`${property(lang)}: { ...appStrings${member(lang)}, ...dialogStrings${member(lang)}, ...aiStrings${member(lang)} },`).join('\n')}}`
 if(source.replace(/\s/g,'')!==expected.replace(/\s/g,''))throw Error('Pinned XLSX locale dictionaries changed')
 const imports=['zh','en'].flatMap(lang=>['app','dialogs','ai'].map(shard=>`import {${symbol(lang)} as ${lang}_${shard}} from './${shard}/${lang}'`)).join('\n')
 const merged=lang=>`{...${lang}_app,...${lang}_dialogs,...${lang}_ai}`
 return `import type {Lang} from '@genoffice/i18n'
${imports}
const zh=${merged('zh')},en=${merged('en')}
export const strings={zh,en} as Record<Lang,typeof zh>
const loaders={${languages.filter(lang=>lang!=='zh'&&lang!=='en').map(lang=>`${property(lang)}:()=>Promise.all([${['app','dialogs','ai'].map(shard=>`import('./${shard}/${lang}').then(module=>module.${symbol(lang)})`).join(',')}])`).join(',\n')}}
const loading=new Map<Lang,Promise<void>>()
export function ensureLanguage(lang:Lang):Promise<void>{
 if(strings[lang])return Promise.resolve()
 const existing=loading.get(lang);if(existing)return existing
 const pending=loaders[lang]().then(([app,dialogs,ai])=>{strings[lang]={...app,...dialogs,...ai}})
 loading.set(lang,pending);return pending
}
`
}
export function adaptLocaleProvider(source){
 source=replaceOnce(source,"import { strings } from './strings'","import { strings, ensureLanguage } from './strings'\nexport {ensureLanguage} from './strings'")
 // Install once before bootstrap, so React and context-menu subscribers see the
 // same completed dictionary. A superseded event/unmounted listener stays silent.
 return `import {sendHostMessage} from ${JSON.stringify(fileURLToPath(new URL('../renderer-channel.ts',import.meta.url)))};\n`+source+`
export function reportLanguageError(error:unknown):void {
 sendHostMessage({officeXlsx:true,type:'error',value:'Excel language resource failed: '+String(error)})
 window.dispatchEvent(new ErrorEvent('error',{error,message:String(error)}))
}
export function prepareLanguageEvents(api:typeof window.desktopApi):void {
 const subscribe=api.onLanguageChanged.bind(api)
 api.onLanguageChanged=(callback)=>{
  let active=true,generation=0
  const dispose=subscribe(next=>{
   const current=++generation
   void ensureLanguage(next).then(()=>{
    if(active&&generation===current)callback(next)
   },error=>{
    if(active&&generation===current)reportLanguageError(error)
   })
  })
  return ()=>{active=false;generation++;dispose()}
 }
}
`
}
export function adaptLocaleBootstrap(source){
 source=replaceOnce(source,"import { LocaleProvider, setModuleLang } from './i18n/locale'","import { LocaleProvider, setModuleLang, ensureLanguage, prepareLanguageEvents, reportLanguageError } from './i18n/locale'")
 source=replaceOnce(source,'  setModuleLang(lang)','  await ensureLanguage(lang)\n  setModuleLang(lang)')
 return replaceOnce(source,'void bootstrap()','prepareLanguageEvents(window.desktopApi)\nvoid bootstrap().catch(reportLanguageError)')
}
