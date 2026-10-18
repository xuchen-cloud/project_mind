import ts from 'typescript';
import {adaptLocaleStrings,adaptLocaleProvider,adaptLocaleBootstrap} from './locale-adapter.mjs';
import {adaptFormulaStreamHold,adaptPreloadCompletion,adaptLoadedVisualScroll} from './initialization-adapter.mjs';
import {replaceStatusZoom,markEditorChrome} from '../../editor-chrome/build-adapter.mjs';
import{build}from'esbuild';import{readFile,writeFile,mkdir,rm}from'node:fs/promises';import{resolve,dirname}from'node:path';import{existsSync}from'node:fs';import{disposedAutoHeightPatch}from'./patch-univer.mjs';
const root=resolve(import.meta.dirname,'..')
export async function buildRenderer(){
 await rm(resolve(root,'dist/renderer'),{recursive:true,force:true});await mkdir(resolve(root,'dist/renderer'),{recursive:true});
 const result=await build({absWorkingDir:root,entryPoints:['renderer-entry.ts'],outdir:'dist/renderer',entryNames:'[name]-[hash]',chunkNames:'chunks/[name]-[hash]',assetNames:'assets/[name]-[hash]',outExtension:{'.js':'.mjs'},bundle:true,splitting:true,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',write:true,minify:true,metafile:true,define:{'process.env.NODE_ENV':'"production"','import.meta.hot':'undefined','import.meta.env.DEV':'false'},loader:{'.ttf':'file','.woff':'file','.woff2':'file','.svg':'file','.png':'file','.jpg':'file'},plugins:[disposedAutoHeightPatch,{name:'fixed-renderer-bridge',setup(b){
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/(formula-stream-hold|univer-sync)\.ts$/},async a=>({contents:(a.path.endsWith('formula-stream-hold.ts')?adaptFormulaStreamHold:adaptPreloadCompletion)(await readFile(a.path,'utf8')),loader:'ts',resolveDir:dirname(a.path)}))
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/i18n\/(strings\.ts|locale\.tsx)$/},async a=>({contents:(a.path.endsWith('strings.ts')?adaptLocaleStrings:adaptLocaleProvider)(await readFile(a.path,'utf8')),loader:a.path.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(a.path)}))
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/main\.tsx$/},async a=>{
 let source=adaptLocaleBootstrap(await readFile(a.path,'utf8'));
 const replace=(from,to)=>{if(!source.includes(from))throw Error('Upstream initialization point changed: '+from);source=source.replace(from,to)};
 replace('  const loads: Promise<unknown>[] = [registerCellFontAliases()]', "  performance.mark('office-xlsx:font-load-start');\n  const loads: Promise<unknown>[] = [registerCellFontAliases()]");
 replace('  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 3000))])', "  const result=await Promise.race([Promise.all(loads).then(()=> 'loaded'), new Promise<string>((resolve) => setTimeout(()=>resolve('timeout'), 3000))]);performance.mark('office-xlsx:font-load-'+result);performance.mark('office-xlsx:font-load-end')");
 replace('  ReactDOM.createRoot(root!).render(', "  performance.mark('office-xlsx:react-render');\n  ReactDOM.createRoot(root!).render(");
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}
 })
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/App\.tsx$/},async a=>{let source=adaptLoadedVisualScroll(await readFile(a.path,'utf8'));const replace=(from,to)=>{if(!source.includes(from))throw Error('Upstream bridge point changed: '+from);source=source.replace(from,to)};
 replace('const [pendingEdits, setPendingEdits] = useState(0)', 'const [pendingEdits, setPendingEditsState] = useState(0);const setPendingEdits = useCallback((value: Parameters<typeof setPendingEditsState>[0])=>{setPendingEditsState(value);queueMicrotask(()=>window.__projectMindSheetsHost.edited())},[])');
 replace('univerRef.current = runtime','univerRef.current = runtime; window.__projectMindSheetsHost.attach(runtime)');
 replace('return handleSaveImpl(saveContext(), mode, quiet, explicitTarget)',"return mode === 'recovery' ? handleSaveImpl(saveContext(), mode, quiet, explicitTarget) : window.__projectMindSheetsHost.requestSave()");
 replace('handleSaveRef.current = handleSave','handleSaveRef.current = handleSave; window.__projectMindSheetsHost.render({univerRef,lazyWorkbookRef,commitActiveEditor,saveContext,openingWorkbook,isCellEditing:()=>editingCellRef.current,calcManual,output:async(action)=>{await menuActionRef.current(action)}})');
 // File owns the only default autosave timer; upstream save actions remain explicit.
 replace("useAutoSavePref('ai-sheets-auto-save', window.desktopApi)",'useState(false)');
 // Keep the real upstream menu executors awaitable for the host output handle.
 replace('const menuActionRef = useRef<(action: MenuAction) => void>(() => {})', 'const menuActionRef = useRef<(action: MenuAction) => Promise<void>>(async() => {})');
 replace('menuActionRef.current = (action) => {', 'menuActionRef.current = async(action) => {');
 replace('void openPrintPreviewHost(pageLayoutContext()).then(setPrintHost)', 'const host=await openPrintPreviewHost(pageLayoutContext());if(!host)throw Error("无法打开打印设置");setPrintHost(host)');
 replace('void handleExportPdfImpl(pageLayoutContext())', 'await handleExportPdfImpl(pageLayoutContext())');
 replace('void handleExportCsvImpl(csvExportContext())', 'await handleExportCsvImpl(csvExportContext())');
 replace('        !state ||\n        !shouldRunSaveTick', '        !state || window.__projectMindSheetsHost.isReadOnly() ||\n        !shouldRunSaveTick');
 // These upstream paths write directly to the gateway journal, outside Univer mutations.
 replace('  ): Promise<ApplyOutcome> {\n    const runtime = univerRef.current', '  ): Promise<ApplyOutcome> {\n    if(window.__projectMindSheetsHost.isReadOnly())return Promise.resolve({ok:false,reason:"当前工作簿只读"});\n    const runtime = univerRef.current');
 replace('      verifyBeforeApply: () =>\n        lazyWorkbookRef.current !== state ||', '      verifyBeforeApply: () =>\n        window.__projectMindSheetsHost.isReadOnly() || lazyWorkbookRef.current !== state ||');
 replace('chartEditRef.current = (editKey, edit) => applyChartEditImpl(visualSyncContext(), editKey, edit)', 'chartEditRef.current = (editKey, edit) => {if(!window.__projectMindSheetsHost.isReadOnly())applyChartEditImpl(visualSyncContext(), editKey, edit)}');
 replace('shapeEditRef.current = (visualId, changes) =>\n    applyShapeEditImpl(visualSyncContext(), visualId, changes)', 'shapeEditRef.current = (visualId, changes) => {if(!window.__projectMindSheetsHost.isReadOnly())applyShapeEditImpl(visualSyncContext(), visualId, changes)}');
 replace('  function applyProtectedRanges(ranges: readonly { name: string; sqref: string }[]): string | null {', '  function applyProtectedRanges(ranges: readonly { name: string; sqref: string }[]): string | null {\n    if(window.__projectMindSheetsHost.isReadOnly())return "当前工作簿只读"');

 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}})
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/ExcelShell\.tsx$/},async a=>{let source=await readFile(a.path,'utf8');
 const replace=(from,to)=>{if(!source.includes(from))throw Error('Upstream shell bridge changed: '+from);source=source.replace(from,to)};
 const cut=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);if(start<0||end<0)throw Error('Upstream shell section changed: '+from);source=source.slice(0,start)+source.slice(end)};
 source=replaceStatusZoom(ts,source,a.path,'<StatusZoom value={clampZoomPercent(zoomPercent)} min={SHEET_ZOOM_MIN} max={SHEET_ZOOM_MAX} step={1} onChange={value=>onCommand(`zoom:${value}`)} onStep={direction=>onCommand(direction===1?\"zoom-in\":\"zoom-out\")} onValueClick={()=>setShowZoomDialog(true)}/>',resolve(root,'../editor-chrome/StatusZoom.tsx'));
 source=markEditorChrome(ts,source,a.path);
 // Keep the upstream anchor scope and dismiss handlers, but paint real ribbon
 // menus in the top layer so the horizontal scroller cannot clip their options.
 const menuPanel=/<div className="menu-select-drop(?: rb-shape-gallery)?"/g;
 if([...source.matchAll(menuPanel)].length!==3)throw Error('Upstream anchored menu panels changed');
 source=source.replace(menuPanel,match=>match+' popover="manual" ref={node=>{if(node&&!node.matches(":popover-open"))node.showPopover()}}');
 cut('  // Persisted so a closed AI panel','  const [showFormatCells');
 replace("    } else if (command === 'ai-open-panel') setIsCopilotOpen(true)\n    else if (command === 'ai-toggle-panel') setIsCopilotOpen((v) => !v)\n    else if",'    } else if');
 replace("className={`app-shell ${isCopilotOpen ? '' : 'copilot-collapsed'}`}",'className="app-shell copilot-collapsed"');
 cut('        <AiChatPanel\n','        <div className="sheet-main">');
 cut('          {aiSelectionAskAnchor &&','          {/* Status bar');
 replace(`          onAiRun={(nextPrompt) => {
            setIsCopilotOpen(true)
            onSend(nextPrompt)
          }}
          aiOpen={isCopilotOpen}
          onAiToggle={() => setIsCopilotOpen((open) => !open)}`,`          onAiRun={() => {}}
          aiOpen={false}
          onAiToggle={() => {}}`);
 const aiStart=source.indexOf("      <RibbonGroup label={t('appGroupAiAssistant')}>");const aiEnd=source.indexOf("      <RibbonGroup label={t('appGroupClipboard')}>",aiStart);if(aiStart<0||aiEnd<0)throw Error('Upstream AI shell changed');source=source.slice(0,aiStart)+source.slice(aiEnd);
 cut(`          <button\n            type="button"\n            className="qa-btn"\n            data-tip={t('appSaveTitle')}`, `          <button\n            type="button"\n            className="qa-btn"\n            data-tip={t('appUndo')}`);
 cut('          <label\n            className={`autosave-toggle', '          {visibleTabs.map');
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}})
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/(csv-export|page-layout-actions)\.ts$/},async a=>{
 let source=await readFile(a.path,'utf8');const replace=(from,to)=>{if(!source.includes(from))throw Error('Upstream output bridge changed: '+from);source=source.replace(from,to)};
 replace('  } catch (error: unknown) {', '  } catch (error: unknown) {\n    window.__projectMindSheetsHost.outputFailed(error)');
 if(a.path.endsWith('csv-export.ts')){
  replace('  if (!runtime || !active) return', '  if (!runtime || !active) {window.__projectMindSheetsHost.outputFailed("当前没有可导出的工作表");return}');
  for(const key of ['appCsvExportNeedsFullLoad','appCsvExportTooLarge'])replace(`ctx.setMessage(t('${key}'))`, `ctx.setMessage(t('${key}'));window.__projectMindSheetsHost.outputFailed(t('${key}'))`);
 }else{
  replace('    if (!payload) return false', '    if (!payload) {window.__projectMindSheetsHost.outputFailed("无法准备 PDF 打印文档");return false}');
  // Print dialog overrides stay local when the source workbook is readonly.
  replace('applySetting: (rest) => handlePageLayoutCommand(ctx, rest)', 'applySetting: (rest) => {if(!window.__projectMindSheetsHost.isReadOnly())handlePageLayoutCommand(ctx, rest)}');
 }

 return{contents:source,loader:'ts',resolveDir:dirname(a.path)}
 })
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/PrintDialog\.tsx$/},async a=>{
 let source=await readFile(a.path,'utf8');
 for(const[from,to]of [
  ['    setSettings((prev) => ({ ...prev, ...patch }))', '    setJob(null);setSettings((prev) => ({ ...prev, ...patch }))'],
  ['    const timer = window.setTimeout(() => {', '    setJob(null);const timer = window.setTimeout(() => {'],
  ['onClick={onPageSetup}', 'disabled={window.__projectMindSheetsHost.isReadOnly()} onClick={()=>{if(!window.__projectMindSheetsHost.isReadOnly())onPageSetup()}}'],
 ]){if(!source.includes(from))throw Error('Upstream print settings bridge changed: '+from);source=source.replace(from,to)}
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}
 })
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/SheetTabContextMenu\.tsx$/},async a=>{
 let source=await readFile(a.path,'utf8');
 for(const[from,to]of [
  ['disabled={options.disabled}', 'disabled={options.disabled || (window.__projectMindSheetsHost.isReadOnly() && label!==t("dlgSheetTabSelectAll") && label!==t("dlgSheetTabUngroup"))}'],
  ['const locked = protection.locked', 'const locked = protection.locked || window.__projectMindSheetsHost.isReadOnly()'],
 ]){if(!source.includes(from))throw Error('Upstream sheet menu lock changed: '+from);source=source.replace(from,to)}
 return{contents:source,loader:'tsx',resolveDir:dirname(a.path)}
 })
 b.onLoad({filter:/apps\/sheets\/src\/renderer\/merge-workbooks\.ts$/},async a=>{
 // Fixed upstream passes `width`, but its pinned Univer command consumes `value`.
 let source=await readFile(a.path,'utf8')
 for(const[from,to]of [['width: width.width,','value: width.width,'],['height: Math.round((row.height * 96) / 72)','height: (row.height * 96) / 72']]){
  if(!source.includes(from))throw Error('Upstream merge dimensions bridge changed: '+from)
  source=source.replace(from,to)
 }
 return{contents:source,loader:'ts',resolveDir:dirname(a.path)}
 })
 // File-loader strings are relative to the output module, whereas FontFace/img
 // URLs resolve against renderer.html. Preserve the output module as their base.
 b.onResolve({filter:/\.(?:ttf|woff2?|svg|png|jpg)(?:\?url)?$/},a=>{
  if(a.namespace==='asset-url')return{path:a.path,namespace:'file'};
  if(a.kind!=='import-statement')return;
  let path=a.path.replace(/\?url$/,'');
  if(path.startsWith('@genoffice/')){const[pkg,...rest]=path.slice(11).split('/');path=resolve(root,'vendor/packages',pkg,'src',...rest)}else path=resolve(a.resolveDir,path);
  return{path,namespace:'asset-url'}
 });
 b.onLoad({filter:/.*/,namespace:'asset-url'},a=>({contents:'import asset from '+JSON.stringify(a.path)+';export default new URL(asset,import.meta.url).href',loader:'js'}));
 b.onResolve({filter:/^@genoffice\//},args=>{const[pkg,...rest]=args.path.slice(11).split('/');let path=resolve(root,'vendor/packages',pkg,'src',rest.join('/').replace(/\?url$/,'')||'index.ts');if(!existsSync(path))for(const ext of ['.ts','.tsx','/index.ts'])if(existsSync(path+ext)){path+=ext;break}return{path}})
 b.onResolve({filter:/^node:/},()=>({path:resolve(root,'fork-research/web-node-shims.ts')}))
 b.onResolve({filter:/\?raw$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));b.onLoad({filter:/.*/,namespace:'raw'},async a=>({contents:'export default '+JSON.stringify(await readFile(a.path,'utf8')),loader:'js'}))
 }}]})
 const manifest=JSON.parse(await readFile(resolve(root,'upstream.json'),'utf8'));const pinned=new Set(manifest.files.map(f=>f.destination));for(const input of Object.keys(result.metafile.inputs))if(input.startsWith('vendor/')&&!pinned.has(input))throw Error('Unpinned renderer input: '+input)
 const entry=Object.entries(result.metafile.outputs).find(([,value])=>value.entryPoint==='renderer-entry.ts');
 if(!entry)throw Error('Missing renderer entry output');
 const relativeOutput=path=>path.replace(/^dist\//,'');
 const mainImports=entry[1].imports.filter(item=>item.kind==='dynamic-import'&&result.metafile.outputs[item.path]?.entryPoint==='vendor/apps/sheets/src/renderer/main.tsx');
 if(mainImports.length!==1)throw Error('Expected exactly one renderer entry dynamic main chunk');
 const mainPreload='<link rel="modulepreload" href="./'+relativeOutput(mainImports[0].path)+'">';
 const shellCss=(await Promise.all(['renderer.css','../editor-chrome/status-bar.css','../editor-chrome/editor-chrome.css'].map(path=>readFile(resolve(root,path),'utf8')))).join('\n');
 await writeFile(resolve(root,'dist/renderer/host.css'),shellCss);
 const css=entry[1].cssBundle;
 const reportResourceError="addEventListener('error',event=>{const target=event.target;if(target instanceof HTMLScriptElement||target instanceof HTMLLinkElement)parent.postMessage({officeXlsx:true,type:'error',value:'Excel renderer resource failed: '+(target.src||target.href)},'*')},true);";
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script>'+reportResourceError+'</script>'+mainPreload+(css?'<link rel="stylesheet" href="./'+relativeOutput(css)+'">':'')+'<link rel="stylesheet" href="./renderer/host.css"></head><body><div id="root"></div><script type="module" src="./'+relativeOutput(entry[0])+'"></script></body></html>';
 await writeFile(resolve(root,'dist/renderer.html'),html);
 await writeFile(resolve(root,'dist/renderer-resources.json'),JSON.stringify({entry:'renderer.html',files:['renderer.html','renderer/host.css',...Object.keys(result.metafile.outputs).map(relativeOutput)].sort()},null,2)+'\n');
 await writeFile(resolve(root,'dist/renderer-meta.json'),JSON.stringify(result.metafile,null,2)+'\n');
 // Retire the old ignored generated artifact so a stale source import cannot conceal the resource contract.
 await rm(resolve(root,'generated/renderer-resource.ts'),{force:true});
}
if(process.argv[1]===new URL(import.meta.url).pathname)await buildRenderer()
