import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {createHash} from 'node:crypto';
import './prepare-source.mjs';
import './extract-web-helpers.mjs';
import { writeNotices } from './write-notices.mjs';
import ts from 'typescript';
import postcss from 'postcss';
import {rendererAdapter} from './renderer-build.mjs';
import {adaptSummaryReader} from './authoring-summary-build.mjs';

const root = import.meta.dirname;
const names = ['docx-engine', 'pptx-engine', 'pptx-render', 'zip-gate', 'ui', 'i18n', 'font-metrics', 'agent-core', 'ai-provider'];
const alias = Object.fromEntries(names.map(name => [`@genoffice/${name}`, resolve(root, `upstream/packages/${name}/src/index.ts`)]));
// Creation accepts no canvas/image elements. Keep linkedom's own inert shim
// bundled rather than probing an optional native canvas dependency at runtime.
alias.canvas = resolve(root, 'node_modules/linkedom/commonjs/canvas-shim.cjs');
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
// Force all react/react-dom imports to the local node_modules copy. Without
// this, packages/editor-chrome/preview-view.ts resolves react from the project
// root node_modules (a different version), creating two React copies in the
// bundle and crashing hooks with "Cannot read properties of null (reading 'useRef')".
alias.react = resolve(root, 'node_modules/react');
alias['react-dom'] = resolve(root, 'node_modules/react-dom');
await mkdir(resolve(root, 'dist'), { recursive: true });
const inputs = new Set();
for (const [entry, platform] of [['engine', 'node']]) {
  const result = await build({ absWorkingDir: root, entryPoints: [`${entry}.ts`], outfile: `dist/${entry}.mjs`, platform,
    bundle: true, format: 'esm', target: 'es2022', alias, treeShaking: true, metafile: true,
    jsx: 'automatic', logLevel: 'warning', legalComments: 'eof', loader: { '.css': 'empty' }, inject: ['css-escape.ts'],
    plugins: [{ name: 'create-html-dom', setup(build) {
      build.onLoad({filter:/[\\/]cli[\\/]src[\\/]formats[\\/]docx\.ts$/},async args=>({contents:adaptSummaryReader(await readFile(args.path,'utf8')),loader:'ts'}));
      build.onResolve({filter:/^(supports-color|bufferutil|utf-8-validate)$/},args=>({path:args.path,namespace:'unavailable-optional'}));
      build.onLoad({filter:/.*/,namespace:'unavailable-optional'},args=>({contents:`throw new Error(${JSON.stringify('Optional module disabled in the Office worker')});`,loader:'js'}));
      build.onResolve({filter:/^\.\.?\/dom$/,namespace:'file'}, args=>/[\\/]upstream[\\/]packages[\\/]cli[\\/]src[\\/]/.test(args.importer)?{path:resolve(root,'authoring-dom.ts')}:undefined);
      build.onResolve({filter:/^\.\/image-source$/,namespace:'file'}, args=>/[\\/]upstream[\\/]packages[\\/]cli[\\/]src[\\/]formats[\\/]/.test(args.importer)?{path:resolve(root,'authoring-image.ts')}:undefined);
      build.onLoad({filter:/jsdom[\\/]lib[\\/]jsdom[\\/]utils\.js$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('exports.Canvas = require("canvas");','exports.Canvas = null;'),loader:'js'}));
      // CSSOM's optional cssstyle upgrade relies on sloppy-mode assignment to a
      // getter-only parentRule. Use its own declared implementation in ESM.
      build.onLoad({filter:/@acemir[\\/]cssom[\\/]lib[\\/].*\.js$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/try \{\s*CSSOM\.CSSStyleDeclaration = require\("cssstyle"\)\.CSSStyleDeclaration;\s*\} catch \(e\) \{[\s\S]*?\}/g,'').replace('eval(errorType)', '(errorType === "TypeError" ? TypeError : errorType === "DOMException" ? DOMException : (() => { throw new TypeError("Unsupported CSSOM error constructor"); })())'),loader:'js'}));
      build.onLoad({filter:/jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]helpers[\\/]style-rules\.js$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/fs\.readFileSync\([\s\S]*?\);/,JSON.stringify(await readFile(resolve(root,'node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'),'utf8'))+';'),loader:'js'}));
      build.onLoad({filter:/jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/},async args=>({contents:(await readFile(args.path,'utf8')).replace(/require\.resolve\("\.\/xhr-sync-worker\.js"\)/g,'"disabled-sync-xhr"'),loader:'js'}));
      build.onLoad({ filter: /[\\/]renderer[\\/]ai[\\/]protocol\.ts$/ }, async args => ({
        contents: `import { DOMParser, Node } from ${JSON.stringify(resolve(root, 'create-dom.ts'))};\n` + await readFile(args.path, 'utf8'),
        loader: 'ts',
      }));
    } }],
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
const printFontPaths={};
await mkdir(resolve(root,'dist/print-fonts'),{recursive:true});
for(const row of printFontLock.files){
  const source=await readFile(resolve(root,'upstream',row.source));
  const derived=await readFile(resolve(root,'print-fonts',row.file));
  if(createHash('sha256').update(source).digest('hex')!==row.sourceSha256||createHash('sha256').update(derived).digest('hex')!==row.sha256||derived.length!==row.bytes)throw Error(`Print font provenance mismatch: ${row.file}`);
  const prefix=basename(row.file,'.woff2')+'-';
  const fontOutput=Object.keys(fonts).find(name=>basename(name).startsWith(prefix));
  if(!fontOutput)throw Error(`Missing screen font for print mapping: ${row.file}`);
  printFonts[fontOutput]=derived.toString('base64');
  const printPath='print-fonts/'+row.file;
  await copyFile(resolve(root,'print-fonts',row.file),resolve(root,'dist',printPath));
  printFontPaths[fontOutput]=printPath;
}
const fontBootstrap='let css='+JSON.stringify(rendererCss)+';const fonts='+JSON.stringify(fonts)+';const printFonts='+JSON.stringify(printFonts)+';window.__projectMindWordPrintFonts=new Map();for(const [name,data]of Object.entries(fonts)){const blob=data=>URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))]));const url=blob(data);css=css.split(name).join(url);if(printFonts[name])window.__projectMindWordPrintFonts.set(url,blob(printFonts[name]));}const style=document.createElement("style");style.textContent=css;document.head.append(style);';
const rendererHtml='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module">'+(fontBootstrap+rendererCode).replace(/<\/script/gi,'<\\/script')+'</script></html>';
await writeFile(resolve(root,'dist/renderer.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="./renderer.css"></head><body><div id="root"></div><script type="module" src="./renderer.mjs"></script></body></html>\n');
await writeFile(resolve(root,'dist/print-fonts.json'),JSON.stringify(printFontPaths,null,2)+'\n');
const rendererFiles=[...Object.keys(renderer.metafile.outputs).map(file=>file.replace(/^dist\//,'')),'renderer.html','print-fonts.json',...Object.values(printFontPaths)].sort();
await writeFile(resolve(root,'dist/renderer-resources.json'),JSON.stringify({entry:'renderer.html',files:rendererFiles},null,2)+'\n');
await writeFile(resolve(root,'dist/renderer-resource.mjs'),'export const rendererHtml='+JSON.stringify(rendererHtml)+';\n');
const editorBuild=await build({absWorkingDir:root,entryPoints:['editor.ts'],outfile:'dist/editor.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',alias,treeShaking:true,metafile:true,jsx:'automatic',logLevel:'warning',legalComments:'eof',loader:{'.css':'empty'},inject:['css-escape.ts'],define:{'process.env.NODE_ENV':'"production"','CSS.escape':'cssEscape'}});
await writeFile(resolve(root,'dist/editor.meta.json'),JSON.stringify(editorBuild.metafile,null,2));
for(const input of Object.keys(editorBuild.metafile.inputs)) inputs.add(input);
const fullEditorBuild=await build({absWorkingDir:root,entryPoints:['full-editor.ts'],outfile:'dist/full-editor.mjs',platform:'browser',bundle:true,format:'esm',target:'es2022',treeShaking:true,metafile:true,logLevel:'warning',legalComments:'eof'});
await writeFile(resolve(root,'dist/full-editor.meta.json'),JSON.stringify(fullEditorBuild.metafile,null,2));
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
await writeFile(resolve(root, 'dist/full-editor.d.mts'), 'export { mountFullEditor } from "./editor-types";\n');
await writeFile(resolve(root, 'dist/engine.d.mts'), 'export { inspect, edit, create, catalog, DocxError } from "./types";\n');
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
  engine: 'engine.mjs', operations: ['inspect', 'edit', 'create'], createContent: { format: 'genoffice-html-and-operations', maxBytes: 2097152 }, editor: 'editor.mjs', engineAssets: [], browserAssets: ['full-editor.mjs', 'renderer-resources.json', 'editor-document.css', 'editor-shell.css', 'renderer.html', 'renderer.mjs', 'renderer.css', 'parse-worker.mjs'], nativeSidecars: [],
  notices: 'THIRD-PARTY-NOTICES.txt', sourceCommit: sourceLock.commit,
}, null, 2) + '\n');

const authoringCatalog=await(await import(pathToFileURL(resolve(root,'dist/engine.mjs')).href)).catalog();
await writeFile(resolve(root,'dist/authoring-catalog.json'),JSON.stringify(authoringCatalog,null,2)+'\n');
