import {afterEach,expect,test,vi} from 'vitest';
import {slideImageUrls,prepareSlideImages} from '../parity-images';
import type {RenderSlide} from '@genoffice/pptx-render';

afterEach(()=>vi.unstubAllGlobals());
const page=(url:string):RenderSlide=>({widthPx:960,heightPx:540,scale:1,background:{kind:'image',dataUrl:url},nodes:[]});
test('image collection touches only requested pages; output loads media on unvisited pages',async()=>{
 let touched=0;
 const first=page('data:image/png;base64,first'),later=page('data:image/png;base64,later');
 Object.defineProperty(later,'nodes',{get(){touched++;return []}});
 expect([...slideImageUrls([first])]).toEqual(['data:image/png;base64,first']);
 expect(touched).toBe(0);
 const requested:string[]=[];
 vi.stubGlobal('Image',class{onload?:()=>void;set src(url:string){requested.push(url);queueMicrotask(()=>this.onload?.())}});
 const shown=new Map([[first.background.kind==='image'?first.background.dataUrl!:'' ,{} as HTMLImageElement]]);
 const output=await prepareSlideImages([first,later],shown);
 expect(requested).toEqual(['data:image/png;base64,later']);
 expect(output.size).toBe(2);
 expect(shown.size).toBe(1);
});
test('failed output image decoding is reported instead of exporting a blank picture',async()=>{
 vi.stubGlobal('Image',class{onerror?:()=>void;set src(_url:string){queueMicrotask(()=>this.onerror?.())}});
 await expect(prepareSlideImages([page('data:image/png;base64,broken')],new Map())).rejects.toThrow('图片无法解码');
});
