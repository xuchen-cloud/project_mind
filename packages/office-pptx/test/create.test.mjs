import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import JSZip from 'jszip';
import * as engine from '../dist/engine.mjs';

const title=(text)=>({type:'text',x:60,y:40,w:1160,h:90,paragraphs:[{runs:[{text,sizePt:36,bold:true,color:'#17365D',font:'Arial'}]}]});
const rect=(x,y,w,h)=>({x,y,cx:w,cy:h});
const EMU=9525;
const box=(x,y,w,h)=>rect(x*EMU,y*EMU,w*EMU,h*EMU);
const step=(op,as)=>({op,...(as?{as}:{})});
test('create reuses the upstream editable deck pipeline with rich multi-page layout and full native operations',async()=>{
 const source=await JSZip.loadAsync(await readFile(new URL('./fixtures/complex.pptx',import.meta.url)));
 const image=`data:image/png;base64,${await source.file('ppt/media/image1.png').async('base64')}`;
 const bytes=await engine.create({pages:[
  {background:'#F4F7FB',elements:[title('可编辑的复杂演示文稿'),{type:'shape',shape:'roundRect',x:60,y:160,w:600,h:280,fill:'#DCE6F1',stroke:{color:'#17365D',widthPt:2},paragraphs:[{runs:[{text:'多栏布局',sizePt:26,bold:true},{text:' / rich text',italic:true,sizePt:22}]}]},{type:'image',x:760,y:160,w:280,h:280,url:image}]},
  {elements:[title('原生数据表与图表')]},
  {elements:[title('流程与备注')]},
 ],operations:[
  step({op:'applyTheme',name:'Project Mind',colors:{accent1:'#17365D'},majorFont:'Arial',minorFont:'Arial'}),
  step({op:'addTable',target:{slide:1},rows:2,cols:2,offset:box(60,150,430,260)},'sales'),
  step({op:'setTableCell',target:{slide:1,el:{$ref:'sales'}},row:0,col:0,paragraphs:[{runs:[{text:'季度',bold:true}]}]}),
  step({op:'setTableCell',target:{slide:1,el:{$ref:'sales'}},row:1,col:0,paragraphs:[{runs:[{text:'第一季度'}]}]}),
  step({op:'setTableCell',target:{slide:1,el:{$ref:'sales'}},row:1,col:1,paragraphs:[{runs:[{text:'120'}]}]}),
  step({op:'setTableStyle',target:{slide:1,el:{$ref:'sales'}},styleName:'headerDarkBlue'}),
  step({op:'addChart',target:{slide:1},kind:'bar',title:'季度营收',categories:['Q1','Q2'],series:[{name:'营收',values:[120,180]}],offset:box(550,150,650,400)},'revenue'),
  step({op:'addSmartArt',target:{slide:2},layout:'process',items:['调研','设计','交付'],offset:box(60,160,1140,300)},'process'),
  step({op:'setNotes',target:{slide:2},text:'演讲者备注\n中文第二行'}),
  step({op:'setTransition',target:{slide:2},kind:'fade'}),
 ]});
 const model=await engine.inspect(bytes);
 assert.equal(model.slides.length,3);assert.equal(model.pictureElements.length,1);
 assert.ok(model.textElements.some(e=>e.text.includes('复杂演示文稿')));
 assert.ok(model.slides[1].elements.some(e=>e.type==='table'));
 assert.ok(model.slides[2].elements.some(e=>e.type==='group'));
 assert.equal(model.layoutAudit.length,3);
 if(process.env.OFFICE_PPTX_CREATE_OUTPUT){
  const dir=process.env.OFFICE_PPTX_CREATE_OUTPUT;await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/complex-authoring.pptx`,bytes);
  await writeFile(`${dir}/layout-audit.json`,JSON.stringify(model.layoutAudit,null,2));
  const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{ReactSvgSlide}=await import('../dist/browser.mjs');
  for(const [i,slide] of model.renderSlides.entries())await writeFile(`${dir}/page-${i+1}.html`,`<!doctype html><meta charset="utf-8"><style>body{margin:0;width:1280px;height:720px;overflow:hidden}svg{width:1280px;height:720px}</style>${renderToStaticMarkup(React.createElement(ReactSvgSlide,{slide,label:`Page ${i+1}`}))}`);
 }
 const zip=await JSZip.loadAsync(bytes);
 assert.match(await zip.file('ppt/charts/chart1.xml').async('string'),/季度营收/);
 assert.match(await zip.file('ppt/charts/chart1.xml').async('string'),/>180</);
 assert.ok(Object.keys(zip.files).some(p=>p.startsWith('ppt/embeddings/')));
 assert.match(await zip.file('ppt/charts/chart1.xml').async('string'),/<c:externalData r:id="rId\d+"/);
 const workbook=await JSZip.loadAsync(await zip.file('ppt/embeddings/pm-chart-data-1.xlsx').async('uint8array'));
 assert.match(await workbook.file('xl/worksheets/sheet1.xml').async('string'),/<c r="B3"><v>180<\/v><\/c>/);
 assert.ok((await Promise.all(Object.keys(zip.files).filter(p=>/notesSlides\/notesSlide\d+.xml$/.test(p)).map(p=>zip.file(p).async('string')))).join('').includes('演讲者备注'));
 const target=model.textElements.find(e=>e.slideIndex===0);
 const changed=await engine.edit(bytes,[{kind:'command',name:'slides:edit-text',args:[{slideIndex:0,sourceId:`e_${target.cNvPrId}`,paragraphs:[{runs:[{text:'同一文稿继续编辑',bold:true}]}]}]}]);
 assert.ok((await engine.inspect(changed)).textElements.some(e=>e.text==='同一文稿继续编辑'));
 assert.equal((await engine.inspect(changed)).slides.length,3);
 const chartTarget=model.slides[1].elements.find(e=>e.type==='chart');assert.ok(chartTarget);
 const changedChart=await engine.edit(bytes,[{kind:'command',name:'slides:edit-chart',args:[{slideIndex:1,sourceId:`e_${chartTarget.id.split('shape-')[1]}`,kind:'line',categories:['Q1','Q2'],series:[{name:'营收',values:[200,300]}],title:'更新后的营收'}]}]);
 const changedZip=await JSZip.loadAsync(changedChart);
 const changedBook=await JSZip.loadAsync(await changedZip.file('ppt/embeddings/pm-chart-data-1.xlsx').async('uint8array'));
 assert.match(await changedBook.file('xl/worksheets/sheet1.xml').async('string'),/<c r="B3"><v>300<\/v><\/c>/);
});

test('strict creation refuses dropped pages/elements/fields, unsupported media and unresolved creation aliases',async()=>{
 const page={elements:[title('合法页面')]};
 for(const invalid of [
  {pages:[page,{elements:[]}]},
  {pages:[{elements:[title('合法页面'),{type:'video',x:1,y:1,w:20,h:20}]}]},
  {pages:[{elements:[{...title('超出画布'),x:1270,w:200}]}]},
  {pages:[{elements:[{...title('无效字段'),scripts:'alert(1)'}]}]},
  {pages:[{elements:[{type:'image',x:20,y:20,w:200,h:200,url:'https://example.com/p.png'}]}]},
  {pages:[{elements:[{type:'image',x:20,y:20,w:200,h:200,url:'file:///etc/passwd'}]}]},
  {pages:[{elements:[{type:'shape',shape:'unknown',x:20,y:20,w:200,h:200,fill:'#FFFFFF'}]}]},
  {pages:[page],operations:[step({op:'executeScript',script:'alert(1)'})]},
  {pages:[page],operations:[step({op:'addChart',target:{slide:0},kind:'unknown',categories:['Q1'],series:[{name:'a',values:[1]}],offset:box(1,1,200,200)})]},
  {pages:[page],operations:[step({op:'setNotes',target:{slide:0},text:'x',typo:true})]},
  {pages:[page],operations:[step({op:'setText',target:{slide:0,el:{$ref:'missing'}},paragraphs:[{runs:[{text:'x'}]}]})]},
  {pages:[page],operations:[step({op:'addPicture',target:{slide:0},bytes:'/tmp/private.png',ext:'png',offset:box(1,1,10,10)})]},
  {pages:[page],unexpected:true},
 ]) await assert.rejects(engine.create(invalid));
 await assert.rejects(engine.create({pages:[{elements:[{...title('x'),paragraphs:[{runs:[{text:'x'.repeat(4001)}]}]}]}]}),/text|4000/i);
});

test('existing decks accept the same native data operations and refresh chart workbooks against actual IDs',async()=>{
 const original=await engine.create({pages:[{elements:[title('数据续改')]}],operations:[step({op:'addChart',target:{slide:0},kind:'bar',categories:['A','B'],series:[{name:'旧值',values:[1,2]}],offset:box(100,160,900,400)},'chart')]});
 const context=(await engine.inspect(original)).authoring;
 const chart=context.slides[0].elements.find(e=>e.type==='chart');assert.ok(chart);
 const target=chart.target;
 assert.deepEqual(chart.chart.series[0].values,[1,2]);
 assert.doesNotMatch(JSON.stringify(context),/sourceBase64|originalXml|base64|renderSlides|anchor/);
 const edits=[{kind:'operations',operations:[
  step({op:'setChart',target,patch:{title:'实际数据',categories:['甲','乙'],series:[{name:'新值',values:[10,20]}]}}),
  step({op:'addElement',target:{slide:0},kind:'textbox',offset:box(100,600,500,60),paragraphs:[{runs:[{text:'新增后可引用',fontSize:24}]}]},'new-text'),
  step({op:'setFont',target:{slide:0,el:{$ref:'new-text'}},font:{bold:true}}),
 ]}];
 const saved=await engine.edit(original,edits),model=await engine.inspect(saved);
 assert.ok(model.textElements.some(e=>e.text==='新增后可引用'&&e.originalRichText.paragraphs[0].runs[0].bold));
 const zip=await JSZip.loadAsync(saved),book=await JSZip.loadAsync(await zip.file('ppt/embeddings/pm-chart-data-1.xlsx').async('uint8array'));
 assert.match(await book.file('xl/worksheets/sheet1.xml').async('string'),/<c r="B3"><v>20<\/v><\/c>/);
 assert.match(await zip.file('ppt/charts/chart1.xml').async('string'),/实际数据/);
 await assert.rejects(engine.edit(original,[{kind:'operations',operations:[step({op:'setText',target:{slide:0,el:'e_missing'},paragraphs:[{runs:[{text:'wrong baseline ID'}]}]})]}]),/no element|missing/i);
 await assert.rejects(engine.edit(original,[{kind:'operations',operations:[step({op:'setNotes',target:{slide:0},text:'x',unknown:true})]}]),/unsupported field/);
 await assert.rejects(engine.edit(original,[{kind:'operations',operations:[] }]),/sole edit/);
 await assert.rejects(engine.edit(original,[edits[0],{kind:'command',name:'slides:undo',args:[]}]),/sole edit/);
 const unchanged=await JSZip.loadAsync(await engine.edit(original,[{kind:'command',name:'slides:set-notes',args:[{slideIndex:0,text:'只改备注'}]}]));
 assert.deepEqual(await unchanged.file('ppt/embeddings/pm-chart-data-1.xlsx').async('uint8array'),await (await JSZip.loadAsync(original)).file('ppt/embeddings/pm-chart-data-1.xlsx').async('uint8array'));
});
