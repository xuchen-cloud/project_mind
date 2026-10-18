import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import {createHash} from 'node:crypto';
import './prepare-source.mjs';
import './extract-web-helpers.mjs';
import { writeNotices } from './write-notices.mjs';
import ts from 'typescript';
import postcss from 'postcss';
import {rendererAdapter} from './renderer-build.mjs';

const root = import.meta.dirname;
const names = ['docx-engine', 'pptx-engine', 'pptx-render', 'zip-gate', 'ui', 'i18n', 'font-metrics', 'agent-core', 'ai-provider'];
const alias = Object.fromEntries(names.map(name => [`@genoffice/${name}`, resolve(root, `upstream/packages/${name}/src/index.ts`)]));
for (const [name, path] of Object.entries({
  '@genoffice/pptx-engine/custgeom': 'pptx-engine/src/custgeom.ts',
  '@genoffice/pptx-render/preset-geometry': 'pptx-render/src/preset-geometry.ts',
  '@genoffice/pptx-render/metrics': 'pptx-render/src/metrics.ts',
  '@genoffice/ai-provider/browser': 'ai-provider/src/browser.ts',
  '@genoffice/agent-core/redact-core': 'agent-core/src/redact-core.ts',
})) alias[name] = resolve(root, 'upstream/packages', path);
alias['@genoffice/ui/fonts'] = resolve(root,'upstream/packages/ui/src/fonts');
for(const name of ['headless-export','safe-external-url']) alias[`@genoffice/electron-utils/${name}`]=resolve(root,`upstream/packages/electron-utils/src/${name}.ts`);
alias['@genoffice/ui/ai-panel-prefs'] = resolve(root,'upstream/packages/ui/src/ai-panel-prefs.ts');
await mkdir(resolve(root, 'dist'), { recursive: true });
const inputs = new Set();
for (const [entry, platform] of [['engine', 'node']]) {
  const result = await build({ absWorkingDir: root, entryPoints: [`${entry}.ts`], outfile: `dist/${entry}.mjs`, platform,
    bundle: true, format: 'esm', target: 'es2022', alias, treeShaking: true, metafile: true,
    jsx: 'automatic', logLevel: 'warning', legalComments: 'eof', loader: { '.css': 'empty' }, inject: ['css-escape.ts'],
    define: { 'process.env.NODE_ENV': '"production"', 'CSS.escape': 'cssEscape' },
    banner: platform === 'node' ? { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } : undefined });
  await writeFile(resolve(root, `dist/${entry}.meta.json`), JSON.stringify(result.metafile, null, 2));
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
const worker = await build({absWorkingDir:root,entryPoints:['upstream/apps/docs/src/renderer/parse-worker.ts'],outfile:'dist/parse-worker.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',alias,metafile:true,logLevel:'warning',minify:true});
for(const input of Object.keys(worker.metafile.inputs)) inputs.add(input);
const workerCode=await readFile(resolve(root,'dist/parse-worker.mjs'),'utf8');
const renderer = await build({absWorkingDir:root,entryPoints:['renderer.tsx'],outfile:'dist/renderer.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',alias,metafile:true,jsx:'automatic',logLevel:'warning',legalComments:'eof',minify:true,inject:['css-escape.ts'],define:{'process.env.NODE_ENV':'"production"','CSS.escape':'cssEscape','__PROJECT_MIND_DOCX_WORKER__':JSON.stringify(workerCode)},loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'dataurl','.png':'dataurl'},assetNames:'assets/[name]-[hash]',plugins:[rendererAdapter(root)]});
await writeFile(resolve(root,'dist/renderer.meta.json'),JSON.stringify(renderer.metafile,null,2));
for(const input of Object.keys(renderer.metafile.inputs)) inputs.add(input);
const rendererCode=await readFile(resolve(root,'dist/renderer.mjs'),'utf8');
const rendererCss=await readFile(resolve(root,'dist/renderer.css'),'utf8');
const fonts={};
for(const output of Object.keys(renderer.metafile.outputs).filter(path=>/\.(woff2?|ttf)$/.test(path))) fonts[output.replace(/^dist\//,'./')]=(await readFile(resolve(root,output))).toString('base64');
// CFF CID subsets produce empty ToUnicode under WKWebView's native PDF.
// Keep screen fonts verbatim; print-only TrueType outlines are reproducible,
// source/hash checked assets with identical cmap/GID and advance metrics.
const printFontLock=JSON.parse(await readFile(resolve(root,'print-fonts/source-lock.json'),'utf8'));
const printFonts={};
for(const row of printFontLock.files){
  const source=await readFile(resolve(root,'upstream',row.source));
  const derived=await readFile(resolve(root,'print-fonts',row.file));
  if(createHash('sha256').update(source).digest('hex')!==row.sourceSha256||createHash('sha256').update(derived).digest('hex')!==row.sha256||derived.length!==row.bytes)throw Error(`Print font provenance mismatch: ${row.file}`);
  const prefix=basename(row.file,'.woff2')+'-';
  const fontOutput=Object.keys(fonts).find(name=>basename(name).startsWith(prefix));
  if(!fontOutput)throw Error(`Missing screen font for print mapping: ${row.file}`);
  printFonts[fontOutput]=derived.toString('base64');
}
const fontBootstrap='let css='+JSON.stringify(rendererCss)+';const fonts='+JSON.stringify(fonts)+';const printFonts='+JSON.stringify(printFonts)+';window.__projectMindWordPrintFonts=new Map();for(const [name,data]of Object.entries(fonts)){const blob=data=>URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))]));const url=blob(data);css=css.split(name).join(url);if(printFonts[name])window.__projectMindWordPrintFonts.set(url,blob(printFonts[name]));}const style=document.createElement("style");style.textContent=css;document.head.append(style);';
const rendererHtml='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module">'+(fontBootstrap+rendererCode).replace(/<\/script/gi,'<\\/script')+'</script></html>';
await writeFile(resolve(root,'dist/renderer.html'),rendererHtml);
await writeFile(resolve(root,'dist/renderer-resource.mjs'),'export const rendererHtml='+JSON.stringify(rendererHtml)+';\n');
const editorBuild=await build({absWorkingDir:root,entryPoints:['editor.ts'],outfile:'dist/editor.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',alias,treeShaking:true,metafile:true,jsx:'automatic',logLevel:'warning',legalComments:'eof',loader:{'.css':'empty'},inject:['css-escape.ts'],define:{'process.env.NODE_ENV':'"production"','CSS.escape':'cssEscape'}});
await writeFile(resolve(root,'dist/editor.meta.json'),JSON.stringify(editorBuild.metafile,null,2));
for(const input of Object.keys(editorBuild.metafile.inputs)) inputs.add(input);
const program = ts.createProgram([resolve(root, 'types.ts'), resolve(root, 'editor-types.ts')], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, outDir: resolve(root, 'dist'),
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
program.emit();
await writeFile(resolve(root, 'dist/editor.d.mts'), 'export { mountEditor, mountFullEditor } from "./editor-types";\n');
await writeFile(resolve(root, 'dist/engine.d.mts'), 'export { inspect, edit, DocxError } from "./types";\n');
await writeFile(resolve(root, 'dist/editor-shell.css'), await readFile(resolve(root, 'editor-shell.css')));
// Keep original SDK document rules and discard its unrelated app/ribbon chrome.
const sdkCssPath = 'apps/docs/src/renderer/styles.css';
const sourceCss = postcss.parse(await readFile(resolve(root, 'upstream', sdkCssPath), 'utf8'));
function documentRules(node) {
  if (node.type === 'rule') return /\.doc-/.test(node.selector) ? node.clone() : null;
  if (node.type !== 'atrule' || !node.nodes) return null;
  const children = node.nodes.map(documentRules).filter(Boolean);
  return children.length ? node.clone({ nodes: children }) : null;
}
const nativeCss = postcss.root({ nodes: sourceCss.nodes.map(documentRules).filter(Boolean) }).toString();
await writeFile(resolve(root, 'dist/editor-document.css'), `/* GenOffice ${sdkCssPath}, unchanged document rules. */\n@scope (.office-docx__paper) {\n${nativeCss}\n}\n`);
inputs.add(`upstream/${sdkCssPath}`);
const sourceLock = JSON.parse(await readFile(resolve(root, 'source-lock.json'), 'utf8'));
const lockedPaths = new Set(sourceLock.files.map(row => `upstream/${row.path}`));
for (const input of inputs) if (input.startsWith('upstream/') && !lockedPaths.has(input)) throw Error(`Unpinned source input: ${input}`);
await writeNotices(root, inputs, sourceLock);
await writeFile(resolve(root, 'dist/runtime-manifest.json'), JSON.stringify({
  engine: 'engine.mjs', editor: 'editor.mjs', engineAssets: [], browserAssets: ['editor-document.css', 'editor-shell.css', 'renderer.html', 'renderer.mjs', 'renderer.css', 'parse-worker.mjs'], nativeSidecars: [],
  notices: 'THIRD-PARTY-NOTICES.txt', sourceCommit: sourceLock.commit,
}, null, 2) + '\n');
