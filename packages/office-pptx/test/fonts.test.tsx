import {expect,test} from 'vitest';
import {readFile} from 'node:fs/promises';
import {parse} from 'opentype.js';
import {openPptx} from '@genoffice/pptx-engine';
import {HeuristicMetrics} from '@genoffice/pptx-render';
import {createBrowserFontMetrics} from '../browser-font-metrics';
import {createParitySession} from '../parity-session';
import {edit,inspect} from '../dist/engine.mjs';
const data=async()=>{const b=await readFile('vendor/apps/docs/src/renderer/fonts/Caladea-Regular.ttf');return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
const style={fontFamily:'Caladea',fontSizePx:32,bold:false,italic:false};
test('authorized Caladea uses upstream OpenType advances/ascent/descent/leading; missing faces retain explicit heuristic fallback',async()=>{
 const bytes=await data(),font=parse(bytes),metrics=createBrowserFontMetrics();metrics.register({family:'Caladea',bold:false,italic:false},bytes);
 const text='Hamburgefonts WWW iii';expect(metrics.provider.measure(text,style)).toBeCloseTo(font.getAdvanceWidth(text,32),8);expect(metrics.provider.measure(text,style)).not.toBeCloseTo(new HeuristicMetrics().measure(text,style),3);
 const line=metrics.provider.metrics(style),scale=32/font.unitsPerEm;expect(line.ascent).toBeCloseTo(font.ascender*scale,8);expect(line.descent).toBeCloseTo(Math.abs(font.descender)*scale,8);expect(line.lineHeight).toBeCloseTo((font.ascender-font.descender)*scale,8);expect(line.externalLeading??0).toBeCloseTo((font.tables.hhea.lineGap??0)*scale,8);
 const absent={...style,fontFamily:'Missing test face'};expect(metrics.provider.measure(text,absent)).toBe(new HeuristicMetrics().measure(text,absent));
});
test('session relayout after authorized font load changes actual wrapping/advances without changing original parts or history; edits still save',async()=>{
 const original=new Uint8Array(await readFile('test/fixtures/complex.pptx'));
 const source=await edit(original,[{kind:'command',name:'slides:edit-text',args:[{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'iiiiiiiiiiiiiiiiiiii WWWWWWWW iiiiiiiiii WWWWWWWW',fontFamily:'Caladea',fontSize:24}]}]}]},{kind:'command',name:'slides:edit-transform',args:[{slideIndex:0,sourceId:'e_5',fitWidthPx:1280,xPx:100,yPx:100,wPx:240,hPx:200}]} ,{kind:'command',name:'slides:set-text-body-props',args:[{slideIndex:0,sourceId:'e_5',props:{wrap:true,autofit:'none'}}]}]);
 const metrics=createBrowserFontMetrics(),session=createParitySession(await openPptx(source),{metrics:metrics.provider});
 const before=(await session.invoke('slides:get-render-slides',[1280]))[0].nodes.find(n=>n.sourceId==='e_5');
 const untouched=await session.save();metrics.register({family:'Caladea',bold:false,italic:false},await data());
 const after=(await session.invoke('slides:get-render-slides',[1280]))[0].nodes.find(n=>n.sourceId==='e_5');
 expect(after.text.lines.map(l=>l.runs.map(r=>r.text).join(''))).not.toEqual(before.text.lines.map(l=>l.runs.map(r=>r.text).join('')));
 const run=after.text.lines.flatMap(l=>l.runs).find(r=>r.text.trim());expect(run.widthPx).toBeCloseTo(metrics.provider.measure(run.text,{...style,fontSizePx:run.fontSizePx,kerning:!run.kerningOff}),6);
 const JSZip=(await import('jszip')).default,a=await JSZip.loadAsync(untouched),b=await JSZip.loadAsync(await session.save());for(const name of Object.keys(a.files).filter(p=>!a.files[p].dir))expect(await b.file(name)!.async('uint8array')).toEqual(await a.file(name)!.async('uint8array'));
 expect(session.state.undoStack).toHaveLength(0);
 await session.invoke('slides:edit-text',[{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'Caladea edited after relayout',fontFamily:'Caladea'}]}]}]);expect((await inspect(await session.save())).textElements.find(e=>e.cNvPrId==='5'&&e.slideIndex===0)?.text).toBe('Caladea edited after relayout');
});
