import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as engine from '../dist/engine.mjs'
import JSZip from 'jszip'
const bytes = await readFile(new URL('./fixtures/simple.original.xlsx', import.meta.url))
const request = input => ({ edits: input === null ? [] : [{ sheetId: 'sheet-1', row: 2, column: 1, input: String(input) }],
  reads: [{sheetId:'sheet-1',range:{startRow:6,endRow:6,startColumn:1,endColumn:1}}] })

test('one private baseline serves sequential distinct overlays, undo and independent failures', async () => {
  assert.equal(typeof engine.createRecalculationSession, 'function', 'baseline session must reuse initialization across calls')
  const session = await engine.createRecalculationSession(bytes)
  try {
    for (const value of [15, 10, 21]) assert.equal((await session.recalculate(request(value))).cells[0].number, value * 2)
    const formulaError = await session.recalculate(request('=1/0'))
    assert.equal(formulaError.cells[0].isError, true, 'formula error belongs to this edit, not the previous numeric result')
    assert.equal((await session.recalculate(request(9))).cells[0].number, 18, 'latest edit clears the previous formula error')
    const fresh = await engine.recalculate(bytes, request(null))
    assert.deepEqual(await session.recalculate(request(null)), fresh, 'shrinking overlay restores the immutable source')
    await assert.rejects(session.recalculate({edits:[{sheetId:'foreign',row:0,column:0,input:'1'}],reads:[]}))
    assert.equal((await session.recalculate(request(9))).cells[0].number, 18)
  } finally { await session.close() }
  await assert.rejects(session.recalculate(request(1)), /closed/)
})

for (const missingCaches of [false, true]) test(`50 distinct edits reuse one sidecar/open/model (missing formula caches: ${missingCaches})`, {skip:process.platform==='win32'}, async () => {
  assert.equal(typeof engine.createRecalculationSession, 'function')
  const dir = await mkdtemp(join(tmpdir(),'mind-recalc-session-'))
  const log = join(dir,'commands.jsonl'), wrapper = join(dir,'sidecar-wrapper')
  const binary = fileURLToPath(new URL('../dist/xlsx-sidecar',import.meta.url))
  await writeFile(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({spawn:true})+'\\n');
const child=spawn(${JSON.stringify(binary)},[],{stdio:['pipe','pipe','inherit']});
createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command:JSON.parse(line).command})+'\\n');child.stdin.write(line+'\\n')});
createInterface({input:child.stdout}).on('line',line=>{const frame=JSON.parse(line);if(frame.result?.cached!==undefined)fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cached:frame.result.cached})+'\\n');process.stdout.write(line+'\\n')});
process.on('SIGTERM',()=>child.kill());child.on('close',()=>process.exit());`)
  await chmod(wrapper,0o755)
  let source = bytes
  if (missingCaches) {
    const zip = await JSZip.loadAsync(bytes)
    for (const path of Object.keys(zip.files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
      const xml = await zip.file(path).async('string')
      zip.file(path, xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, cell => /<f\b/.test(cell) ? cell.replace(/<v\b[^>]*>[\s\S]*?<\/v>/g, '') : cell))
    }
    source = await zip.generateAsync({type:'nodebuffer'})
  }
  const session = await engine.createRecalculationSession(source,{binaryPath:wrapper,tempRoot:dir})
  try {
    for(let value=1;value<=50;value++) assert.equal((await session.recalculate(request(value))).cells[0].number,value*2)
    const records=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.filter(r=>r.spawn).length,1)
    assert.equal(records.filter(r=>r.command==='open').length,1)
    assert.equal(records.filter(r=>r.command==='recalc_cells').length,50)
    assert.equal(records.filter(r=>r.cached===false).length,1)
    assert.equal(records.filter(r=>r.cached===true).length,49)
  } finally { await session.close(); await rm(dir,{recursive:true,force:true}) }
})
