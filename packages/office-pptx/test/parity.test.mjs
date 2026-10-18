import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspect,edit} from '../dist/engine.mjs';
const command=(name,...args)=>({kind:'command',name:`slides:${name}`,args});
test('parity boundary: transform, rich paragraphs, font and slide insertion survive bytes and preserve unrelated parts',async()=>{
 const bytes=new Uint8Array(await readFile(new URL('./fixtures/simple.pptx',import.meta.url)));
 const before=await inspect(bytes); const target=before.textElements[0];
 const edits=[command('edit-text',{slideIndex:0,sourceId:`e_${target.cNvPrId}`,paragraphs:[{runs:[{text:'中文直接编辑',bold:true}]},{runs:[{text:'第二段',italic:true}]}]}),command('edit-transform',{slideIndex:0,sourceId:`e_${target.cNvPrId}`,fitWidthPx:960,xPx:120,yPx:80,wPx:300,hPx:100,rotationDeg:12}),command('add-blank-slide',{sourceIndex:0,fitWidthPx:960})];
 const saved=await edit(bytes,edits);const reopened=await inspect(saved);
 assert.equal(reopened.slides.length,before.slides.length+1);
 const text=reopened.textElements.find(e=>e.slideIndex===0&&e.cNvPrId===target.cNvPrId);
 assert.equal(text.text,'中文直接编辑\n第二段');assert.equal(text.originalRichText.paragraphs[0].runs[0].bold,true);
 const node=reopened.slides[0].elements.find(e=>e.id===`slide-0:shape-${target.cNvPrId}`);assert.equal(node.transform.rot,12*60000);
 const twice=await edit(saved,[command('set-element-font',{slideIndex:0,sourceIds:[`e_${target.cNvPrId}`],fontSizePt:28})]);
 assert.equal((await inspect(twice)).textElements.find(e=>e.slideIndex===0&&e.cNvPrId===target.cNvPrId).originalRichText.paragraphs[0].runs[0].fontSize,28);
 const JSZip=(await import('jszip')).default;const a=await JSZip.loadAsync(bytes),b=await JSZip.loadAsync(saved);
 for(const p of Object.keys(a.files).filter(p=>/^(ppt\/(media|theme|slideMasters|notesMasters)\/)/.test(p)&&!a.files[p].dir))assert.deepEqual(await b.file(p).async('uint8array'),await a.file(p).async('uint8array'),p);
});

test('normal-save history rebase verifies checkpoint and undo/redo survive a second native save',async()=>{
 const bytes=new Uint8Array(await readFile(new URL('./fixtures/simple.pptx',import.meta.url)));
 const before=await inspect(bytes),id=`e_${before.textElements[0].cNvPrId}`;
 const history=[command('edit-text',{slideIndex:0,sourceId:id,paragraphs:[{runs:[{text:'first saved'}]}]})];
 const once=await edit(bytes,history);
 const checkpoint=command('rebase-history',{sourceBase64:Buffer.from(bytes).toString('base64'),commands:history});
 const undone=await inspect(await edit(once,[checkpoint,command('undo')]));
 assert.equal(undone.textElements[0].text,before.textElements[0].text);
 const redone=await inspect(await edit(once,[checkpoint,command('undo'),command('redo')]));assert.equal(redone.textElements[0].text,'first saved');
 await assert.rejects(edit(bytes,[checkpoint,command('undo')]),/checkpoint/);
});

