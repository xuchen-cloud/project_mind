import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {parityPlugins} from '../parity-build.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(new URL('../output',import.meta.url),{recursive:true});
await build({absWorkingDir:root,stdin:{contents:"export * from './engine'; export * from './progressive-open'; export {createParitySession} from './parity-session'; export {candidateEdit,captureCandidateBaseline} from './parity-candidate';",resolveDir:root,loader:'ts'},outfile:'output/progressive-runtime.mjs',bundle:true,platform:'node',format:'esm',plugins:[...(process.env.PPTX_RED_RESOURCE?[{name:'original-resource-cleanup',setup(b){b.onLoad({filter:/pptx-engine[\\/]src[\\/]resource-cleanup\.ts$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'ts'}))}}]:[]),...(process.env.PPTX_RED_BASELINE?[{name:'frozen-baseline',setup(b){b.onLoad({filter:/office-pptx[\\/]engine\.ts$/},async()=>({contents:await readFile(new URL('../output/progressive-red-engine.ts',import.meta.url),'utf8'),loader:'ts'}))}}]:[]),...parityPlugins(root)],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},logLevel:'silent'});
const runtime=await import('../output/progressive-runtime.mjs');
const bytes=new Uint8Array(await readFile(new URL('./fixtures/complex.pptx',import.meta.url)));
test('GUI inspect owns only the first slide while retaining exact source and full catalog',async()=>{
 assert.equal(typeof runtime.inspectView,'function','GUI requires an independent inspectView entry');
 const model=await runtime.inspectView(bytes);
 assert.equal(model.sourceBase64,Buffer.from(bytes).toString('base64'));
 assert.equal(model.coverage.kind,'partial');
 assert.equal(model.coverage.sourceHash,model.originalHash);
 assert.equal(model.coverage.partial,true);
 assert.equal(model.slideCatalog.length,3);
 assert.deepEqual(model.coverage.loadedSlides,[0]);
 assert.equal(model.slides.length,1);
 assert.ok(model.slides[0].elements.some(e=>e.text?.paragraphs.some(p=>p.runs.some(r=>r.text.includes('项目进展正常')))));
 assert.equal(model.renderSlides.length,0);
 assert.deepEqual(model.media,{});
});

test('actual first-slide layout, edit and save complete while tail parser reads are unavailable',async()=>{
 const {openViewPptx,isUnloadedSlide}=await import('../output/progressive-runtime.mjs');
 assert.equal(typeof openViewPptx,'function');
 const model=await runtime.inspectView(bytes),opened=await openViewPptx(bytes,model);
 const tail=opened.deck.slides.at(-1).path;
 const read=opened.archive.readText.bind(opened.archive);
 opened.archive.readText=path=>{assert.notEqual(path,tail,'unavailable tail must not block first editable content');return read(path)};
 const source=runtime.captureCandidateBaseline(opened);
 const session=runtime.createParitySession(opened,{lazyInitialLayout:true});
 const first=session.openResult().slides[0];
 assert.ok(first.nodes.some(node=>node.sourceId==='e_5'));
 await session.invoke('slides:edit-text',[{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'tail unavailable: first actual edit'}]}]}]);
 const saved=await session.save();
 const candidate=await runtime.candidateEdit(source,saved);
 assert.equal(isUnloadedSlide(opened.deck.slides.at(-1)),true);
 assert.deepEqual(candidate.changedParts,['ppt/slides/slide1.xml']);
 const full=await runtime.inspect(await runtime.edit(bytes,[candidate]));
 assert.ok(full.textElements.some(e=>e.text==='tail unavailable: first actual edit'));
});

test('unparsed tail XML still receives complete UTF-8 and XML admission',async t=>{
 const JSZip=(await import('jszip')).default;
 const zip=await JSZip.loadAsync(bytes);
 const tail='ppt/slides/slide3.xml',xml=await zip.file(tail).async('string');
 zip.file(tail,xml.replace('</p:sld>','</p:broken>'));
 await assert.rejects(runtime.inspectView(await zip.generateAsync({type:'uint8array'})),/Invalid XML part.*slide3/);
 const model=await runtime.inspectView(bytes);
 assert.ok(model.coverage.archiveMs>=0&&model.coverage.xmlValidationMs>=0);
 t.diagnostic(JSON.stringify({archiveMs:model.coverage.archiveMs,xmlValidationMs:model.coverage.xmlValidationMs,bytes:bytes.length,slides:model.slideCatalog.length}));
});

test('deleting an initial shape retains a model resource referenced by an unparsed tail',async()=>{
 const JSZip=(await import('jszip')).default,zip=await JSZip.loadAsync(bytes);
 const modelPart='ppt/media/shared-model.glb';
 for(const [path,id] of [['ppt/slides/slide1.xml','5'],['ppt/slides/slide3.xml','3']]){
  const xml=await zip.file(path).async('string');
  zip.file(path,xml.replace(new RegExp(`<p:cNvPr\\b(?=[^>]*\\bid="${id}")[^>]*>`),tag=>tag.replace(/\sdescr="[^"]*"/,'').replace(/\/?>$/,end=>` descr="aislides-3d:${modelPart}"`+end)));
 }
 zip.file(modelPart,new Uint8Array([103,108,84,70,2,0,0,0,12,0,0,0]));
 const source=await zip.generateAsync({type:'uint8array'});
 const opened=await runtime.openViewPptx(source,await runtime.inspectView(source));
 const session=runtime.createParitySession(opened,{lazyInitialLayout:true});
 await session.invoke('slides:delete-elements',[{slideIndex:0,sourceIds:['e_5']}]);
 assert.equal(runtime.isUnloadedSlide(opened.deck.slides[2]),true);
 const saved=await JSZip.loadAsync(await session.save());
 assert.ok(saved.file(modelPart),'unknown tail must continue owning its shared model');
 assert.deepEqual(await saved.file(modelPart).async('uint8array'),await zip.file(modelPart).async('uint8array'));
 assert.equal(await saved.file('ppt/slides/slide3.xml').async('string'),await zip.file('ppt/slides/slide3.xml').async('string'));
});

test('global transition edits materialize all targets and pending hidden state reaches render descriptors',async()=>{
 const opened=await runtime.openViewPptx(bytes,await runtime.inspectView(bytes));
 const session=runtime.createParitySession(opened,{lazyInitialLayout:true});
 await session.invoke('slides:set-transition',[{slideIndex:-1,kind:'fade'}]);
 assert.ok(opened.deck.slides.every(slide=>!runtime.isUnloadedSlide(slide)));
 const full=await runtime.inspect(await session.save());
 const JSZip=(await import('jszip')).default,zip=await JSZip.loadAsync(await session.save());
 for(const slide of full.slides)assert.match(await zip.file(slide.path).async('string'),/<p:fade/);
 const updated=await session.invoke('slides:set-slides-hidden',[{slideIndexes:[0],hidden:true,fitWidthPx:960}]);
 assert.equal(updated[0].hidden,true,'pending hidden status must come from the edited model');
});
