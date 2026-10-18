/** Copy only fixed renderer/workspace source inputs, preserving upstream bytes. */
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'..'),source=process.argv[2]
if(!source)throw Error('Pass the checkout at the commit recorded in upstream.json')
const manifest=JSON.parse(await readFile(resolve(root,'upstream.json'),'utf8'))
const existing=new Set(manifest.files.map(f=>f.destination)),added=[]
async function visit(path){
 for(const ent of await readdir(resolve(source,path),{withFileTypes:true})){
  const name=path+'/'+ent.name
  if(ent.isDirectory())await visit(name)
  else if(!/(^|\/)README(?:\.|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name))await add(name)
 }
}
async function add(path){
 const destination='vendor/'+path;if(existing.has(destination))return
 const bytes=await readFile(resolve(source,path));await mkdir(dirname(resolve(root,destination)),{recursive:true});await copyFile(resolve(source,path),resolve(root,destination))
 manifest.files.push({path,destination,git_blob_sha1:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});existing.add(destination);added.push(path)
}
for(const dir of ['apps/sheets/src/renderer','apps/sheets/src/shared','apps/sheets/src/ai',...['ui','i18n','agent-core','ai-provider','ai-search','docx-engine','file-parse','pptx-render','pptx-engine','font-metrics'].map(n=>'packages/'+n+'/src')])await visit(dir)
for(const path of ['apps/docs/src/renderer/fonts/LICENSE-OFL.txt','apps/docs/src/renderer/fonts/README.md'])await add(path)
for(const name of ['headless-export','safe-external-url'])await add('packages/electron-utils/src/'+name+'.ts')
await writeFile(resolve(root,'upstream.json'),JSON.stringify(manifest,null,2)+'\n');console.log(`Pinned ${added.length} renderer inputs at ${manifest.commit}`)
