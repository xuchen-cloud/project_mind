import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const node = path.join(root, 'src-tauri/resources/agent-host/node')

test('production worker saves the renderer gateway journal within its private filesystem grant', async () => {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'xlsx-production-gateway-')))
  const distribution = path.join(sandbox, 'office-dist'), cwd = path.join(sandbox, 'private')
  const entry = path.join(sandbox, 'src/office-worker-entry.mjs')
  await mkdir(distribution); await mkdir(cwd); await mkdir(path.dirname(entry))
  try {
    await copyFile(path.join(root, 'src-tauri/resources/office-editor/src/office-worker-entry.mjs'), entry)
    await copyFile(path.join(root, 'packages/office-runtime/worker.mjs'), path.join(distribution, 'worker.mjs'))
    for (const [from, to] of [['engine.mjs', 'xlsx-engine.mjs'], ['xlsx-sidecar', 'xlsx-sidecar']])
      await copyFile(new URL(`../dist/${from}`, import.meta.url), path.join(distribution, to))
    const request = async (method, base64, edits) => {
      const requestId = `gateway-${method}`
      const args = ['--permission', `--allow-fs-read=${entry}`, `--allow-fs-read=${distribution}`,
        `--allow-fs-read=${cwd}`, `--allow-fs-write=${cwd}`, '--allow-child-process', entry]
      const result = await new Promise((resolve, reject) => {
        const child = spawn(node, args, { cwd, env: { PATH: '' }, timeout: 30000 })
        const output = [], errors = []
        child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes))
        child.on('error', reject); child.stdin.on('error', reject)
        child.on('close', code => {
          if (code !== 0) return reject(Error(Buffer.concat(errors).toString()))
          try { resolve({...JSON.parse(Buffer.concat(output).toString()),diagnostic:Buffer.concat(errors).toString()}) } catch (error) { reject(error) }
        })
        child.stdin.end(JSON.stringify({ requestId, method, data: { format: 'xlsx', base64, ...(edits ? { edits } : {}) } }) + '\n')
      })
      assert.equal(result.requestId, requestId)
      assert.equal(result.ok, true, JSON.stringify(result.error)+' '+result.diagnostic)
      assert.deepEqual(await readdir(cwd), [], 'all private candidate and gateway scratch files are cleaned')
      return result.data
    }
    const source = await readFile(new URL('./fixtures/complex.original.xlsx', import.meta.url))
    const before = await request('office.inspect', source.toString('base64'))
    const edits = [{ kind: 'gateway', changes: { edits: [
      { sheetId: 'sheet-1', row: 2, column: 1, writeValue: true, value: 15 },
      { sheetId: 'sheet-1', row: 4, column: 1, writeValue: true, value: 40, formula: '=SUM(B3:B4)+5' },
    ], formulaValues: [
      { sheetId: 'sheet-1', row: 4, column: 1, value: 40 },
      { sheetId: 'sheet-1', row: 6, column: 1, value: 30 },
      { sheetId: 'sheet-2', row: 2, column: 1, value: 40 },
    ] } }]
    const saved = await request('office.edit', source.toString('base64'), edits)
    const reopened = await request('office.inspect', saved.base64)
    assert.deepEqual(reopened.model, saved.model)
    const cell = (r, c) => reopened.model.ranges['sheet-1'].cells.find(cell => cell.row === r && cell.column === c)
    assert.equal(cell(2, 1).value, 15); assert.equal(cell(4, 1).formula, '=SUM(B3:B4)+5'); assert.equal(cell(4, 1).value, 40)
    assert.deepEqual(reopened.model.visuals, before.model.visuals)
    const original = await JSZip.loadAsync(source), candidate = await JSZip.loadAsync(Buffer.from(saved.base64, 'base64'))
    for (const name of Object.keys(original.files).filter(name => /charts\/|drawings\/|media\//.test(name) && !original.files[name].dir))
      assert.deepEqual(await candidate.file(name).async('uint8array'), await original.file(name).async('uint8array'), name)
    await writeFile(new URL('./output/gateway-permission.json', import.meta.url), JSON.stringify({ node, permission: 'private cwd only', edits, formula: cell(4, 1), visuals: reopened.model.visuals.length, result: 'passed' }, null, 2))
  } finally { await rm(sandbox, { recursive: true, force: true }) }
})