const complex=()=>readFile(new URL('./fixtures/complex.pptx',import.meta.url));
const unzip=async bytes=>(await import('jszip')).default.loadAsync(bytes);
test('table structure, rich cells and imported chart data persist through native ops',async()=>{
 const input=new Uint8Array(await complex());
 const saved=await edit(input,[
 command('edit-table-cell',{slideIndex:1,sourceId:'e_6',row:0,col:0,paragraphs:[{runs:[{text:'表头改写',bold:true}]}]}),
 command('table-structure',{slideIndex:1,sourceId:'e_6',kind:'insert-row',index:1}),
 command('set-table-col-width',{slideIndex:1,sourceId:'e_6',col:0,wPx:210,fitWidthPx:960}),
 command('edit-chart',{slideIndex:2,sourceId:'e_5',kind:'line',categories:['甲','乙'],series:[{name:'新系列',values:[13,27]}],title:'图表改写'}),
 ]);
 const model=await inspect(saved),table=model.slides[1].elements.find(e=>e.type==='table');
 assert.equal(table.rows.length,4);assert.equal(table.rows[0][0].text.paragraphs[0].runs[0].text,'表头改写');
 const zip=await unzip(saved),chart=await zip.file('ppt/charts/chart1.xml').async('string');assert.match(chart,/lineChart/);assert.match(chart,/新系列/);assert.match(chart,/>27</);
});
test('group/ungroup, shape style, image crop/background and clipboard slides use actual package operations',async()=>{
 const source=new Uint8Array(await complex());
 const png=(await unzip(source)).file('ppt/media/image1.png');const imageSource={base64:await png.async('base64'),ext:'png'};
 const grouped=await edit(source,[command('group-elements',{slideIndex:0,sourceIds:['e_5','e_7']} )]);
 const group=(await inspect(grouped)).slides[0].elements.find(e=>e.type==='group');assert.ok(group);
 const id=/id="(\d+)"/.exec(group.anchor.originalXml)[1];
 const saved=await edit(grouped,[command('edit-text',{slideIndex:0,groupId:`e_${id}`,sourceId:'e_5',paragraphs:[{runs:[{text:'组合中文字'}]}]}),command('ungroup-element',{slideIndex:0,sourceId:`e_${id}`}),
 command('edit-picture-src-rect',{slideIndex:0,sourceId:'e_7',srcRect:{l:0.1,t:0,r:0.1,b:0}}),
 command('edit-background',{slideIndex:0,kind:'image',mode:'stretch',source:imageSource}),
 command('copy-slides',{slideIndexes:[0]}),command('paste-slide',{afterIndex:0,fitWidthPx:960,mode:'source'}),command('repaste-slide',{fitWidthPx:960,mode:'theme'}),
 ]);
 const model=await inspect(saved);assert.equal(model.slides.length,4);assert.ok(model.textElements.some(e=>e.text==='组合中文字'));const zip=await unzip(saved);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/srcRect[^>]*l="10000"/);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<p:bg>/);
});
test('notes/comments, sections, transitions, animation and hyperlink XML survive reparse',async()=>{
 const source=new Uint8Array(await complex());
 const edits=[command('set-notes',{slideIndex:0,text:'备注两行\n中文'}),command('add-comment',{slideIndex:0,text:'审阅批注'}),command('add-section',{atSlideIndex:1,name:'第二节'}),command('set-transition',{slideIndex:0,kind:'fade'}),command('set-advance-times',{times:[{slideIndex:0,ms:3500}]}),command('set-animations',{slideIndex:0,items:[{sourceId:'e_5',effect:'fade',trigger:'onClick',durationMs:750,delayMs:0}]}),command('set-link',{slideIndex:0,sourceId:'e_5',target:{kind:'url',url:'https://example.com/'}})];
 const saved=await edit(source,edits),zip=await unzip(saved);const xml=await zip.file('ppt/slides/slide1.xml').async('string');
 assert.match(xml,/<p:fade/);assert.match(xml,/advTm="3500"/);assert.match(xml,/<p:timing/);assert.match(await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string'),/https:\/\/example.com/);assert.match(await zip.file('ppt/presentation.xml').async('string'),/第二节/);
 assert.ok((await Promise.all(Object.keys(zip.files).filter(p=>/comments.*xml$/.test(p)).map(p=>zip.file(p).async('string')))).join('').includes('审阅批注'));
 assert.ok((await Promise.all(Object.keys(zip.files).filter(p=>/notesSlides.*xml$/.test(p)).map(p=>zip.file(p).async('string')))).join('').includes('备注两行'));
});
test('native save rejects unsupported I/O, unsafe links and invalid ops without changing source',async()=>{
 const bytes=new Uint8Array(await complex());const hash=Buffer.from(bytes).toString('base64');
 await assert.rejects(edit(bytes,[command('open-path','/tmp/secret',960)]),/Unsupported/);
 await assert.rejects(edit(bytes,[command('set-link',{slideIndex:0,sourceId:'e_5',target:{kind:'url',url:'javascript:alert(1)'}})]));
 await assert.rejects(edit(bytes,[command('apply-txn',{ops:[{op:'setFont',target:{slide:0,el:'missing'},sizePt:28}]})]));assert.equal(Buffer.from(bytes).toString('base64'),hash);
});
test('single candidate validates exact baseline, actual changed parts and XML; bounded commands cannot nest around resource limits',async()=>{
 const bytes=new Uint8Array(await complex()),before=await inspect(bytes);
 const saved=await edit(bytes,[command('edit-text',{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'候选保存'}]}]})]);
 const a=await unzip(bytes),b=await unzip(saved),paths=[...new Set([...Object.keys(a.files),...Object.keys(b.files)])].filter(p=>!a.files[p]?.dir&&!b.files[p]?.dir);const changed=[];
 for(const p of paths){const x=await a.file(p)?.async('base64'),y=await b.file(p)?.async('base64');if(x!==y)changed.push(p)}
 const candidate={kind:'candidate',sourceHash:before.originalHash,base64:Buffer.from(saved).toString('base64'),changedParts:changed.sort()};
 assert.equal((await inspect(await edit(bytes,[candidate]))).textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'候选保存');
 await assert.rejects(edit(bytes,[{...candidate,sourceHash:'0'.repeat(64)}]),/baseline/);
 await assert.rejects(edit(bytes,[{...candidate,changedParts:[]}]),/manifest/);
 const malformed=await unzip(saved);malformed.file('ppt/slides/slide1.xml','<p:sld>');const invalid={...candidate,base64:Buffer.from(await malformed.generateAsync({type:'uint8array'})).toString('base64')};await assert.rejects(edit(bytes,[invalid]),/XML|xml|slide/);
 await assert.rejects(edit(bytes,Array.from({length:257},()=>command('undo'))),/256/);
 await assert.rejects(edit(bytes,[command('rebase-history',{sourceBase64:Buffer.from(bytes).toString('base64'),commands:Array.from({length:256},()=>command('undo'))})]),/budget/);
});

