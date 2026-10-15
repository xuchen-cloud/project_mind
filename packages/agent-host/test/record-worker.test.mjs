import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const worker = fileURLToPath(new URL('../src/record-worker-entry.mjs', import.meta.url));
async function requests(frames) {
  const child = spawn(process.execPath, [worker], { env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdin.end(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  return stdout.trim().split('\n').map((line) => JSON.parse(line));
}

test('standalone worker produces one canonical tree and matching compatibility projections', { timeout: 10000 }, async () => {
  const [response] = await requests([{ requestId: 'initialize', method: 'record.initialize', data: { html: '<h2>标题</h2><p><strong>正文</strong></p>', codeLanguage: 'TypeScript' } }]);
  assert.ok(response.ok);
  assert.equal(response.data.codeLanguage, 'typescript');
  assert.equal(response.data.document.content.length, 2);
  assert.ok(response.data.html.includes('data-block-id'));
  assert.ok(response.data.markdown.includes('## 标题'));
  const body = JSON.stringify({ codeLanguage: response.data.codeLanguage, document: response.data.document });
  assert.equal(response.data.bodyHash, `sha256:${createHash('sha256').update(body).digest('hex')}`);
  const [validated] = await requests([{ requestId: 'validate', method: 'record.validate', data: { document: response.data.document, codeLanguage: 'typescript' } }]);
  assert.deepEqual(validated.data, response.data);
  const [unsupported] = await requests([{ requestId: 'unsupported', method: 'record.initialize', data: { html: '<div data-type="unknownNode">Preserve</div>' } }]);
  assert.equal(unsupported.error.code, 'INVALID_PATCH');
});

test('creating a distinct Record regenerates every block identity without changing content', { timeout: 10000 }, async () => {
  const [initial] = await requests([{ requestId: 'source', method: 'record.initialize', data: { html: '<blockquote><p>Copy me</p></blockquote><p>Second</p>' } }]);
  const [created] = await requests([{ requestId: 'create', method: 'record.create', data: { document: initial.data.document, codeLanguage: 'Python' } }]);
  assert.ok(created.ok);
  assert.equal(created.data.codeLanguage, 'python');
  assert.equal(created.data.markdown, initial.data.markdown);
  const ids = (node) => [node.attrs?.blockId, ...(node.content ?? []).flatMap(ids)].filter(Boolean);
  assert.equal(ids(created.data.document).length, ids(initial.data.document).length);
  assert.ok(ids(created.data.document).every((id) => !ids(initial.data.document).includes(id)));
  const [invalid] = await requests([{ requestId: 'bad-create', method: 'record.create', data: { document: { type: 'doc', content: [{ type: 'unsupported' }] } } }]);
  assert.equal(invalid.ok, false);
});

test('Rust schema fixture stays in sync with the actual editor/worker schema', { timeout: 10000 }, async () => {
  const [response] = await requests([{ requestId: 'schema', method: 'record.schema' }]);
  const expected = JSON.parse(await readFile(new URL('../../../src-tauri/src/record_document_schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(response.data, expected);
  const projection = JSON.parse(await readFile(new URL('../../../src-tauri/src/record_document_projection.fixture.json', import.meta.url), 'utf8'));
  const [validated] = await requests([{ requestId: 'projection', method: 'record.validate', data: { document: projection.document, codeLanguage: projection.codeLanguage } }]);
  assert.deepEqual(validated.data, projection);
});

test('standalone worker previews block patches and rejects the whole malformed batch', { timeout: 10000 }, async () => {
  const [initial] = await requests([{ requestId: 'baseline', method: 'record.initialize', data: { html: '<p>Original</p><p>Untouched</p>' } }]);
  const first = initial.data.document.content[0];
  const blockHash = `sha256:${createHash('sha256').update(JSON.stringify(first)).digest('hex')}`;
  const [patched] = await requests([{ requestId: 'patch', method: 'record.patch', data: {
    document: initial.data.document, operations: [
      { op: 'append_inline', blockId: first.attrs.blockId, expectedBlockHash: blockHash, text: '<literal>' },
      { op: 'append', parentBlockId: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'New' }] }] },
    ],
  } }]);
  assert.ok(patched.ok);
  assert.equal(patched.data.patch.createdBlockIds.length, 1);
  assert.equal(patched.data.patch.noChange, false);
  assert.ok(patched.data.html.includes('&lt;literal&gt;'));
  assert.deepEqual(patched.data.document.content[1], initial.data.document.content[1]);
  const [invalid] = await requests([{ requestId: 'invalid', method: 'record.patch', data: {
    document: initial.data.document, operations: [
      { op: 'append_inline', blockId: first.attrs.blockId, expectedBlockHash: blockHash, text: 'Would change' },
      { op: 'delete', blockId: '0'.repeat(32), expectedBlockHash: blockHash },
    ],
  } }]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_PATCH');
  assert.equal(invalid.data, undefined);
});
