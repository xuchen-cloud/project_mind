export function installXlsxVisualProbe(model) {
function sheetVisualState(model, doc, workbook, decoded) {
    const sheet = workbook.getActiveSheet();
    const visuals = model.visuals.filter(visual => visual.sheetId === sheet.getSheetId() && ['chart', 'image'].includes(visual.kind));
    const evidence = [];
    const pending = (reason) => ({ ready: false, reason, visuals: evidence });
    if (!visuals.length)
        return { ready: true, visuals: evidence };
    const view = doc.defaultView;
    const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const intersect = (a, b) => {
        const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
        const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
        return width > 0 && height > 0 ? { x, y, width, height } : null;
    };
    const onScreen = (node, bounds = box(node)) => {
        let result = intersect(bounds, { x: 0, y: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight });
        for (let parent = node; parent && result; parent = parent.parentElement) {
            const style = view.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
                return null;
            if (parent !== node && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
                const r = box(parent);
                result = intersect(result, { x: /(hidden|clip|auto|scroll)/.test(style.overflowX) ? r.x : result.x,
                    y: /(hidden|clip|auto|scroll)/.test(style.overflowY) ? r.y : result.y,
                    width: /(hidden|clip|auto|scroll)/.test(style.overflowX) ? r.width : result.width,
                    height: /(hidden|clip|auto|scroll)/.test(style.overflowY) ? r.height : result.height });
            }
        }
        return result;
    };
    const surface = doc.querySelector('canvas[id^="univer-sheet-main-canvas"]');
    if (!surface)
        return pending('visual anchor has no sheet surface');
    const surfaceBox = box(surface), zoom = sheet.getZoom();
    const scroll = workbook.getScrollStateBySheetId(sheet.getSheetId());
    if (!scroll || !(zoom > 0))
        return pending('visual anchor scroll/zoom unavailable');
    const origin = sheet.getRange(0, 0, 1, 1).getCellRect();
    const scrollCell = sheet.getRange(scroll.sheetViewStartRow, scroll.sheetViewStartColumn, 1, 1).getCellRect();
    const freeze = sheet.getSheet().getFreeze();
    const scrollX = scrollCell.x - origin.x + scroll.offsetX, scrollY = scrollCell.y - origin.y + scroll.offsetY;
    const nodes = [...doc.querySelectorAll('[data-print-visual]')];
    for (const visual of visuals) {
        const a = visual.anchor, from = sheet.getRange(a.fromRow, a.fromColumn, 1, 1).getCellRect();
        const to = sheet.getRange(a.toRow, a.toColumn, 1, 1).getCellRect();
        const expectedBox = { x: surfaceBox.x + (from.x + a.fromColumnOffset / 9525 - (a.fromColumn < freeze.xSplit ? 0 : scrollX)) * zoom,
            y: surfaceBox.y + (from.y + a.fromRowOffset / 9525 - (a.fromRow < freeze.ySplit ? 0 : scrollY)) * zoom,
            width: Math.max(1, to.x - from.x + (a.toColumnOffset - a.fromColumnOffset) / 9525) * zoom,
            height: Math.max(1, to.y - from.y + (a.toRowOffset - a.fromRowOffset) / 9525) * zoom };
        const node = nodes.find(node => node.getAttribute('data-print-visual') === visual.id);
        const rendered = node?.firstElementChild ?? node;
        const expectedIntersection = onScreen(surface, expectedBox);
        const actualIntersection = rendered && onScreen(rendered);
        const item = { id: visual.id, kind: visual.kind, expectedBox, expectedIntersection,
            actualBox: rendered && box(rendered), actualIntersection: actualIntersection ?? null };
        evidence.push(item);
        // Missing asynchronous installs are obligations only where the native
        // anchor intersects this viewport. Existing DOM may also reveal a visual
        // displaced into view; it must meet the same content gate.
        if (!expectedIntersection && !actualIntersection) {
            item.offscreen = true;
            continue;
        }
        if (!node || !rendered || !actualIntersection)
            return pending(`visible visual ${visual.id} not installed in viewport`);
        item.geometry = [box(rendered)];
        if (visual.kind === 'chart') {
            const chart = visual.chart, svg = node.querySelector('svg.chart-svg'), title = node.querySelector('figcaption');
            const titleText = title?.textContent?.trim();
            item.title = titleText;
            item.expectedTitle = chart?.title;
            if (!chart || !svg || !title || titleText !== chart.title || !box(svg).width || !box(svg).height || !box(title).height)
                return pending(`chart ${visual.id} SVG/title not ready`);
            // Fixture charts are clustered positive bars. Resolve uncached series
            // refs from native inspected cells, just as the real chart hydrates them.
            const vectors = chart.series.map((series) => {
                if (series.values.length)
                    return series.values;
                const ref = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/u.exec(series.valuesRef ?? '');
                if (!ref)
                    throw Error(`Chart ${visual.id} has no verifiable native series: ${series.valuesRef}`);
                const name = (ref[1] ?? ref[2]).replace(/''/g, "'"), sourceSheet = model.sheets.find(sheet => sheet.name === name);
                const col = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
                const values = [];
                for (let row = Number(ref[4]) - 1; row < Number(ref[6]); row++)
                    for (let column = col(ref[3]); column <= col(ref[5]); column++) {
                        const cell = sourceSheet && model.ranges[sourceSheet.id]?.cells.find(cell => cell.row === row && cell.column === column);
                        if (typeof cell?.value !== 'number')
                            throw Error(`Chart ${visual.id} native series cell missing/non-numeric: ${row}:${column}`);
                        values.push(cell.value);
                    }
                return values;
            });
            if (!chart.chartTypes.includes('barChart') || vectors.some(vector => vector.some(value => value < 0)))
                throw Error(`Unsupported first-screen chart proof: ${visual.id}`);
            const expectedBars = Array.from({ length: Math.max(0, ...vectors.map(vector => vector.length)) }, (_, index) => vectors.map(vector => vector[index] ?? 0)).flat().filter(value => value > 0);
            const bars = [...svg.querySelectorAll('g rect')].filter(bar => Number(bar.getAttribute('width')) > 0 && Number(bar.getAttribute('height')) > 0);
            const lengths = bars.map(bar => Number(bar.getAttribute(chart.barDirection === 'bar' ? 'width' : 'height')));
            const scale = lengths[0] / expectedBars[0];
            item.expectedBars = expectedBars;
            item.barLengths = lengths;
            if (!expectedBars.length || bars.length !== expectedBars.length || !Number.isFinite(scale) || scale <= 0 || lengths.some((length, index) => Math.abs(length / scale - expectedBars[index]) > 0.001) || bars.some(bar => !box(bar).width || !box(bar).height || view.getComputedStyle(bar).visibility === 'hidden' || view.getComputedStyle(bar).fill === 'none' || view.getComputedStyle(bar).fillOpacity === '0' || view.getComputedStyle(bar).opacity === '0'))
                return pending(`chart ${visual.id} actual series bars not ready`);
            item.geometry.push(box(svg), box(title), ...bars.map(box));
        }
        else {
            const image = node.querySelector('img'), media = model.rendererData?.media[visual.id];
            if (!media)
                throw Error(`Native image ${visual.id} has no inspected media witness`);
            if (!image)
                return pending(`image ${visual.id} not installed`);
            const source = image.currentSrc || image.src;
            item.sourceMatches = source === `data:${media.mediaType};base64,${media.base64}`;
            item.mediaType = media.mediaType;
            item.naturalWidth = image.naturalWidth;
            item.naturalHeight = image.naturalHeight;
            if (!item.sourceMatches)
                return pending(`image ${visual.id} source differs from native media`);
            let state = decoded.get(image);
            if (!state || state.source !== source) {
                state = { source, status: 'pending' };
                decoded.set(image, state);
                const current = state;
                void image.decode().then(() => { current.status = 'decoded'; }, error => { current.status = 'error'; current.error = String(error); });
            }
            item.decodeStatus = state.status;
            if (state.status === 'error')
                throw Error(`Image ${visual.id} decode failed: ${state.error}`);
            if (state.status !== 'decoded' || !image.naturalWidth || !image.naturalHeight || !onScreen(image))
                return pending(`image ${visual.id} decoded visible pixels not ready`);
            item.geometry.push(box(image));
        }
    }
    return { ready: true, visuals: evidence };
}

 const e = window.__officePerfEvidence, decoded = new WeakMap();
 e.readVisuals = () => sheetVisualState(model, document, e.runtime.univerAPI.getActiveWorkbook(), decoded);
}
// Runs in every document, including the real srcdoc/blob renderer frames.
export function installObservers(){
 const evidence=window.__officePerfEvidence={painted:[],longTasks:[],runtime:null,context:null,calculation:{started:0,ended:0,applied:0,pending:false,events:[]}};
 const original=CanvasRenderingContext2D.prototype.fillText;
 CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(evidence.painted.length<2000)evidence.painted.push(String(text));return original.call(this,text,...args)};
 try{new PerformanceObserver(list=>{evidence.longTasks.push(...list.getEntries().map(e=>({startTime:e.startTime,duration:e.duration})))}).observe({type:'longtask',buffered:true})}catch{}
 Object.defineProperty(window,'__projectMindSheetsHost',{configurable:true,set(host){
  const attach=host.attach,render=host.render;
  host.attach=function(runtime){evidence.runtime=runtime;const formula=runtime.univerAPI.getFormula(),calc=evidence.calculation;
   formula.calculationStart(()=>{calc.started++;calc.pending=true;calc.events.push({type:'start',at:performance.now()})});
   formula.calculationEnd(state=>{calc.ended++;calc.events.push({type:'end',at:performance.now(),state})});
   formula.calculationResultApplied(()=>{calc.applied++;calc.pending=false;calc.events.push({type:'applied',at:performance.now()})});
   return attach.call(this,runtime)};
  host.render=function(context){evidence.context=context;return render.call(this,context)};
  Object.defineProperty(window,'__projectMindSheetsHost',{value:host,writable:true,configurable:true});
 }});
}
export async function contentProbe(page,sample,timeout){
 const frame=page.frames().find(f=>f.parentFrame()===page.mainFrame());if(!frame)throw Error('Renderer frame missing');
 const expected=sample.format==='xlsx'?await page.evaluate(()=>window.officePerf.formulas()):[];
 if(sample.format==='xlsx')await frame.waitForFunction(expected=>{
  const e=window.__officePerfEvidence,ctx=e.context,state=ctx?.lazyWorkbookRef.current,book=e.runtime?.univerAPI.getActiveWorkbook();
  if(!book||ctx.openingWorkbook||!state?.flags.preloadComplete||e.calculation.pending)return false;
  if(state.formulaMode&&expected.length&&e.calculation.applied===0)return false;
  return expected.every(c=>{const sheet=book.getSheets().find(s=>s.getSheetId()===c.sheetId),cell=sheet?.getRange(c.row,c.column,1,1).getCellData();const actualFormula=cell?.f||state.formulaText.get(c.sheetId)?.get(`${c.row}:${c.column}`);return cell&&actualFormula===c.formula&&(Object.is(cell.v??null,c.value)||typeof cell.v==='string'&&cell.v===c.formatted)});
 },expected,{timeout});
 if(sample.format==='xlsx'){
  const model=await page.evaluate(()=>window.officePerf.model());
  await frame.evaluate(installXlsxVisualProbe,model);
  await frame.waitForFunction(()=>{const e=window.__officePerfEvidence;const state=e.readVisuals();e.lastVisualCheck=state;return state.ready},undefined,{timeout});
 }
 const calculation=sample.format==='xlsx'?await frame.evaluate(expected=>{
  const e=window.__officePerfEvidence,book=e.runtime.univerAPI.getActiveWorkbook(),sheet=book.getActiveSheet();let populated=0;
  sheet.getSheet().getCellMatrix().forValue((_r,_c,cell)=>{if(cell?.v!=null||cell?.p||cell?.f)populated++});if(!populated)throw Error('Univer blank matrix');
  return {...e.calculation,populated,expectedFormulaCells:expected.map(c=>({...c,actual:book.getSheets().find(s=>s.getSheetId()===c.sheetId)?.getRange(c.row,c.column).getCellData()})),formulaMode:e.context.lazyWorkbookRef.current.formulaMode,preloadComplete:true,manual:e.context.calcManual,forcedCalculation:false};
 },expected):null;
 await frame.waitForFunction(witness=>{
  const texts=window.__officePerfEvidence.painted.join(' '),body=document.body.innerText;
  return texts.includes(witness)||body.includes(witness);
 },sample.witness,{timeout});
 const paint=await frame.evaluate(async({format,witness})=>{
  await document.fonts.ready;
  const images=await Promise.all([...document.images].map(async img=>{
   const r=img.getBoundingClientRect(),style=getComputedStyle(img),src=img.currentSrc||img.getAttribute('src')||'',placeholder=img.matches('.ProseMirror-separator')||!src;
   const visible=style.display!=='none'&&style.visibility!=='hidden'&&r.width>0&&r.height>0,firstScreen=visible&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;
   let decodeError=null;try{if(format!=='xlsx'||firstScreen)await img.decode()}catch(error){decodeError=String(error)}
   return {src,placeholder,visible,firstScreen,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,width:r.width,height:r.height,decodeError};
  }));
  const firstScreenFailures=images.filter(i=>!i.placeholder&&i.firstScreen&&(i.decodeError||i.naturalWidth===0));
  if(firstScreenFailures.length)throw Error('First-screen image decode failed: '+JSON.stringify(firstScreenFailures));
  const selector=format==='docx'?'.tiptap.doc-page':format==='pptx'?'.stage-rel':'canvas[id^="univer-sheet-main-canvas"]';
  const surface=[...document.querySelectorAll(selector)].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'});if(!surface)throw Error('Missing actual document surface: '+selector);
  // Three unchanged animation-frame geometries, after fonts/images. Bounded by runner timeout.
  let previous='',stable=0,frames=0;
  while(stable<3){await new Promise(requestAnimationFrame);const r=surface.getBoundingClientRect(),visuals=format==='xlsx'?window.__officePerfEvidence.readVisuals():{ready:true,visuals:[]},signature=JSON.stringify([r.x,r.y,r.width,r.height,surface.scrollWidth,surface.scrollHeight,document.fonts.status,visuals.visuals.filter(v=>!v.offscreen).map(v=>[v.id,v.geometry,v.actualIntersection])]);stable=visuals.ready&&signature===previous?stable+1:0;previous=signature;frames++;if(frames>300)throw Error('Layout did not settle')}
  const rect=surface.getBoundingClientRect();if(!rect.width||!rect.height)throw Error('Empty document surface');
  const e=window.__officePerfEvidence;return {witness,images,visuals:format==='xlsx'?e.readVisuals():undefined,initialization:performance.getEntriesByType('mark').filter(e=>e.name.startsWith('office-xlsx:')).map(e=>e.toJSON()),canvasWitness:e.painted.some(t=>t.includes(witness)),domWitness:document.body.innerText.includes(witness),surface:{width:rect.width,height:rect.height},layoutFrames:frames,fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),longTasks:e.longTasks,resources:performance.getEntriesByType('resource').map(e=>e.toJSON())};
 },sample);
 return {frame,calculation,paint};
}
export async function modeProbe(page,frame,format,next,timeout){
 await page.evaluate(next=>window.officePerf.setMode(next),next);
 await frame.waitForFunction(({format,next})=>(format==='pptx'?document.body:document.documentElement).dataset.presentationMode===next,{format,next},{timeout});
 await frame.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const e=window.__officePerfEvidence;e.modeVisualSignature=null;e.modeVisualStable=0});
 if(format==='xlsx')await frame.waitForFunction(()=>{const e=window.__officePerfEvidence,state=e.readVisuals();e.lastVisualCheck=state;const signature=JSON.stringify(state.visuals.filter(v=>!v.offscreen).map(v=>[v.id,v.geometry,v.actualIntersection]));e.modeVisualStable=state.ready&&signature===e.modeVisualSignature?e.modeVisualStable+1:0;e.modeVisualSignature=signature;return e.modeVisualStable>=3},undefined,{timeout});
}
export async function interactionProbe(page,frame,format,timeout){
 if(format==='docx'){
  const body=frame.locator('.tiptap.doc-page').first();await body.click({position:{x:50,y:20}});
  await frame.waitForFunction(()=>{const e=document.activeElement;return e?.isContentEditable||!!getSelection()?.anchorNode},{},{timeout});
  return {kind:'document-focus',focused:true};
 }
 if(format==='pptx'){
  const slider=frame.locator('.zoom-slider');const before=Number(await slider.inputValue());await frame.locator('.zoom-btn').last().click();
  await frame.waitForFunction(before=>Number(document.querySelector('.zoom-slider').value)!==before,before,{timeout});return {kind:'zoom-click',before,after:Number(await slider.inputValue())};
 }
 const box=frame.locator('input[type="text"]:visible').last();await box.fill('B3');await box.press('Enter');
 await frame.waitForFunction(()=>{const range=window.__officePerfEvidence.runtime.univerAPI.getActiveWorkbook().getActiveRange()?.getRange();return range?.startRow===2&&range?.startColumn===1},undefined,{timeout});
 return {kind:'name-box-keyboard-navigation',row:2,column:1};
}
