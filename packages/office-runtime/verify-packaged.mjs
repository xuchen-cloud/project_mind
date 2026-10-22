// Explicit acceptance gate: run after build:office and stage:office-runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const resources = await realpath(path.join(root, 'src-tauri/resources/office-editor'));
const node = path.resolve(resources, '../agent-host', process.platform === 'win32' ? 'node.exe' : 'node');
const entry = path.join(resources, 'src/office-worker-entry.mjs');
const distribution = path.join(resources, 'office-dist');
const guard = "data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20Office%20runtime%27)";
let sequence = 0;
async function request(method, format, base64, edits) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mind-office-packaged-'));
  const cwd = await realpath(temporary);
  const requestId = `packaged-${++sequence}`;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(node, ['--permission', '--max-old-space-size=1024',
        `--allow-fs-read=${entry}`, `--allow-fs-read=${distribution}`, `--allow-fs-read=${cwd}`,
        `--allow-fs-write=${cwd}`, '--allow-child-process', `--import=${guard}`, entry],
      { cwd, env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 90000 });
      const output = [], errors = [];
      child.stdout.on('data', bytes => output.push(bytes));
      child.stderr.on('data', bytes => errors.push(bytes));
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(Buffer.concat(errors).toString() || `Worker exited ${code}`));
        try { resolve(JSON.parse(Buffer.concat(output).toString())); } catch (error) { reject(error); }
      });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify({ requestId, method, data: { format, base64, ...(edits ? { edits } : {}) } }) + '\n');
    });
    assert.equal(result.requestId, requestId);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

for (const [format, fixture] of [
  ['docx', 'packages/office-docx/test/fixtures/simple.original.docx'],
  ['xlsx', 'packages/office-xlsx/tests/fixtures/simple.original.xlsx'],
  ['pptx', 'packages/office-pptx/test/fixtures/simple.pptx'],
]) {
  const base64 = (await readFile(path.join(root, fixture))).toString('base64');
  const { model } = await request('office.inspect', format, base64);
  let edits;
  if (format === 'docx') {
    const node = model.nodes.find(node => node.text.includes('春风拂面'));
    assert.ok(node);
    edits = [{ type: 'text', nodeId: node.id, expectedText: node.text, text: '打包资源保存成功。' }];
  } else if (format === 'xlsx') {
    edits = [{ sheetId: 'sheet-1', row: 2, column: 1, kind: 'number', value: 15 },
      { sheetId: 'sheet-1', row: 4, column: 1, kind: 'formula', formula: '=SUM(B3:B4)+5' }];
  } else {
    const target = model.textElements.find(target => target.text.includes('项目进展正常'));
    assert.ok(target);
    edits = [{ kind: 'text', slideIndex: target.slideIndex, cNvPrId: target.cNvPrId,
      paragraphIndex: 0, runIndex: 0, text: '打包资源保存成功。' }];
  }
  const saved = await request('office.edit', format, base64, edits);
  assert.notEqual(saved.base64, base64);
  const reopened = await request('office.inspect', format, saved.base64);
  assert.deepEqual(reopened.model, saved.model);
  if (format === 'docx') assert.ok(reopened.model.nodes.some(node => node.text === edits[0].text));
  if (format === 'pptx') assert.ok(reopened.model.textElements.some(node => node.text === edits[0].text));
  if (format === 'xlsx') assert.equal(reopened.model.ranges['sheet-1'].cells.find(cell => cell.row === 2 && cell.column === 1).value, 15);
  if (format === 'xlsx') {
    // The complete renderer sends one gateway journal, unlike the scalar edit
    // shortcut above. Both paths must work under the production private grant.
    const gateway = await request('office.edit', 'xlsx', base64, [{ kind: 'gateway', changes: { edits: [
      { sheetId: 'sheet-1', row: 2, column: 1, writeValue: true, value: 15 },
      { sheetId: 'sheet-1', row: 4, column: 1, writeValue: true, value: 40, formula: '=SUM(B3:B4)+5' },
    ], formulaValues: [
      { sheetId: 'sheet-1', row: 4, column: 1, value: 40 },
      { sheetId: 'sheet-1', row: 6, column: 1, value: 30 },
      { sheetId: 'sheet-2', row: 2, column: 1, value: 40 },
    ] } }]);
    const fresh = await request('office.inspect', 'xlsx', gateway.base64);
    assert.deepEqual(fresh.model, gateway.model);
    const formula = fresh.model.ranges['sheet-1'].cells.find(cell => cell.row === 4 && cell.column === 1);
    assert.equal(formula.formula, '=SUM(B3:B4)+5');
    assert.equal(formula.value, 40);
    assert.deepEqual(fresh.model.visuals, model.visuals);
    console.log('xlsx: packaged permission worker renderer gateway save/reopen passed');
  }
  console.log(`${format}: packaged permission worker edit/reopen passed`);
}
