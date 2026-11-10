import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile, mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import JSZip from 'jszip'
const engine = await import(process.env.XLSX_RED_BASELINE ? '/Users/xuchen/project_mind/packages/office-xlsx/dist/engine.mjs' : '../dist/engine.mjs')
const fixture = await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url))
async function largeSource() {
  const zip = await JSZip.loadAsync(fixture)
  const path = 'xl/worksheets/sheet1.xml'
  let xml = await zip.file(path).async('string')
  const rows = Array.from({length: 19990}, (_,i) => `<row r="${i+11}"><c r="A${i+11}"><v>${i+11}</v></c></row>`).join('')
  xml = xml.replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1:H20000"/>').replace('</sheetData>', rows + '</sheetData>')
  zip.file(path, xml)
  // A wholly unvisited part with independent relationships/media is preserved byte-for-byte.
  zip.file('xl/worksheets/never-opened.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="999999"><c r="A999999" t="inlineStr"><is><t>untouched tail</t></is></c></row></sheetData></worksheet>')
  // Both precedents are outside the initial view. Keep an explicit known cache.
  const addCell = (xml, address, content) => xml.replace(/(<row\b[^>]*r="1"[^>]*>)([\s\S]*?)(<\/row>)/, (_all, start, cells, end) => start + cells.replace(new RegExp('<c\\b[^>]*r="'+address+'"[^>]*>[\\s\\S]*?<\\/c>'), '') + content + end)
  zip.file(path, addCell(xml,'C1', '<c r="C1"><f>A20000+\'说明\'!Z1</f><v>20007</v></c>'))
  const dependency = 'xl/worksheets/sheet2.xml'
  zip.file(dependency, addCell(await zip.file(dependency).async('string'), 'Z1', '<c r="Z1"><v>7</v></c>').replace(/<dimension\b[^>]*\/>/, '<dimension ref="A1:Z10"/>'))
  return new Uint8Array(await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}))
}
test('GUI view is partial, editable metadata ready, and reads reuse one immutable native owner', async () => {
  assert.equal(typeof engine.createViewSession, 'function', 'regression: complete inspect cannot deliver a partial first viewport')
  const bytes = await largeSource(), original = new Uint8Array(bytes), root = await mkdtemp(join(tmpdir(), 'xlsx-view-test-'))
  let session
  try {
    const opening = engine.createViewSession(bytes, {tempRoot: root})
    bytes.fill(0)
    session = await opening
    const {model} = session
    assert.equal(model.coverage.kind, 'partial')
    assert.equal(model.coverage.sourceHash, createHash('sha256').update(original).digest('hex'))
    assert.deepEqual(Object.keys(model.ranges), [model.activeSheetId])
    const initial = model.ranges[model.activeSheetId]
    assert.deepEqual(initial.area, {startRow:0,endRow:99,startColumn:0,endColumn:25})
    assert(initial.cells.every(cell=>cell.row<100))
    assert.equal(initial.metadataReady, true)
    assert.equal(initial.rangeReady, true)
    for(const key of ['formulas','outlines','media','pivots']) assert.deepEqual(model.rendererData[key], {})
    const owners = await readdir(root)
    assert.equal(owners.length,1)
    for (const row of [19000, 0, 10000]) {
      const range = await session.read({kind:'range',sheetId:model.activeSheetId,range:{startRow:row,endRow:row,startColumn:0,endColumn:7}})
      assert.equal(range.rangeReady,true)
      if(row) assert.equal(range.cells.find(c=>c.column===0).value,row+1)
      assert.deepEqual(await readdir(root),owners,'scroll reads must not reopen a temporary workbook')
    }
    await assert.rejects(session.read({kind:'range',sheetId:'missing',range:initial.area}),/Unknown sheet/)
    await assert.rejects(session.read({kind:'pivot',path:'xl/workbook.xml'}),/Unknown pivot/)
    await assert.rejects(session.read({kind:'range',sheetId:model.activeSheetId,range:{startRow:0,endRow:100000,startColumn:0,endColumn:2}}),/100000/)
    await session.close()
    assert.deepEqual(await readdir(root),[])
    await assert.rejects(session.read({kind:'outline',sheetId:model.activeSheetId}),/closed/)
  } finally {await session?.close();await rm(root,{recursive:true,force:true})}
})

