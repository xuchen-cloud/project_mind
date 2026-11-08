import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {preserveLateEditSource} from '../parity-build.mjs';
const source=preserveLateEditSource(readFileSync(new URL('../vendor/apps/slides/src/renderer/file-actions.ts',import.meta.url),'utf8'));
const ast=ts.createSourceFile('file-actions.ts',source,ts.ScriptTarget.Latest,true);
const compiled=ts.transpileModule(ast.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getFullText(ast)).join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('manual PPT save receipt preserves edits made while native save is pending',async()=>{
 let release;const dirty=[],exports={};
 runInNewContext(compiled,{exports,document:{activeElement:null},window:{slidesApi:{save:()=>new Promise(resolve=>release=resolve)}},t:x=>x,showToast(){}});
 const ctx={flushNotes:async()=>{},setDirty:value=>dirty.push(value),setStatus(){}};
 const first=exports.save(()=>ctx);await new Promise(resolve=>setImmediate(resolve));
 release({ok:true,hasLaterEdits:true});assert.equal(await first,true);assert.equal(dirty.at(-1),true);
 const second=exports.save(()=>ctx);await new Promise(resolve=>setImmediate(resolve));
 release({ok:true,hasLaterEdits:false});assert.equal(await second,true);assert.equal(dirty.at(-1),false);
});
