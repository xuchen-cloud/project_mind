import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, chmod, cp } from 'node:fs/promises'
import JSZip from 'jszip'
import { inspect, edit, loadRange } from '../dist/engine.mjs'

const bytes = await readFile(new URL('./fixtures/simple.original.xlsx', import.meta.url))
const at = (model, name, row, column) => {
  const sheet = model.sheets.find((sheet) => sheet.name === name)
  return model.ranges[sheet.id].cells.find((cell) => cell.row === row && cell.column === column)
}
test('saving typed edits recalculates dependencies and a sheet with no user edit', async () => {
  const saved = await edit(bytes, [
    { sheetId: 'sheet-1', row: 2, column: 0, kind: 'string', value: '香蕉（SDK编辑）' },
    { sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 15 },
    { sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '=SUM(B3:B4)+5' },
  ])
  const reopened = await inspect(saved)
  assert.equal(at(reopened, '明细', 2, 0).value, '香蕉（SDK编辑）')
  assert.equal(at(reopened, '明细', 4, 1).value, 40)
  assert.equal(at(reopened, '明细', 6, 1).value, 30)
  assert.equal(at(reopened, '说明', 2, 1).value, 40)
})

for (const kind of ['simple', 'complex']) test(`${kind}: consecutive saves reopen correctly and preserve original styles and unrelated parts`, async () => {
  const original = await readFile(new URL(`./fixtures/${kind}.original.xlsx`, import.meta.url))
  const baseline = await inspect(original)
  assert.deepEqual(await edit(original, []), new Uint8Array(original))
  const first = await edit(original, [
    { sheetId: 'sheet-1', row: 2, column: 0, kind: 'string', value: '香蕉（SDK编辑）' },
    { sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 15 },
    { sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '=SUM(B3:B4)+5' },
  ])
  const second = await edit(first, [{ sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 10 }])
  const middle = await inspect(second)
  assert.equal(at(middle, '明细', 4, 1).value, 35)
  assert.equal(at(middle, '明细', 6, 1).value, 20)
  assert.equal(at(middle, '说明', 2, 1).value, 35)
  const third = await edit(second, [{ sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 15 }])
  const reopened = await inspect(third)
  assert.equal(at(reopened, '明细', 2, 0).value, '香蕉（SDK编辑）')
  assert.equal(at(reopened, '明细', 4, 1).formula, '=SUM(B3:B4)+5')
  assert.equal(at(reopened, '明细', 4, 1).value, 40)
  assert.equal(at(reopened, '明细', 6, 1).value, 30)
  assert.equal(at(reopened, '说明', 2, 1).value, 40)
  assert.deepEqual(reopened.styles, baseline.styles)
  assert.equal(at(reopened, '明细', 2, 0).styleIndex, at(baseline, '明细', 2, 0).styleIndex)
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(third)
  assert.deepEqual(Object.keys(after.files), Object.keys(before.files))
  for (const part of Object.keys(before.files)) if (!['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].includes(part)) {
    assert.deepEqual(await after.file(part).async('uint8array'), await before.file(part).async('uint8array'), part)
  }
  await mkdir(new URL('./output/', import.meta.url), { recursive: true })
  await writeFile(new URL(`./output/${kind}.xlsx`, import.meta.url), third)
  await writeFile(new URL(`./output/${kind}.model.json`, import.meta.url), JSON.stringify(reopened))
})

test('blank, numeric text, formula-looking text and numbers remain distinct through recalc and save', async () => {
  const saved = await edit(bytes, [
    { sheetId: 'sheet-1', row: 2, column: 0, kind: 'blank' },
    { sheetId: 'sheet-1', row: 2, column: 1, kind: 'string', value: '15' },
    { sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '=SUM(B3:B4)+5' },
  ])
  const model = await inspect(saved)
  assert.equal(at(model, '明细', 2, 0)?.value ?? null, null)
  assert.equal(at(model, '明细', 2, 1).value, '15')
  assert.equal(at(model, '明细', 4, 1).value, 25, 'SUM ignores numeric text')
  assert.equal(at(model, '明细', 6, 1).value, 30, 'multiplication coerces numeric text')
  assert.equal(at(model, '说明', 2, 1).value, 25)
  await assert.rejects(edit(saved, [{ sheetId: 'sheet-1', row: 2, column: 1, kind: 'string', value: '' }]), /Unsupported formula result/)
  const next = await edit(saved, [
    { sheetId: 'sheet-1', row: 2, column: 0, kind: 'string', value: '=literal🐈' },
    { sheetId: 'sheet-1', row: 2, column: 2, kind: 'string', value: '' },
  ])
  const reopened = await inspect(next)
  assert.equal(at(reopened, '明细', 2, 0).value, '=literal🐈')
  assert.equal(at(reopened, '明细', 2, 0).formula, undefined)
  assert.equal(at(reopened, '明细', 4, 1).value, 25)
  const zip = await JSZip.loadAsync(next)
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(xml, /<c[^>]*r="C3"[^>]*t="inlineStr"[^>]*>[\s\S]*?<is>/)
})

test('formula errors and unsupported results reject the candidate, preserving the original', async () => {
  await assert.rejects(edit(bytes, [{ sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '=1/0' }]), /Unsupported formula result/)
  await assert.rejects(edit(bytes, [{ sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '="hello"' }]), /Unsupported formula result/)
  await assert.rejects(edit(bytes, [{ sheetId: 'sheet-1', row: 19, column: 3, kind: 'formula', formula: '=CELL("filename",A1)' }]), /Unsupported formula/)
  assert.equal(at(await inspect(bytes), '明细', 4, 1).value, 30)
})

test('inspect and explicit load enforce bounded ranges', async () => {
  const model = await inspect(bytes)
  assert.equal(model.ranges['sheet-1'].indexingComplete, true)
  const range = await loadRange(bytes, 'sheet-1', { startRow: 2, endRow: 2, startColumn: 0, endColumn: 1 })
  assert.equal(range.cells.find((cell) => cell.column === 1).value, 10)
  await assert.rejects(loadRange(bytes, 'sheet-1', { startRow: 0, endRow: 1000, startColumn: 0, endColumn: 1000 }), /100000/)
  await assert.rejects(loadRange(bytes, 'sheet-1', { startRow: 3, endRow: 2, startColumn: 0, endColumn: 1 }), /Reversed/)
})

test('blank rows and columns are editable and survive consecutive saves', async () => {
  const initial = await inspect(bytes)
  assert.deepEqual(initial.ranges['sheet-1'].area, { startRow: 0, endRow: 99, startColumn: 0, endColumn: 25 })
  const first = await edit(bytes, [{ sheetId: 'sheet-1', row: 19, column: 3, kind: 'number', value: 7 }])
  const second = await edit(first, [
    { sheetId: 'sheet-1', row: 20, column: 3, kind: 'number', value: 3 },
    { sheetId: 'sheet-1', row: 20, column: 4, kind: 'formula', formula: '=SUM(D20:D21)' },
  ])
  const reopened = await inspect(second)
  assert.equal(at(reopened, '明细', 19, 3).value, 7)
  assert.equal(at(reopened, '明细', 20, 3).value, 3)
  assert.equal(at(reopened, '明细', 20, 4).value, 10)
  assert.equal(at(reopened, '明细', 4, 1).value, 30)
  const extended = await loadRange(second, 'sheet-1', { startRow: 0, endRow: 199, startColumn: 0, endColumn: 51 })
  assert.equal(extended.area.endRow, 199)
  assert.equal(extended.area.endColumn, 51)
  assert.equal(extended.cells.find((c) => c.row === 20 && c.column === 4).value, 10)
  const empty = await loadRange(second, 'sheet-1', { startRow: 150, endRow: 199, startColumn: 40, endColumn: 51 })
  assert.deepEqual(empty.cells, [])
})

test('invalid edit JSON and Unicode fail at the public boundary', async () => {
  for (const change of [
    { kind: 'number', value: NaN }, { kind: 'number', value: '15' },
    { kind: 'string', value: '\ud800' }, { kind: 'formula', formula: 'SUM(B3:B4)' },
    { kind: 'blank', value: '' }, { kind: 'string', value: 'ok', styleReset: true },
  ]) await assert.rejects(edit(bytes, [{ sheetId: 'sheet-1', row: 2, column: 0, ...change }]))
  await assert.rejects(inspect(bytes, { sourcePath: '/external/path' }))
})

test('invalid source XML UTF-8 is rejected without rewriting source bytes', async () => {
  const zip = await JSZip.loadAsync(bytes)
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('nodebuffer')
  const offset = xml.indexOf(Buffer.from('<t>')) + 3
  assert.ok(offset > 0)
  zip.file('xl/worksheets/sheet1.xml', Buffer.concat([xml.subarray(0, offset), Buffer.from([0xff]), xml.subarray(offset + 1)]))
  const corrupted = await zip.generateAsync({ type: 'uint8array' })
  await assert.rejects(inspect(corrupted))
  await assert.rejects(edit(corrupted, [{ sheetId: 'sheet-1', row: 2, column: 0, kind: 'string', value: 'new' }]))
})

test('copied dist works in isolation with its adjacent native binary', async () => {
  const root = await mkdtemp(new URL('./output/relocated-', import.meta.url).pathname)
  try {
    await cp(new URL('../dist/', import.meta.url), `${root}/xlsx`, { recursive: true })
    await writeFile(`${root}/xlsx-engine.mjs`, "export * from './xlsx/engine.mjs'\n")
    const moved = await import(`${root}/xlsx-engine.mjs`)
    const candidate = await moved.edit(bytes, [{ sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 15 }])
    assert.equal(at(await moved.inspect(candidate), '说明', 2, 1).value, 35)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sidecar malformed JSON and invalid UTF-8 fail immediately and scratch is removed', async () => {
  const root = new URL('./output/', import.meta.url)
  await mkdir(root, { recursive: true })
  for (const output of ["Buffer.from([0xff, 10])", "Buffer.from('not json\\n')",
    "Buffer.from(JSON.stringify({version:1,requestId:q.requestId,ok:true,result:{name:'\\\\ud800'}}).replace('\\\\\\\\ud800','\\\\ud800')+'\\n')",
    "Buffer.from(JSON.stringify({version:1,requestId:q.requestId,ok:true,result:{sheets:'wrong'}})+'\\n')"]) {
    const dir = await mkdtemp(new URL('./protocol-', root).pathname)
    const binaryPath = `${dir}/bad-sidecar.mjs`
    const tempRoot = `${dir}/scratch`
    await mkdir(tempRoot)
    await writeFile(binaryPath, `#!${process.execPath}\nprocess.stdin.once('data',(chunk)=>{const q=JSON.parse(chunk);process.stdout.write(${output})});\n`)
    await chmod(binaryPath, 0o755)
    try {
      await assert.rejects(inspect(bytes, { binaryPath, tempRoot }))
      assert.deepEqual(await readdir(tempRoot), [])
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})
