import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parityPlugins} from '../parity-build.mjs';
import {buildImportPath} from '../build-import-path.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const windowsRoot=String.raw`D:\a\project mind's\project_mind\packages\office-pptx`;
const portableRoot="D:/a/project mind's/project_mind/packages/office-pptx";

test('Windows build paths preserve parent directories and quotes',()=>{
 assert.equal(buildImportPath(windowsRoot,'parity-protocol.ts'),portableRoot+'/parity-protocol.ts');
 assert.equal(buildImportPath(windowsRoot,'../editor-chrome/StatusZoom.tsx'),"D:/a/project mind's/project_mind/packages/editor-chrome/StatusZoom.tsx");
});

test('real pinned renderer transforms retain Windows import specifiers through esbuild',async()=>{
 const hooks=[];
 for(const plugin of parityPlugins(windowsRoot,{browser:true}))plugin.setup({onLoad:(options,callback)=>hooks.push({...options,callback}),onResolve:()=>{}});
 const cases=[
  ['vendor/packages/pptx-engine/src/index.ts',['parity-context.ts']],
  ['vendor/apps/slides/src/renderer/file-actions.ts',['parity-text-edit.ts','parity-protocol.ts']],
  ['vendor/apps/slides/src/renderer/TextEditOverlay.tsx',['parity-text-edit.ts']],
  ['vendor/apps/slides/src/renderer/components/Ribbon.tsx',[]],
  ['vendor/apps/slides/src/renderer/App.tsx',['parity-output.ts','parity-presentation.ts','parity-text-edit.ts','../editor-chrome/StatusZoom.tsx']],
 ];
 for(const [relative,expected] of cases){
  const filename=root+'/'+relative;
  const hook=hooks.find(hook=>!hook.namespace&&hook.filter.test(filename));
  assert.ok(hook,relative);
  const windowsFilename=(portableRoot+'/'+relative).replaceAll('/',String.fromCharCode(92));
  assert.equal(hooks.find(candidate=>!candidate.namespace&&candidate.filter.test(windowsFilename)),hook,`Windows onLoad hook: ${relative}`);
  const transformed=await hook.callback({path:filename});
  const resolved=[];
  await build({stdin:{contents:transformed.contents,loader:transformed.loader,resolveDir:root},bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent',plugins:[{name:'capture-imports',setup(b){b.onResolve({filter:/.*/},args=>{resolved.push(args.path);return {path:args.path,external:true};});}}]});
  for(const name of expected)assert.ok(resolved.includes(buildImportPath(portableRoot,name)),`${relative}: missing ${name}; got ${resolved.join(', ')}`);
  assert.ok(resolved.every(specifier=>!specifier.includes('\\')),relative);
 }
});
