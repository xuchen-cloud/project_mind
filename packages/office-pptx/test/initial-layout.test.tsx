import {expect,test} from 'vitest';
import {readFile} from 'node:fs/promises';
import {openPptx} from '@genoffice/pptx-engine';
import {HeuristicMetrics} from '@genoffice/pptx-render';
import {createParitySession} from '../parity-session';
import {captureCandidateBaseline,candidateEdit} from '../parity-candidate';
import {auditOpenedDeck} from '../audit-opened';
import {auditDeck} from '../vendor/packages/pipelines/src/slides/audit-deck';

test('initial page access lays out only that page; full layouts and edits stay complete',async()=>{
 const source=new Uint8Array(await readFile('test/fixtures/complex.pptx'));
 const measured:string[]=[];
 const heuristic=new HeuristicMetrics();
 const session=createParitySession(await openPptx(source),{lazyInitialLayout:true,metrics:{
  measure(text,style){measured.push(text);return heuristic.measure(text,style)},
  metrics:style=>heuristic.metrics(style),
 }});
 const initial=session.openResult(960).slides;
 expect(initial.length).toBeGreaterThan(1);
 expect(measured).toHaveLength(0);
 expect(initial.map(s=>[s.widthPx,s.heightPx,s.hidden,s.partPath]).length).toBe(initial.length);
 expect(measured).toHaveLength(0);
 const first=initial[0].nodes;
 expect(first.length).toBeGreaterThan(0);
 const firstCount=measured.length;
 expect(firstCount).toBeGreaterThan(0);
 expect(initial[0].nodes).toBe(first);
 expect(measured).toHaveLength(firstCount);
 const full=await session.invoke('slides:get-render-slides',[960]);
 expect(measured.length).toBeGreaterThan(firstCount);
 for(let i=0;i<initial.length;i++)expect(initial[i]).toEqual(full[i]);
 expect(session.state.undoStack).toHaveLength(0);
 const target=session.state.opened.deck.slides[1].elements.find(e=>(e.type==='text'||e.type==='shape')&&e.text)!;
 await session.invoke('slides:edit-text',[{slideIndex:1,sourceId:target.id,paragraphs:[{runs:[{text:'Edited later page'}]}]}]);
 const saved=await openPptx(await session.save());
 expect(JSON.stringify(saved.deck.slides[1].elements)).toContain('Edited later page');
});

test('reused audit matches the pinned audit and the candidate baseline survives archive mutations',async()=>{
 const source=new Uint8Array(await readFile('test/fixtures/complex.pptx'));
 const opened=await openPptx(source);
 expect(auditOpenedDeck(opened)).toEqual(await auditDeck(source));
 const baseline=captureCandidateBaseline(opened);
 const xml=opened.archive.entries.get('ppt/slides/slide1.xml')!;
 const original=xml[0];xml[0]=0;
 expect(baseline.archive.entries.get('ppt/slides/slide1.xml')![0]).toBe(original);
 xml[0]=original;
 const session=createParitySession(opened,{lazyInitialLayout:true});
 await session.invoke('slides:add-blank-slide',[{sourceIndex:0,fitWidthPx:960}]);
 const candidate=await candidateEdit(baseline,await session.save());
 expect(candidate.sourceHash).toBe(opened.deck.originalHash);
 expect(candidate.changedParts).toContain('ppt/presentation.xml');
 expect(candidate.changedParts.some(path=>/ppt\/slides\/slide\d+\.xml/.test(path))).toBe(true);
 expect(baseline.archive.entries.has('ppt/slides/slide4.xml')).toBe(false);
});
