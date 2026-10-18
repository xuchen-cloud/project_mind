import{build}from'esbuild';import{readFile,writeFile}from'node:fs/promises';import{resolve,dirname}from'node:path';import{existsSync}from'node:fs';import{disposedAutoHeightPatch}from'./patch-univer.mjs';
const root=resolve(import.meta.dirname,'..')
export async function buildRenderer(){
 const result=await build({absWorkingDir:root,entryPoints:['renderer-entry.ts'],outfile:'frame.js',bundle:true,platform:'browser',format:'iife',target:'es2022',jsx:'automatic',write:false,minify:true,metafile:true,define:{'process.env.NODE_ENV':'"production"','import.meta.hot':'undefined','import.meta.env.DEV':'false'},loader:{'.ttf':'dataurl','.woff':'dataurl','.woff2':'dataurl','.svg':'dataurl','.png':'dataurl','.jpg':'dataurl'},plugins:[disposedAutoHeightPatch,{name:'fixed-renderer-bridge',setup(b){
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/App\.tsx$/},async a=>{let source=await readFile(a.path,'utf8');const replace=(from,to)=>{if(!source.includes(from))throw Error('Upstream bridge point changed: '+from);source=source.replace(from,to)};
 replace('const [pendingEdits, setPendingEdits] = useState(0)', 'const [pendingEdits, setPendingEditsState] = useState(0);const setPendingEdits = useCallback((value: Parameters<typeof setPendingEditsState>[0])=>{setPendingEditsState(value);queueMicrotask(()=>window.__projectMindSheetsHost.edited())},[])');
 replace('univerRef.current = runtime','univerRef.current = runtime; window.__projectMindSheetsHost.attach(runtime)');
 replace('return handleSaveImpl(saveContext(), mode, quiet, explicitTarget)',"return mode === 'recovery' ? handleSaveImpl(saveContext(), mode, quiet, explicitTarget) : window.__projectMindSheetsHost.requestSave()");
 replace('handleSaveRef.current = handleSave','handleSaveRef.current = handleSave; window.__projectMindSheetsHost.render({univerRef,lazyWorkbookRef,commitActiveEditor,saveContext,openingWorkbook,isCellEditing:()=>editingCellRef.current,calcManual})');
 replace("useAutoSavePref('ai-sheets-auto-save', window.desktopApi)",'useState(false)');
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}})
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/ExcelShell\.tsx$/},async a=>{let source=(await readFile(a.path,'utf8')).replace("aiPanelInitiallyOpen('ai-sheets-show-ai')",'false');
 const aiStart=source.indexOf("      <RibbonGroup label={t('appGroupAiAssistant')}>");const aiEnd=source.indexOf("      <RibbonGroup label={t('appGroupClipboard')}>",aiStart);if(aiStart<0||aiEnd<0)throw Error('Upstream AI shell changed');source=source.slice(0,aiStart)+source.slice(aiEnd);
 const saveAsStart=source.indexOf('          <button\n            type="button"\n            className="qa-btn"\n            data-tip={saveAsTitle}');const saveAsEnd=source.indexOf('</button>',saveAsStart);if(saveAsStart<0||saveAsEnd<0)throw Error('Upstream Save As shell changed');source=source.slice(0,saveAsStart)+source.slice(saveAsEnd+9);
 const separator='<span className="qa-sep" aria-hidden="true" />';if(!source.includes(separator))throw Error('Upstream QAT bridge changed');source=source.replace(separator,separator+`<button className="qa-btn office-output-action" onClick={()=>window.__projectMindSheetsHost.menu('export-csv')}>导出 CSV</button><button className="qa-btn office-output-action" onClick={()=>window.__projectMindSheetsHost.menu('print')}>打印</button>`);
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}})
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/merge-workbooks\.ts$/},async a=>{
 // Fixed upstream passes `width`, but its pinned Univer command consumes `value`.
 let source=await readFile(a.path,'utf8')
 for(const[from,to]of [['width: width.width,','value: width.width,'],['height: Math.round((row.height * 96) / 72)','height: (row.height * 96) / 72']]){
  if(!source.includes(from))throw Error('Upstream merge dimensions bridge changed: '+from)
  source=source.replace(from,to)
 }
 return{contents:source,loader:'ts',resolveDir:dirname(a.path)}
 })
 b.onResolve({filter:/^@genoffice\//},args=>{const[pkg,...rest]=args.path.slice(11).split('/');let path=resolve(root,'vendor/packages',pkg,'src',rest.join('/').replace(/\?url$/,'')||'index.ts');if(!existsSync(path))for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(path+ext)){path+=ext;break}return{path}})
 b.onResolve({filter:/^node:/},()=>({path:resolve(root,'fork-research/web-node-shims.ts')}))
 b.onResolve({filter:/\?raw$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:'export default '+JSON.stringify(await readFile(a.path,'utf8')),loader:'js'}))
 }}]})
 const manifest=JSON.parse(await readFile(resolve(root,'upstream.json'),'utf8'));const pinned=new Set(manifest.files.map(f=>f.destination));for(const input of Object.keys(result.metafile.inputs))if(input.startsWith('vendor/')&&!pinned.has(input))throw Error('Unpinned renderer input: '+input)
 const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text,css=(result.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'')+'\n'+await readFile(resolve(root,'renderer.css'),'utf8')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>'+css+'</style><div id="root"></div><script>'+js.replace(/<\/script/gi,'<\\/script')+'</script></html>'
 await writeFile(resolve(root,'dist/renderer.html'),html);await writeFile(resolve(root,'generated/renderer-resource.ts'),'// Generated self-contained complete upstream renderer.\nexport const rendererHtml='+JSON.stringify(html)+'\n');await writeFile(resolve(root,'dist/renderer-meta.json'),JSON.stringify(result.metafile,null,2)+'\n')
}
if(process.argv[1]===new URL(import.meta.url).pathname)await buildRenderer()
