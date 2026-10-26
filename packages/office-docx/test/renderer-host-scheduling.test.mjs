import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const source=readFileSync(new URL('../renderer-host.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('renderer-host.ts',source,ts.ScriptTarget.Latest,true);
const compiled=ts.transpileModule(ast.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(ast)).join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(build){
 const timers=new Map(),listeners=new Map(),changes=[],errors=[],pending=[];let id=0;
 const options={sourceBase64:'YQ==',baselineHash:'baseline',readOnly:false,presentationMode:'edit',hasDraft:false,appearance:{theme:'light',font:'sans',tokens:{}},onChange:edits=>changes.push(edits),onPending:value=>pending.push(value),onError:error=>errors.push(error)};
 const window={frameElement:{__projectMindDocxOptions:options},dispatchEvent(event){listeners.get(event.type)?.(event);},addEventListener(){}};
 const document={activeElement:null,addEventListener:(name,callback)=>listeners.set(name,callback),querySelectorAll:()=>[],documentElement:{dataset:{},classList:{toggle(){}},style:{setProperty(){}}}};
 const exports={},builds=[];
 const setTimeout=(fn,delay)=>{const key=++id;timers.set(key,{fn,delay});return key;},clearTimeout=key=>timers.delete(key);
 runInNewContext(compiled,{exports,window,document,URL,Blob,Event,atob,btoa,Uint8Array,queueMicrotask,setTimeout,clearTimeout,HTMLInputElement:class{},HTMLTextAreaElement:class{},flushSync:fn=>fn(),requestAnimationFrame:fn=>setImmediate(fn),createPdfBridge:()=>({cancelImages(){}}),pickImage(){},copyImageToClipboard(){},exportHtml(){},pickViaInput(){}});
 exports.initializeHost({async buildDocBytes(ctx){builds.push(ctx.doc.value);return build?await build(ctx,builds.length):new Uint8Array([ctx.doc.value]);},isDocDirty:()=>true,exportHtml:async()=>true});
 const host=window.__projectMindDocxHost;
 const render=value=>host.render({doc:{value}},false);
 const fire=async()=>{const batch=[...timers.values()];timers.clear();for(const timer of batch)timer.fn();await tick();await tick();};
 return{host,render,fire,listeners,changes,errors,pending,builds,timers};
}

test('ten separate input renders coalesce before DOCX generation and retain the final bytes',async()=>{
 const f=fixture();try{
  for(let i=1;i<=10;i++){f.render(i);await tick();}
  assert.equal(f.builds.length,0,'input must settle before serialization');
  assert.equal(f.timers.size,1);await f.fire();
  assert.deepEqual(f.builds,[10]);assert.equal(f.changes.length,1);
  assert.equal(f.changes[0][0].base64,btoa(String.fromCharCode(10)));
 }finally{f.host.destroy();}
});

test('explicit save bypasses the timer and commits nested input before taking the latest bytes',async()=>{
 const f=fixture();try{
  f.render(1);f.listeners.set('ai-docs-commit-tables',()=>f.render(2));
  const edits=await f.host.flush(true);
  assert.deepEqual(f.builds,[2]);assert.equal(edits[0].base64,btoa(String.fromCharCode(2)));
  assert.equal(f.timers.size,0);
 }finally{f.host.destroy();}
});

test('IME blocks explicit save; composition end schedules one settled build',async()=>{
 const f=fixture();try{
  f.listeners.get('compositionstart')();f.render(1);await tick();
  await assert.rejects(f.host.flush(true),/输入法/);assert.equal(f.builds.length,0);
  f.render(2);f.listeners.get('compositionend')();await tick();
  assert.equal(f.builds.length,0);await f.fire();assert.deepEqual(f.builds,[2]);
 }finally{f.host.destroy();}
});

test('save waits for an asynchronous paste and samples the live editor document',async()=>{
 const f=fixture();try{
  f.render(1);f.host.beginOperation();const saved=f.host.flush(true);await tick();
  assert.equal(f.builds.length,0);f.render(3);f.host.endOperation();await saved;
  assert.deepEqual(f.builds,[3]);assert.equal(f.pending.at(-1),false);
 }finally{f.host.destroy();}
});

test('background build made stale by input waits for settlement; explicit flush drains the newest revision',async()=>{
 let release;const held=new Promise(resolve=>{release=resolve;});
 const f=fixture(async(ctx,count)=>{if(count===1)await held;return new Uint8Array([ctx.doc.value]);});
 try{
  f.render(1);await f.fire();assert.deepEqual(f.builds,[1]);
  f.render(2);release();await tick();await tick();
  assert.deepEqual(f.builds,[1],'stale background bytes must not start another immediate build');
  assert.equal(f.changes.length,0);await f.host.flush(true);
  assert.deepEqual(f.builds,[1,2]);assert.equal(f.changes.length,1);
 }finally{f.host.destroy();}
});

test('output flushes immediately and destroy cancels deferred work',async()=>{
 const f=fixture();f.render(4);assert.equal(await f.host.output('html'),true);assert.deepEqual(f.builds,[4]);
 f.render(5);f.host.destroy();await f.fire();assert.deepEqual(f.builds,[4]);assert.equal(f.timers.size,0);
});

test('save samples synchronous live editor state even before its React render subscription fires',async()=>{
 const f=fixture();try{
  const ctx={doc:{value:1},editor:{state:{doc:{}},view:{composing:false},isEditable:true}};
  f.host.render(ctx,false);await f.host.flush(true);assert.deepEqual(f.builds,[1]);
  ctx.editor.state.doc={};ctx.doc.value=8;
  await f.host.flush(true);assert.deepEqual(f.builds,[1,8]);
 }finally{f.host.destroy();}
});

test('concurrent explicit flushes share serialization and drain input arriving during a build',async()=>{
 let release;const held=new Promise(resolve=>{release=resolve;});
 const f=fixture(async(ctx,count)=>{if(count===1)await held;return new Uint8Array([ctx.doc.value]);});
 try{
  f.render(1);const a=f.host.flush(true),b=f.host.flush(true);await tick();
  assert.deepEqual(f.builds,[1]);f.render(9);release();
  const [first,second]=await Promise.all([a,b]);assert.deepEqual(f.builds,[1,9]);
  assert.equal(first[0].base64,btoa(String.fromCharCode(9)));assert.equal(first,second);
  assert.equal(f.changes.length,1);assert.equal(f.timers.size,0);
 }finally{f.host.destroy();}
});

test('failed paste blocks save, failed build is reported and an explicit retry can succeed',async()=>{
 let fails=true;const f=fixture(async()=>{if(fails)throw Error('DOCX build failed');return new Uint8Array([6]);});
 try{
  f.render(1);f.host.beginOperation();const pasteSave=f.host.flush(true);await tick();
  f.host.endOperation(Error('paste failed'));await assert.rejects(pasteSave,/paste failed/);
  assert.equal(f.builds.length,0);await f.fire();assert.equal(f.errors.at(-1),'DOCX build failed');
  fails=false;await f.host.flush(true);assert.equal(f.changes.length,1);assert.equal(f.pending.at(-1),false);
 }finally{f.host.destroy();}
});
