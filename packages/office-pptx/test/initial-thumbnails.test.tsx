import {useEffect,useState} from 'react';
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {initialThumbsSource} from '../parity-build.mjs';

afterEach(()=>{cleanup();vi.unstubAllGlobals()});
test('renderer thumbnail hook requests no speculative pages before visibility arrives',()=>{
 const source=initialThumbsSource(readFileSync('vendor/apps/slides/src/renderer/use-visible-thumbs.ts','utf8'));
 const compiled=ts.transpileModule(source.replace(/^import .*\n/,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:{useVisibleThumbs?:(root:{current:HTMLElement},selector:string,deps:unknown[])=>ReadonlySet<number>}={};
 new Function('useEffect','useState','exports',compiled)(useEffect,useState,exports);
 let report:(entries:{target:HTMLElement;isIntersecting:boolean}[])=>void=()=>{};
 const observed:Element[]=[],disconnect=vi.fn();
 vi.stubGlobal('IntersectionObserver',class{
  constructor(callback:typeof report,options:{rootMargin:string}){report=callback;expect(options.rootMargin).toBe('25% 0px')}
  observe(element:Element){observed.push(element)}disconnect=disconnect;
 });
 const root=document.createElement('div');
 for(let i=0;i<40;i++){const item=document.createElement('div');item.className='thumb';item.dataset.index=String(i);root.append(item)}
 const {result,unmount}=renderHook(()=>exports.useVisibleThumbs!({current:root},'.thumb',[]));
 expect(result.current.size).toBe(0);
 expect(observed).toHaveLength(40);
 act(()=>report([{target:root.children[3] as HTMLElement,isIntersecting:true}]));
 expect([...result.current]).toEqual([3]);
 act(()=>report([{target:root.children[3] as HTMLElement,isIntersecting:false},{target:root.children[39] as HTMLElement,isIntersecting:true}]));
 expect([...result.current]).toEqual([39]);
 unmount();expect(disconnect).toHaveBeenCalledOnce();
});
