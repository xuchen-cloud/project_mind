import {afterEach,expect,test,vi} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {deliver,setExportSink,setRenderPdfSink,setPrintSink} from '../browser-delivery';

afterEach(()=>{setExportSink(undefined);setRenderPdfSink(undefined);setPrintSink(undefined);vi.restoreAllMocks()});
test('native PDF receives exact selected vector pages, embedded resources, page size and links; exports returned PDF bytes unchanged',async()=>{
 const fixture=await PDFDocument.create();fixture.addPage([960,540]);fixture.addPage([960,540]);const bytes=await fixture.save();
 const renderPdf=vi.fn(async()=>bytes),write=vi.fn(async()=>true);setRenderPdfSink(renderPdf);setExportSink(write);
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>{throw new Error('Native PDF must not rasterize SVG pages')});
 const fontCss='@font-face{font-family:"Test";src:url(data:font/ttf;base64,AA==)}';
 const pages=[{svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>selected page 3</text></svg>'},{svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>selected page 1</text><image href="data:image/png;base64,AA=="/></svg>'}];
 expect(await deliver('slides:export-pdf',[{filePath:'selected.pdf',pages,widthPx:1280,heightPx:720,fontCss,links:[[{x:.1,y:.2,w:.3,h:.4,href:'#pg2'}],[]]}])).toEqual({ok:true,path:'selected.pdf'});
 const html=renderPdf.mock.calls[0][0].html;expect(html).toContain(pages[0].svg);expect(html).toContain(pages[1].svg);expect(html.indexOf('selected page 3')).toBeLessThan(html.indexOf('selected page 1'));expect(html.match(/class="page"/g)).toHaveLength(2);expect(html).toContain(`@page { size: ${960/72}in 7.5in; margin: 0; }`);expect(renderPdf.mock.calls[0][0].pageSize).toEqual({widthPt:960,heightPt:540});expect(html).toContain(fontCss);expect(html).toContain('href="#pg2"');expect(html).not.toMatch(/<script|<canvas|<iframe|(?:src|href)="(?:blob:|https?:)/i);
 expect(write).toHaveBeenCalledWith({name:'selected.pdf',mime:'application/pdf',bytes});expect((await PDFDocument.load(write.mock.calls[0][0].bytes)).getPageCount()).toBe(2);
});

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S8AAAAASUVORK5CYII=';
test.each([
 {name:'16:9',widthPx:1280,heightPx:720,pageSize:{widthPt:960,heightPt:540}},
 {name:'4:3',widthPx:960,heightPx:720,pageSize:{widthPt:720,heightPt:540}},
 {name:'custom portrait',widthPx:398,heightPx:634,pageSize:{widthPt:298.5,heightPt:475.5}},
])('PDF and full-slide print send actual $name paper size in points, consistent with HTML',async({widthPx,heightPx,pageSize})=>{
 const pdf=await PDFDocument.create();pdf.addPage([pageSize.widthPt,pageSize.heightPt]);const bytes=await pdf.save();
 const render=vi.fn(async()=>bytes),print=vi.fn(async()=>{});setRenderPdfSink(render);setExportSink(async()=>true);setPrintSink(print);
 await deliver('slides:export-pdf',[{filePath:'geometry.pdf',pages:[{svg:'<svg/>'}],widthPx,heightPx}]);
 expect(render.mock.calls[0][0].pageSize).toEqual(pageSize);expect(render.mock.calls[0][0].html).toContain(`@page { size: ${pageSize.widthPt/72}in ${pageSize.heightPt/72}in; margin: 0; }`);
 await deliver('slides:print',[{pngsBase64:[pixel],widthPx,heightPx,layout:'full'}]);
 expect(print.mock.calls[0][0].pageSize).toEqual(pageSize);expect(print.mock.calls[0][0].html).toContain(`@page { size: ${pageSize.widthPt}pt ${pageSize.heightPt}pt; margin: 0; }`);expect(print.mock.calls[0][0].html).toContain(`.page { width: ${pageSize.widthPt}pt; height: ${pageSize.heightPt}pt; }`);
});
test('source physical geometry overrides fitted canvas pixels for PDF and print',async()=>{
 const pageSize={widthPt:420.25,heightPt:320.5},fixture=await PDFDocument.create();fixture.addPage([pageSize.widthPt,pageSize.heightPt]);const bytes=await fixture.save();
 const render=vi.fn(async()=>bytes),print=vi.fn(async()=>{});
 setRenderPdfSink(render);setExportSink(async()=>true);setPrintSink(print);
 await deliver('slides:export-pdf',[{filePath:'custom.pdf',pages:[{svg:'<svg/>'}],widthPx:1280,heightPx:976.179}],pageSize);
 await deliver('slides:print',[{pngsBase64:[pixel],widthPx:1280,heightPx:976.179}],pageSize);
 expect(render.mock.calls[0][0].pageSize).toEqual(pageSize);expect(print.mock.calls[0][0].pageSize).toEqual(pageSize);
});
test.each([
 {layout:'handout2',orientation:'portrait',pageSize:{widthPt:595.44,heightPt:841.68}},
 {layout:'handout3',orientation:'landscape',pageSize:{widthPt:841.68,heightPt:595.44}},
 {layout:'handout6',orientation:'portrait',pageSize:{widthPt:595.44,heightPt:841.68}},
 {layout:'notes',orientation:'landscape',pageSize:{widthPt:841.68,heightPt:595.44}},
])('$layout print follows its actual A4 $orientation template instead of slide geometry',async({layout,orientation,pageSize})=>{
 const print=vi.fn(async()=>{});setPrintSink(print);
 await deliver('slides:print',[{pngsBase64:[pixel],widthPx:1280,heightPx:720,layout,orientation,notes:['actual notes']}],{widthPt:960,heightPt:540});
 expect(print.mock.calls[0][0].pageSize).toEqual(pageSize);expect(print.mock.calls[0][0].html).toContain(`@page { size: ${pageSize.widthPt}pt ${pageSize.heightPt}pt; margin: 0; }`);
});
test('native PDF rendering failure propagates and does not export stale bytes',async()=>{
 const write=vi.fn(async()=>true);setExportSink(write);setRenderPdfSink(async()=>{throw new Error('native PDF failed')});
 await expect(deliver('slides:export-pdf',[{filePath:'failed.pdf',pages:[{svg:'<svg/>'}],widthPx:1280,heightPx:720}])).rejects.toThrow('native PDF failed');expect(write).not.toHaveBeenCalled();
});
