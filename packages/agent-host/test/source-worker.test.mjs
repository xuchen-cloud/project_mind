import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.env.PROJECT_MIND_TEST_NODE_EXECUTABLE ?? process.execPath;
const frame = (format, bytes) => ({ requestId: 'source-isolated', format, base64: Buffer.from(bytes).toString('base64') });

async function isolatedRequest(request) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), '来源 提取-')));
  try {
    const sources = path.join(temp, 'src'); const bundles = path.join(temp, 'source-dist');
    await mkdir(sources); await mkdir(bundles);
    await copyFile(path.join(root, 'src/source-worker-entry.mjs'), path.join(sources, 'source-worker-entry.mjs'));
    const manifest = JSON.parse(await readFile(path.join(root, 'source-dist/source-worker-distribution.json')));
    for (const entry of [...manifest.bundles, ...manifest.assets]) {
      const bytes = await readFile(path.join(root, 'source-dist', entry.file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.checksum);
      await mkdir(path.dirname(path.join(bundles, entry.file)), { recursive: true });
      await copyFile(path.join(root, 'source-dist', entry.file), path.join(bundles, entry.file));
    }
    const child = spawn(node, ['--permission', '--max-old-space-size=512', `--allow-fs-read=${sources}`, `--allow-fs-read=${bundles}`, path.join(sources, 'source-worker-entry.mjs')], {
      cwd: temp, env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { if (stderr.length < 4096) stderr += part; });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request) + '\n');
    const deadline = setTimeout(() => child.kill(), 15000);
    try {
      const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(status, 0, stderr);
      const lines = stdout.trim().split('\n'); assert.equal(lines.length, 1, stdout);
      return JSON.parse(lines[0]);
    } finally { clearTimeout(deadline); child.kill(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function pdfFixture(encrypted = false, text = 'Standalone PDF evidence') {
  const doc = new PDFDocument({ ...(encrypted ? { userPassword: 'test-only-password', ownerPassword: 'test-only-owner' } : {}) });
  const parts = [];
  const bytes = new Promise((resolve, reject) => { doc.on('data', part => parts.push(part)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(parts))); });
  if (/[^\x00-\x7f]/u.test(text)) doc.font(fileURLToPath(new URL('../../../src/assets/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)));
  doc.text(text); doc.end(); return bytes;
}

test('standalone extraction works with Chinese paths, no PATH or installed modules', { timeout: 20000 }, async () => {
  const response = await isolatedRequest(frame('html', '<p>中文 evidence</p><script>fetch("https://private.test")</script>'));
  assert.equal(response.ok, true); assert.equal(response.data.state, 'ready');
  assert.deepEqual(response.data.chunks.map(chunk => chunk.text), ['中文 evidence']);
});

test('standalone PDF parsing needs no native canvas and keeps a clean protocol', { timeout: 20000 }, async () => {
  const response = await isolatedRequest(frame('pdf', await pdfFixture()));
  assert.equal(response.ok, true); assert.equal(response.data.state, 'ready');
  assert.equal(response.data.chunks[0].text, 'Standalone PDF evidence');
  assert.equal(response.data.chunks[0].locator.page, 1);
  const locked = await isolatedRequest(frame('pdf', await pdfFixture(true)));
  assert.equal(locked.ok, true); assert.equal(locked.data.state, 'encrypted');
});

test('standalone extraction rejects malformed and multiple frames', { timeout: 20000 }, async () => {
  for (const request of ['{invalid}\n', JSON.stringify(frame('text', 'one')) + '\n' + JSON.stringify(frame('text', 'two')) + '\n']) {
    const response = await isolatedRequest(request); assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
  }
});

test('source worker distribution includes complete parser licenses and checksums', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'source-dist/source-worker-distribution.json')));
  const notices = await readFile(path.join(root, 'source-dist/SOURCE-THIRD-PARTY-NOTICES.txt'));
  assert.equal(createHash('sha256').update(notices).digest('hex'), manifest.noticesChecksum);
  for (const notice of ['cmaps/LICENSE', 'LICENSE_FOXIT', 'LICENSE_LIBERATION']) assert.ok(notices.toString('utf8').includes(notice));
  assert.ok(manifest.assets.some(asset => asset.file === 'pdf-cmaps/Adobe-GB1-UCS2.bcmap'));
  for (const dependency of ['pdfjs-dist', '@thednp/dommatrix', 'parse5']) assert.ok(manifest.packages.some(pkg => pkg.name === dependency && pkg.licenses.length));
});

test('standalone PDF extraction preserves embedded Chinese and English evidence', { timeout: 20000 }, async () => {
  const response = await isolatedRequest(frame('pdf', await pdfFixture(false, '项目验收 evidence 中文来源')));
  assert.equal(response.ok, true); assert.equal(response.data.state, 'ready');
  assert.equal(response.data.chunks.map(chunk => chunk.text).join(''), '项目验收 evidence 中文来源');
});
