import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildImportPath} from './build-import-path.mjs';
import ts from 'typescript';
import {markEditorChrome} from '../editor-chrome/build-adapter.mjs';
import {installTextEditTransforms} from './parity-text-edit-build.mjs';
export function parityPlugins(root,{browser=false}={}) {return [{name:'pinned-parity',setup(b){
 if(browser)installTextEditTransforms(b,root);
 if(browser)b.onLoad({filter:/parity-entry\.tsx$/},args=>({contents:readFileSync(args.path,'utf8').replaceAll('min(16px,35%)','min(var(--editor-chrome-fade-size),35%)').replaceAll('min(24px,35%)','min(var(--editor-chrome-fade-block-size),35%)'),loader:'tsx'}));
 // Preserve pinned source bytes while making generated IDs/timestamps replayable across browser/native.
 b.onLoad({filter:/(?:pptx-engine[\\/]src[\\/](?:xml-utils|index|sections|generate|comments|insert|headerfooter)\.ts|parity-handlers\.mjs)$/},args=>{
  let source=readFileSync(args.path,'utf8');
  source=source.replace(/globalThis\.crypto\.randomUUID\(\)/g,'replayUUID()').replace(/new Date\(\)\.toISOString\(\)/g,'replayDateISO()').replace(/Date\.now\(\)/g,'replayNow()');
  source=source.replace(/import \{ randomUUID \} from 'node:crypto'/,"const randomUUID=replayUUID;");
  source=source.replace(/function fieldGuid\(\): string \{[\s\S]*?\n\}/,"function fieldGuid(): string {return replayUUID().toUpperCase()}");
  return {contents:`import {replayUUID,replayNow,replayDateISO} from ${JSON.stringify(buildImportPath(root,'parity-context.ts'))};\n${source}`,loader:args.path.endsWith('.mjs')?'js':'ts'};
 });
 b.onLoad({filter:/slides[\\/]src[\\/]renderer[\\/]components[\\/]Ribbon\.tsx$/},args=>({contents:markEditorChrome(ts,readFileSync(args.path,'utf8').replace(/        \{!IS_MAC && \([\s\S]*?<IconSave size=\{16\} \/>\n        <\/button>/, '')
  .replace(/        <label\n          className=\{`autosave-toggle[\s\S]*?<\/label>/, '')
  // Keep every editing tab in the scroll rail; output/save belong to the host.
  .replace("{TABS.filter((tb)", '<div className="pm-ribbon-tab-list" role="group" aria-label="编辑选项卡">{TABS.filter((tb)')
  .replace('<span className="ribbon-tabs-spacer" />', '</div><span className="ribbon-tabs-spacer" />')
  // Presenter view is explicitly out of product scope. Keep the pinned source
  // and the neighbouring ordinary slideshow/custom-show controls unchanged.
  .replace(/<button\s+className="rb-big"\s+disabled=\{!hasDoc\}\s+onClick=\{\(\) => onPresenterView\(true\)\}[\s\S]*?<\/button>/, '')
  .replace('onClick={onSave}', 'data-keep-edit="" onMouseDown={e => e.preventDefault()} onClick={onSave}'),args.path),loader:'tsx'}));
 b.onLoad({filter:/file-actions\.ts$/},args=>{
  let source=readFileSync(args.path,'utf8').replace(": t('appExportImagesFailed'",": (r as any).canceled ? '已取消导出' : t('appExportImagesFailed'").replace(": t('appExportPdfFailed'",": (r as any).canceled ? '已取消导出' : t('appExportPdfFailed'");
  source="import {checkpointTextEdit} from "+JSON.stringify(buildImportPath(root,'parity-text-edit.ts'))+";\n"+source.replaceAll('    await flushActiveEdit(ctx)','    if (!await checkpointTextEdit()) await flushActiveEdit(ctx)');
  source="import {currentPptxEpoch,assertPptxEpoch} from "+JSON.stringify(buildImportPath(root,'parity-protocol.ts'))+";\n"+source
   .replace('export async function exportImages(ctx: ActionCtx): Promise<void> {','export async function exportImages(ctx: ActionCtx, hostOutput = false): Promise<void> {\n  const epoch = currentPptxEpoch()')
   .replace('export async function exportPdf(ctx: ActionCtx, outPath?: string): Promise<boolean> {','export async function exportPdf(ctx: ActionCtx, outPath?: string, hostOutput = false): Promise<boolean> {\n  const epoch = currentPptxEpoch()')
   .replace('const r = await window.slidesApi.exportImages(', 'assertPptxEpoch(epoch);\n    const r = await window.slidesApi.exportImages(')
   .replace('const r = await window.slidesApi.exportPdf(', 'assertPptxEpoch(epoch);\n    const r = await window.slidesApi.exportPdf(');
  // Preserve original status messages while allowing host promises to report real failures.
  source=source.replaceAll('    ctx.setStatus(\n      r.ok', "    if (hostOutput && !r.ok && !(r as any).canceled) throw new Error(r.error ?? t('appUnknownError'))\n    ctx.setStatus(\n      r.ok")
   .replace("ctx.setStatus(t('appExportImagesFailed', { error: String(err) }))", "ctx.setStatus(t('appExportImagesFailed', { error: String(err) })); if (hostOutput) throw err")
   .replace("ctx.setStatus(t('appExportPdfFailed', { error: String(err) }))", "ctx.setStatus(t('appExportPdfFailed', { error: String(err) })); if (hostOutput) throw err");
  // Re-read exact layouts after pending font loads, before baking SVG/PNG.
  source=source.replaceAll('const visible = ctx.slides.filter','let visible = ctx.slides.filter');
  const refresh="ctx = {...ctx, slides: await window.slidesApi.getRenderSlides()}; visible = ctx.slides.filter(s => !s.hidden);\n";
  source=source.replace('const pngs = await renderSlidesToPngBase64(visible, ctx.images)',refresh+'const pngs = await renderSlidesToPngBase64(visible, ctx.images)');
  source=source.replace('const { pages, fontCss } = await renderSlidesToPdfPages(visible, ctx.images)',refresh+'const { pages, fontCss } = await renderSlidesToPdfPages(visible, ctx.images)');
  return {contents:source,loader:'ts'};
 });
 b.onLoad({filter:/PrintDialog\.tsx$/},args=>({contents:readFileSync(args.path,'utf8')
  .replace('const rendered = await renderSlidesToPngBase64(slides, images)','const freshSlides = await window.slidesApi.getRenderSlides(); const rendered = await renderSlidesToPngBase64(freshSlides, images)')
  .replace('void (async () => {\n      try {','setPngs(null); void (async () => {\n      try {')
  .replace('// eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [])','// Layout changes include newly loaded exact font metrics.\n  }, [slides, images])'),loader:'tsx'}));
 b.onLoad({filter:/SlideCanvas\.tsx$/},args=>({contents:readFileSync(args.path,'utf8').replace('if (hidePhPrompts) return null','if (hidePhPrompts || (node as any).projectMindSuppressPrompt) return null'),loader:'tsx'}));
 b.onResolve({filter:/\?raw$/},args=>({path:join(args.resolveDir,args.path.slice(0,-4)),namespace:'parity-raw'}));
 b.onLoad({filter:/.*/,namespace:'parity-raw'},args=>({contents:`export default ${JSON.stringify(readFileSync(args.path,'utf8'))}`,loader:'js'}));
 b.onResolve({filter:/^@genoffice\//},args=>{let [pkg,...rest]=args.path.slice(11).split('/');let target=rest.join('/');
 const known={'pptx-ops/op-docs':'op-docs.ts','pptx-ops/font-size':'font-size.ts','pptx-engine/identity':'identity.ts','pptx-render/preset-geometry':'preset-geometry.ts','ai-provider/browser':'browser.ts','agent-core/redact-core':'redact-core.ts','docx-engine/math':'math.ts','docx-engine/metafile':'metafile.ts','electron-utils/headless-export':'headless-export.ts','electron-utils/safe-external-url':'safe-external-url.ts'};
 let p=join(root,'vendor/packages',pkg,'src',known[pkg+'/'+target]??(target||'index.ts'));
 if(!existsSync(p)){for(const ext of ['.ts','.tsx'])if(existsSync(p+ext)){p+=ext;break}}
 return {path:p};
 });
 if(browser){
 b.onResolve({filter:/parity-context(?:\.ts)?$/},()=>({path:join(root,'parity-context-browser.ts')}));
 b.onResolve({filter:/^node:(crypto|zlib|fs|stream\/promises)$/},()=>({path:join(root,'browser-node-shims.ts')}));
 b.onResolve({filter:/\/ai\/AiPanel$|\/components\/AiAskPopover$/},()=>({path:join(root,'excluded-ai.tsx')}));
 }
 }}]}
