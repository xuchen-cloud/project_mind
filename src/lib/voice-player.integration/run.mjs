import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';

// Explicit Node entrypoint, outside Vitest's *.test discovery. No app/Vite dev
// server, cargo rebuild, lockfile or other package changes are needed.
const root = resolve(import.meta.dirname, '../../..');
const deps = resolve(process.env.VOICE_TAURI_DEPS ?? join(root, 'src-tauri/target/debug/deps'));
const fingerprint = resolve(deps, '../.fingerprint');
const output = resolve(process.env.VOICE_RANGE_OUTPUT ?? join(root, 'output/playwright/voice-range'));
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'mind-voice-range-'));
const metrics = { scope: 'real headless WebKit + unmodified Tauri asset get_response over test HTTP transport; excludes WKURLSchemeHandler/IPC/device audio', startedAt: new Date().toISOString(), native: {}, assets: [], browser: null, probes: null };
let native, browser;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function execute(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}\n${stderr}`))); });
  return stdout;
}
async function artifact(name, required = [], expectedFingerprint) {
  const rows = [];
  for (const directory of await readdir(fingerprint)) {
    if (![name, name.replaceAll('_', '-')].some(prefix => directory.startsWith(`${prefix}-`))) continue;
    const hash = directory.slice(directory.lastIndexOf('-') + 1), lib = join(deps, `lib${name}-${hash}.rlib`);
    try {
      const data = JSON.parse(await readFile(join(fingerprint, directory, `lib-${name}.json`), 'utf8'));
      if (expectedFingerprint) {
        const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(expectedFingerprint));
        if ((await readFile(join(fingerprint, directory, `lib-${name}`), 'utf8')).trim() !== bytes.toString('hex')) continue;
      }
      if (!required.every(feature => JSON.parse(data.features).includes(feature))) continue;
      rows.push({ lib, modified: (await stat(lib)).mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(rows.length, `Missing cached ${name} ${required}; use the existing native test build, this harness does not rebuild it`);
  return rows.sort((a, b) => b.modified - a.modified)[0].lib;
}
async function wav(name, seconds, frequency, regions = [[0, seconds]]) {
  const sampleRate = 48_000, dataBytes = seconds * sampleRate * 4;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const file = join(temp, '.project-mind/voice', name), handle = await open(file, 'w');
  const second = Buffer.alloc(sampleRate * 4);
  for (let sample = 0; sample < sampleRate; sample++) second.writeFloatLE(0.08 * Math.sin(2 * Math.PI * frequency * sample / sampleRate), sample * 4);
  try {
    await handle.truncate(44 + dataBytes); await handle.write(header, 0, 44, 0);
    // Sparse unvisited regions are valid silence, avoiding gigabytes of fixtures.
    for (const [start, end] of regions) for (let at = start; at < end; at++) await handle.write(second, 0, second.length, 44 + at * second.length);
  } finally { await handle.close(); }
  return { path: file, bytes: dataBytes + 44, seconds };
}
try {
  const tauri = await artifact('tauri', ['test', 'protocol-asset', 'webview-data-url']);
  const depfile = await readFile(tauri.replace('/libtauri-', '/tauri-').replace('.rlib', '.d'), 'utf8');
  const tauriRoot = depfile.match(/(\/[^\s:]+\/tauri-\d+\.\d+\.\d+)\/src\/lib.rs/)[1];
  const assetSource = join(tauriRoot, 'src/protocol/asset.rs');
  const asyncSource = await readFile(join(tauriRoot, 'src/async_runtime.rs'), 'utf8');
  const safeFunction = asyncSource.slice(asyncSource.indexOf('pub(crate) fn safe_block_on'), asyncSource.indexOf('\n#[cfg(test)]', asyncSource.indexOf('pub(crate) fn safe_block_on')));
  const safePath = join(temp, 'safe-block-on.rs'); await writeFile(safePath, safeFunction);
  const tauriFingerprint = tauri.slice(tauri.lastIndexOf('libtauri-') + 3, -5);
  const metadata = JSON.parse(await readFile(join(fingerprint, tauriFingerprint, 'lib-tauri.json'), 'utf8'), (_key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) ? BigInt(context.source) : value);
  metrics.native = { tauriRoot, assetSource, sha256: sha(await readFile(assetSource)), safeBlockOnSha256: sha(safeFunction), tauriArtifact: tauri, dependencyArtifacts: {} };
  const args = ['--edition=2021', join(import.meta.dirname, 'asset-server.rs'), '-o', join(temp, 'asset-server'), '-L', `dependency=${deps}`, '--extern', `tauri=${tauri}`];
  for (const name of ['http', 'http_range', 'tokio', 'tauri_utils', 'percent_encoding', 'log', 'mime', 'anyhow', 'getrandom', 'serde_json']) {
    const features = name === 'tokio' ? ['fs', 'io-util', 'rt'] : [];
    const lib = await artifact(name, features, metadata.deps.find(dep => dep[1] === name)?.[3]); metrics.native.dependencyArtifacts[name] = lib; args.push('--extern', `${name}=${lib}`);
  }
  const builds = resolve(deps, '../build');
  for (const name of await readdir(builds)) { const out = join(builds, name, 'out'); try { if ((await stat(out)).isDirectory()) args.push('-L', `native=${out}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  await execute('rustc', args, { env: { ...process.env, VOICE_TAURI_ASSET_SOURCE: assetSource, VOICE_TAURI_SAFE_BLOCK_ON: safePath } });
  await mkdir(join(temp, '.project-mind/voice'), { recursive: true });
  const files = {};
  for (const [name, seconds, hz, regions] of [
    ['legacy-mic.wav', 3600, 220, [[0, 120], [3000, 3120]]], ['legacy-system.wav', 3600, 330, [[0, 120], [3000, 3120]]],
    ['mic-0.wav', 2, 220], ['system-0.wav', 2, 330], ['mic-1.wav', 2, 220], ['system-1.wav', 2, 330],
  ]) files[name] = await wav(name, seconds, hz, regions);
  await writeFile(join(temp, 'private.txt'), 'not authorized');
  const source = await readFile(join(root, 'src/lib/voice-player.ts'), 'utf8');
  metrics.playerSha256 = sha(source);
  await writeFile(join(temp, 'voice-player.js'), (await transformWithOxc(source, 'voice-player.ts', { target: 'es2022' })).code);
  await writeFile(join(temp, 'browser.mjs'), await readFile(join(import.meta.dirname, 'browser.mjs')));
  await writeFile(join(temp, 'index.html'), '<!doctype html><button id="play">Play silently</button><script type="module" src="/browser.mjs"></script>');
  native = spawn(join(temp, 'asset-server'), [temp], { stdio: ['ignore', 'pipe', 'pipe'] });
  let nativeErrors = ''; native.stderr.on('data', data => { nativeErrors += data; });
  const url = await new Promise((accept, reject) => {
    const lines = createInterface({ input: native.stdout });
    lines.on('line', line => { const row = JSON.parse(line); if (row.kind === 'ready') accept(row.url); else metrics.assets.push(row); });
    native.on('error', reject); native.on('exit', code => { if (code) reject(new Error(`asset server exited ${code}: ${nativeErrors}`)); });
  });
  const playwright = await import(pathToFileURL(resolve(process.env.VOICE_PLAYWRIGHT_MODULE ?? join(root, 'packages/office-xlsx/node_modules/@playwright/test/index.mjs'))).href);
  browser = await playwright.webkit.launch({ headless: true });
  metrics.browser = { engine: 'webkit', version: browser.version() };
  const page = await browser.newPage(); page.setDefaultTimeout(30_000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url); await page.waitForFunction(() => !!window.voiceIntegration);
  metrics.probes = await page.evaluate(async ({ files, privatePath }) => window.voiceIntegration.prepare(files, privatePath), { files, privatePath: join(temp, 'private.txt') });
  await page.click('#play');
  await page.waitForFunction(() => window.voiceIntegration.playFinished, null, { timeout: 30_000 });
  metrics.play = await page.evaluate(() => window.voiceIntegration.playFinished);
  assert.equal(metrics.play.status, 'passed', JSON.stringify(metrics.play));
  assert.deepEqual(errors, []);
  assert.ok(metrics.assets.filter(row => row.status === 206).every(row => row.bytes <= 1000 * 1024));
  metrics.status = 'passed';
  console.log(JSON.stringify({ status: metrics.status, browser: metrics.browser, probes: metrics.probes, play: metrics.play }, null, 2));
} catch (error) { metrics.status = 'failed'; metrics.error = error.stack ?? String(error); throw error; }
finally {
  metrics.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'result.json'), JSON.stringify(metrics, null, 2));
  if (browser) await browser.close();
  if (native && native.exitCode === null) { native.kill('SIGTERM'); await new Promise(resolve => native.once('exit', resolve)); }
  await rm(temp, { recursive: true, force: true });
}
