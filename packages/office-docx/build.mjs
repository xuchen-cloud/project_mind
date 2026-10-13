import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import './prepare-source.mjs';
import { writeNotices } from './write-notices.mjs';
import ts from 'typescript';
import postcss from 'postcss';

const root = import.meta.dirname;
const names = ['docx-engine', 'pptx-engine', 'pptx-render', 'zip-gate', 'ui', 'i18n', 'font-metrics'];
const alias = Object.fromEntries(names.map(name => [`@genoffice/${name}`, resolve(root, `upstream/packages/${name}/src/index.ts`)]));
for (const [name, path] of Object.entries({
  '@genoffice/pptx-engine/custgeom': 'pptx-engine/src/custgeom.ts',
  '@genoffice/pptx-render/preset-geometry': 'pptx-render/src/preset-geometry.ts',
  '@genoffice/pptx-render/metrics': 'pptx-render/src/metrics.ts',
  '@genoffice/ai-provider/browser': 'ai-provider/src/browser.ts',
  '@genoffice/agent-core/redact-core': 'agent-core/src/redact-core.ts',
})) alias[name] = resolve(root, 'upstream/packages', path);
await mkdir(resolve(root, 'dist'), { recursive: true });
const inputs = new Set();
for (const [entry, platform] of [['engine', 'node'], ['editor', 'browser']]) {
  const result = await build({ absWorkingDir: root, entryPoints: [`${entry}.ts`], outfile: `dist/${entry}.mjs`, platform,
    bundle: true, format: 'esm', target: 'es2022', alias, treeShaking: true, metafile: true,
    jsx: 'automatic', logLevel: 'warning', legalComments: 'eof', loader: { '.css': 'empty' }, inject: ['css-escape.ts'],
    define: { 'process.env.NODE_ENV': '"production"', 'CSS.escape': 'cssEscape' },
    banner: platform === 'node' ? { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } : undefined });
  await writeFile(resolve(root, `dist/${entry}.meta.json`), JSON.stringify(result.metafile, null, 2));
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
const program = ts.createProgram([resolve(root, 'types.ts'), resolve(root, 'editor-types.ts')], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, outDir: resolve(root, 'dist'),
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
program.emit();
await writeFile(resolve(root, 'dist/editor.d.mts'), 'export { mountEditor } from "./editor-types";\n');
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
  engine: 'engine.mjs', editor: 'editor.mjs', engineAssets: [], browserAssets: ['editor-document.css', 'editor-shell.css'], nativeSidecars: [],
  notices: 'THIRD-PARTY-NOTICES.txt', sourceCommit: sourceLock.commit,
}, null, 2) + '\n');