test('master edits, theme reparse and a subsequent edit remain authoritative in the saved package',async()=>{
 const input=new Uint8Array(await complex());
 const master=await edit(input,[command('master-enter',960),command('master-open','ppt/slideMasters/slideMaster1.xml'),command('master-edit-text',{sourceId:'e_2',paragraphs:[{runs:[{text:'母版标题已编辑',bold:true}]}]}),command('master-close')]);
 const masterZip=await unzip(master);assert.match(await masterZip.file('ppt/slideMasters/slideMaster1.xml').async('string'),/母版标题已编辑/);
 const saved=await edit(master,[command('apply-theme',{name:'Project Mind Theme',colors:{accent1:'#F46B21'},majorFont:'Georgia',minorFont:'Verdana',fitWidthPx:960}),command('edit-text',{slideIndex:0,sourceId:'e_5',paragraphs:[{runs:[{text:'主题之后继续编辑'}]}]})]);
 const zip=await unzip(saved);assert.match(await zip.file('ppt/theme/theme1.xml').async('string'),/F46B21/);assert.match(await zip.file('ppt/theme/theme1.xml').async('string'),/Georgia/);assert.equal((await inspect(saved)).textElements.find(e=>e.slideIndex===0&&e.cNvPrId==='5').text,'主题之后继续编辑');
 const undone=await edit(master,[command('apply-theme',{name:'Project Mind Theme',colors:{accent1:'#F46B21'},fitWidthPx:960}),command('undo')]);assert.deepEqual(await(await unzip(undone)).file('ppt/theme/theme1.xml').async('uint8array'),await masterZip.file('ppt/theme/theme1.xml').async('uint8array'));
});