test('two cumulative gateway saves from only the first viewport reopen with tail, media, relationships and untouched OOXML intact', async () => {
  assert.equal(typeof engine.createViewSession,'function')
  const source=await largeSource(), session=await engine.createViewSession(source)
  let model
  try {model=session.model} finally {await session.close()}
  assert(model.ranges[model.activeSheetId].cells.every(cell=>cell.row<100))
  const firstEdit={sheetId:model.activeSheetId,row:2,column:0,writeValue:true,value:'first progressive save'}
  const secondEdit={sheetId:model.activeSheetId,row:2,column:1,writeValue:true,value:17}
  const first=await engine.edit(source,[{kind:'gateway',changes:{edits:[firstEdit]}}])
  const second=await engine.edit(source,[{kind:'gateway',changes:{edits:[firstEdit,secondEdit]}}])
  const reopened=await engine.inspect(second)
  const cells=reopened.ranges[model.activeSheetId].cells
  assert.equal(cells.find(c=>c.row===2&&c.column===0).value,'first progressive save')
  assert.equal(cells.find(c=>c.row===2&&c.column===1).value,17)
  assert.equal(cells.find(c=>c.row===19999&&c.column===0).value,20000)
  const one=await engine.inspect(first)
  assert.equal(one.ranges[model.activeSheetId].cells.find(c=>c.row===2&&c.column===0).value,'first progressive save')
  const before=await JSZip.loadAsync(source), after=await JSZip.loadAsync(second)
  assert.deepEqual(Object.keys(after.files).sort(),Object.keys(before.files).sort())
  let unchanged=0
  for(const path of Object.keys(before.files)) {
    if(before.files[path].dir||['xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'].includes(path))continue
    assert.deepEqual(await after.file(path).async('uint8array'),await before.file(path).async('uint8array'),path)
    unchanged++
  }
  assert(unchanged>10)
  assert(reopened.ranges['sheet-2'].cells.some(cell=>cell.formula),'cross-sheet formulas survive')
})

test('first viewport keeps a cross-sheet and unloaded-tail formula cache; native recalculation resolves complete precedents', async () => {
  assert.equal(typeof engine.createViewSession,'function')
  const source=await largeSource(), session=await engine.createViewSession(source)
  try {
    const {model}=session, cells=model.ranges[model.activeSheetId].cells
    const formula=cells.find(cell=>cell.row===0&&cell.column===2)
    assert.equal(formula.value,20007)
    assert.equal(formula.formula,"=A20000+'说明'!Z1")
    assert(!cells.some(cell=>cell.row===19999))
    assert.equal(model.ranges['sheet-2'],undefined)
    const result=await engine.recalculate(source,{edits:[{sheetId:model.activeSheetId,row:19999,column:0,input:'30000'},{sheetId:'sheet-2',row:0,column:25,input:'9'}],reads:[{sheetId:model.activeSheetId,range:{startRow:0,endRow:0,startColumn:2,endColumn:2}}]})
    assert.equal(result.cells.find(cell=>cell.row===0&&cell.column===2).number,30009)
    const unchanged=await session.read({kind:'range',sheetId:model.activeSheetId,range:{startRow:0,endRow:0,startColumn:2,endColumn:2}})
    assert.equal(unchanged.cells[0].value,20007,'native calculation must not replace the immutable view source')
  } finally {await session.close()}
})

test('declared pivot cache and lazy media match complete authoring inspection', async () => {
  assert.equal(typeof engine.createViewSession,'function')
  const source=await engine.edit(fixture,[{kind:'gateway',changes:{pivotAdditions:[{sheetId:'sheet-2',sourceSheetId:'sheet-1',sourceArea:{startRow:1,endRow:3,startColumn:0,endColumn:1},location:{startRow:20,endRow:23,startColumn:0,endColumn:1},name:'ProgressivePivot',fieldNames:['品名','金额'],rowFieldIndices:[0],rowItems:['香蕉','苹果'],values:[{fieldIndex:1,agg:'sum'}]}]}}])
  const complete=await engine.inspect(source), session=await engine.createViewSession(source)
  try {
    const pivot=session.model.sheets.flatMap(sheet=>sheet.pivotTables)[0]
    assert(pivot.cachePath)
    assert.deepEqual(await session.read({kind:'pivot',path:pivot.path}),complete.rendererData.pivots[pivot.path])
    const mediaId=Object.keys(complete.rendererData.media)[0]
    assert(mediaId)
    assert.deepEqual(await session.read({kind:'media',visualId:mediaId}),complete.rendererData.media[mediaId])
    assert.deepEqual(session.model.rendererData.pivots,{})
    assert.deepEqual(session.model.rendererData.media,{})
  } finally {await session.close()}
})

test('first view excludes real unvisited tail cells and other-sheet cell JSON', async () => {
  // Baseline runs the actual pre-change complete inspect; no synthetic parser or workbook.
  const source=await largeSource(), model=await (engine.inspectView??engine.inspect)(source)
  assert(model.ranges[model.activeSheetId].cells.every(cell=>cell.row<100), 'unvisited tail cells must not be serialized into the GUI initial model')
  assert.deepEqual(Object.keys(model.ranges),[model.activeSheetId], 'other sheets load only through native reads')
})
