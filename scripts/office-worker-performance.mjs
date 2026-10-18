#!/usr/bin/env node
// Cold-process worker measurements only. No build, app launch, or fixture generation.
// Usage: Node24 scripts/office-worker-performance.mjs --output /absolute/baseline-worker.json
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => performance.now();
const marker = 'OFFICE_PERF:';

// A second, explicitly instrumented pass uses this preload, leaving production
// files untouched. The first pass has exactly the production Node arguments.
async function diagnosticPreload() {
  const { registerHooks, syncBuiltinESMExports } = await import('node:module');
  const cp = (await import('node:child_process')).default;
  const clock = () => performance.now();
  const stringify = JSON.stringify;
  const report = { json: {}, base64: {}, sidecarRequests: [], memory: {}, engineInspectMs: null, engineImportMs: null };
  const pending = new Map();
  let phase = 'beforeInspect';
  let importStarted;
  function add(group, key, ms, bytes) {
    const row = group[key] ??= { calls: 0, ms: 0, bytes: 0 };
    row.calls++; row.ms += ms; row.bytes += bytes;
  }
  const parse = JSON.parse;
  JSON.parse = function (...args) {
    const start = clock(); const value = Reflect.apply(parse, this, args); const ms = clock() - start;
    const kind = value?.method === 'office.inspect' ? 'workerRequestParse' : 'otherParse';
    add(report.json, kind, ms, Buffer.byteLength(args[0]));
    if (value?.requestId && pending.has(value.requestId)) {
      const request = pending.get(value.requestId);
      report.sidecarRequests.push({ ...request, roundTripMs: clock() - request.started });
      pending.delete(value.requestId);
    }
    return value;
  };
  JSON.stringify = function (...args) {
    const start = clock(); const value = Reflect.apply(stringify, this, args); const ms = clock() - start;
    const input = args[0];
    const kind = typeof input?.ok === 'boolean' && input?.requestId ? 'workerResponseStringify' : 'otherStringify';
    add(report.json, kind, ms, value === undefined ? 0 : Buffer.byteLength(value));
    if (input?.version === 1 && input?.command) pending.set(input.requestId, { command: input.command, started: clock() });
    return value;
  };
  const from = Buffer.from;
  Buffer.from = function (...args) {
    const start = clock(); const value = Reflect.apply(from, this, args);
    if (args[1] === 'base64') add(report.base64, `${phase}:decode`, clock() - start, value.length);
    return value;
  };
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function (...args) {
    const start = clock(); const value = Reflect.apply(toString, this, args);
    if (args[0] === 'base64') add(report.base64, `${phase}:encode`, clock() - start, value.length);
    return value;
  };
  const originalSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    process.stderr.write('OFFICE_PERF:' + stringify({ sidecarPid: child.pid }) + '\n');
    return child;
  };
  syncBuiltinESMExports();
  globalThis.__officePerformanceInspect = async (inspect, args) => {
    report.engineImportMs = clock() - importStarted;
    report.memory.beforeInspect = process.memoryUsage();
    phase = 'inspect';
    const start = clock();
    try { return await inspect(...args); }
    finally {
      report.engineInspectMs = clock() - start;
      report.memory.afterInspect = process.memoryUsage();
      phase = 'afterInspect';
    }
  };
  registerHooks({ load(url, context, nextLoad) {
    if (/\/(docx|pptx|xlsx)-engine\.mjs$/.test(url)) {
      importStarted = clock();
      // The query loads the original re-export once without intercepting it again.
      return { format: 'module', shortCircuit: true, source:
        `import * as original from ${stringify(url + '?office-perf-original')};\n`
        + `export * from ${stringify(url + '?office-perf-original')};\n`
        + 'export const inspect = (...args) => globalThis.__officePerformanceInspect(original.inspect,args);\n' };
    }
    return nextLoad(url, context);
  } });
  process.on('exit', () => {
    report.memory.atExit = process.memoryUsage();
    report.resourceUsage = process.resourceUsage(); // maxRSS is KiB, Node process only.
    process.stderr.write('OFFICE_PERF:' + stringify({ diagnostic: report }) + '\n');
  });
}

function summary(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  return { n, median: n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    max: sorted[n - 1], p95: sorted[Math.ceil(n * 0.95) - 1] };
}

async function runWorker({ node, entry, distribution, guard, frame, diagnostic }) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'office-perf-')));
  const args = ['--permission', '--max-old-space-size=1024', `--allow-fs-read=${entry}`,
    `--allow-fs-read=${distribution}`, `--allow-fs-read=${temporary}`, `--allow-fs-write=${temporary}`,
    '--allow-child-process', `--import=${guard}`];
  if (diagnostic) args.push('--import=data:text/javascript,' + encodeURIComponent(`(${diagnosticPreload.toString()})();`));
  args.push(entry);
  const output = [], errors = [], rssSamples = [], sidecarPids = new Set();
  let spawnEventMs, stdinFinishedMs, firstStdoutMs, stdoutEndMs, diagnosticReport;
  let stderrPending = '', sampling = false;
  const started = now();
  const child = spawn(node, args, { cwd: temporary, env: { PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const spawnReturnMs = now() - started;
  // Parent-side RSS sampling does not add imports/hooks to baseline workers.
  // Samples are lower bounds, not exact peaks. ps overhead affects wall timing.
  const sample = () => {
    if (sampling) return;
    sampling = true;
    execFile('/bin/ps', ['-o', 'pid=,rss=', '-p', [child.pid, ...sidecarPids].join(',')], (error, stdout) => {
      sampling = false;
      if (stdout.trim()) rssSamples.push({ atMs: now() - started, processes: stdout.trim().split('\n').map(line => {
        const [pid, rssKiB] = line.trim().split(/\s+/).map(Number);
        return { pid, rssBytes: rssKiB * 1024, role: pid === child.pid ? 'worker' : 'sidecar' };
      }) });
      // ps exits 1 when the short-lived process has already exited.
      if (error && error.code !== 1) errors.push(Buffer.from(`RSS sampling: ${error.message}\n`));
    });
  };
  const timer = setInterval(sample, 20);
  sample();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('spawn', () => { spawnEventMs = now() - started; });
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.stdout.on('data', chunk => { firstStdoutMs ??= now() - started; output.push(chunk); });
      child.stdout.once('end', () => { stdoutEndMs = now() - started; });
      child.stderr.on('data', chunk => {
        errors.push(chunk); stderrPending += chunk.toString();
        let newline;
        while ((newline = stderrPending.indexOf('\n')) >= 0) {
          const line = stderrPending.slice(0, newline); stderrPending = stderrPending.slice(newline + 1);
          if (line.startsWith(marker)) {
            const value = JSON.parse(line.slice(marker.length));
            if (value.sidecarPid) sidecarPids.add(value.sidecarPid);
            if (value.diagnostic) diagnosticReport = value.diagnostic;
          }
        }
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.stdin.end(frame, () => { stdinFinishedMs = now() - started; });
    });
    const closeMs = now() - started;
    assert.equal(status.code, 0, Buffer.concat(errors).toString());
    const mergeStart = now(); const bytes = Buffer.concat(output); const stdoutConcatMs = now() - mergeStart;
    const parseStart = now(); const response = JSON.parse(bytes.toString('utf8')); const responseParseMs = now() - parseStart;
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.data.model.format, JSON.parse(frame).data.format);
    assert.ok(bytes.at(-1) === 10 && bytes.indexOf(10) === bytes.length - 1, 'One bounded JSON line');
    assert.ok(bytes.length <= 180 * 1024 * 1024, 'Production frame budget');
    const model = response.data.model;
    const modelBytes = Buffer.byteLength(JSON.stringify(model));
    const sourceBase64Bytes = typeof model.sourceBase64 === 'string' ? Buffer.byteLength(model.sourceBase64) : 0;
    if (diagnostic) assert.ok(diagnosticReport?.engineInspectMs !== null && diagnosticReport?.engineInspectMs !== undefined, 'Missing inspect probe');
    const workerSamples = rssSamples.flatMap(s => s.processes.filter(p => p.role === 'worker').map(p => p.rssBytes));
    const sidecarSamples = rssSamples.flatMap(s => s.processes.filter(p => p.role === 'sidecar').map(p => p.rssBytes));
    return { pid: child.pid, productionArgs: diagnostic ? args.map(a => a.startsWith('--import=data:') && a !== `--import=${guard}` ? '--import=<diagnostic preload in this script>' : a) : args,
      status, timingsMs: { spawnReturnMs, spawnEventMs, stdinFinishedMs, firstStdoutMs, stdoutEndMs, closeMs,
        stdoutConcatMs, responseParseMs, spawnThroughParsedResponseMs: closeMs + stdoutConcatMs + responseParseMs },
      responseBytes: bytes.length, modelBytes, sourceBase64Bytes, modelWithoutSourceBase64Bytes: modelBytes - (sourceBase64Bytes ? sourceBase64Bytes + Buffer.byteLength('"sourceBase64":"",') : 0),
      memory: { sampledWorkerPeakRssBytes: workerSamples.length ? Math.max(...workerSamples) : null,
        sampledSidecarPeakRssBytes: sidecarSamples.length ? Math.max(...sidecarSamples) : null, rssSamples,
        parent: process.memoryUsage() }, diagnostic: diagnosticReport ?? null,
      stderr: Buffer.concat(errors).toString().split('\n').filter(line => !line.startsWith(marker)).join('\n') };
  } finally {
    clearInterval(timer); clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, node: { type: 'string', default: process.execPath },
    runs: { type: 'string', default: '5' }, manifest: { type: 'string', default: path.join(root, 'scripts/office-worker-performance.fixtures.json') } } });
  assert.ok(values.output, 'Pass --output /absolute/baseline-worker.json');
  assert.ok(path.isAbsolute(values.output), '--output must be absolute');
  const runs = Number(values.runs);
  assert.ok(Number.isSafeInteger(runs) && runs >= 5, '--runs must be at least 5');
  const node = await realpath(values.node);
  const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(nodeVersion, 'v24.21.0', 'Use the production Node runtime');
  const entry = await realpath(path.join(root, 'packages/agent-host/src/office-worker-entry.mjs'));
  const distribution = await realpath(path.join(root, 'packages/agent-host/office-dist'));
  const workerSource = await readFile(path.join(root, 'packages/office-runtime/worker.mjs'));
  assert.deepEqual(await readFile(path.join(distribution, 'worker.mjs')), workerSource, 'Staged worker differs from source');
  const rustSource = await readFile(path.join(root, 'src-tauri/src/office_worker.rs'), 'utf8');
  const guard = rustSource.match(/const NODE_GUARD: &str = "([^"]+)";/)?.[1];
  assert.ok(guard, 'Production Node version guard not found');
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(path.join(root, fixture.path));
    assert.equal(hash(bytes), fixture.sha256, `Fixture changed: ${fixture.path}`);
    fixtures.push({ ...fixture, bytes: bytes.length });
  }
  const largeInventory = [];
  for (const format of ['docx', 'pptx', 'xlsx']) {
    for (const name of await readdir(path.join(root, 'packages/office-validation', format))) {
      if (/large/i.test(name) && name.endsWith(`.${format}`)) largeInventory.push(`${format}/${name}`);
    }
  }
  const stagedManifest = JSON.parse(await readFile(path.join(distribution, 'office-distribution.json'), 'utf8'));
  // Validate and fingerprint staged artifacts once, outside all timed regions.
  for (const file of stagedManifest.files) assert.equal(hash(await readFile(path.join(distribution, file.file))), file.sha256, `Staged artifact mismatch: ${file.file}`);
  const result = { schemaVersion: 1, startedAt: new Date().toISOString(), workPackage: manifest.workPackage,
    scope: 'Cold Node Office worker inspect; excludes Tauri, application open, Rust validation/CAS, renderer import/layout/paint, slot queue and app IPC.',
    methodology: { runsPerFixturePerPass: runs, order: 'All unmodified baselines first, then all diagnostic passes; sequential, round-robin by fixture.',
      cold: 'Fresh OS process and empty private cwd for each request; OS file cache is NOT flushed; no worker warm-up.',
      statistics: 'median; max; p95 nearest rank ceil(0.95*n), so p95=max at n=5; samples are descriptive, not a tail-latency estimate.',
      timings: 'Parent monotonic clock; spawn event is OS child creation, not JS readiness. stdin finish is pipe flush, not worker receipt. close includes process exit. close minus inspect is NOT pure IPC.',
      memory: '20ms parent ps RSS samples (lower bounds, sampler overhead included). Baseline covers Node only. Diagnostic discovers XLSX sidecar PID; sidecar samples can miss short processes. Diagnostic resourceUsage.maxRSS is KiB, Node only, excludes sidecar. No combined-runtime peak is claimed.',
      diagnostic: 'Additional data-URL preload wraps engine re-export using Node registerHooks, JSON and base64 functions, and child spawn. Production entry/worker/engine remain unchanged. Timings are instrumented and not subtracted from baseline.',
      stdout: 'Production payload measured by byte count, not persisted as a large model; raw per-run timing, memory samples, stderr and instrumentation are saved.' },
    environment: { root, node, nodeVersion, platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      entrySha256: hash(await readFile(entry)), workerSha256: hash(workerSource), distributionManifestSha256: hash(await readFile(path.join(distribution, 'office-distribution.json'))),
      distributionFilesVerified: stagedManifest.files.length }, fixtures, largeInventory,
    evidence: manifest.evidence, records: [], summaries: [] };
  await mkdir(path.dirname(values.output), { recursive: true });
  const save = () => writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  await save();
  for (const pass of ['baseline', 'diagnostic']) {
    for (let iteration = 1; iteration <= runs; iteration++) {
      for (const fixture of fixtures) {
        const readStart = now(); const bytes = await readFile(path.join(root, fixture.path)); const sourceReadMs = now() - readStart;
        const encodeStart = now(); const base64 = bytes.toString('base64'); const sourceBase64EncodeMs = now() - encodeStart;
        const requestId = `${pass}-${fixture.id}-${iteration}`;
        const frameStart = now();
        const frame = Buffer.from(JSON.stringify({ requestId, method: 'office.inspect', data: { format: fixture.format, base64 } }) + '\n');
        const requestSerializeMs = now() - frameStart;
        const record = await runWorker({ node, entry, distribution, guard, frame, diagnostic: pass === 'diagnostic' });
        result.records.push({ pass, fixture: fixture.id, iteration, sourceBytes: bytes.length, base64Bytes: Buffer.byteLength(base64), requestBytes: frame.length,
          parentPreparationMs: { sourceReadMs, sourceBase64EncodeMs, requestSerializeMs }, ...record });
        await save();
        process.stderr.write(`${pass} ${fixture.id} ${iteration}/${runs}: ${record.timingsMs.closeMs.toFixed(1)}ms${record.diagnostic ? ` inspect=${record.diagnostic.engineInspectMs.toFixed(1)}ms` : ''}\n`);
      }
    }
  }
  for (const pass of ['baseline', 'diagnostic']) for (const fixture of fixtures) {
    const records = result.records.filter(r => r.pass === pass && r.fixture === fixture.id);
    const metrics = {};
    for (const key of Object.keys(records[0].timingsMs)) metrics[key] = summary(records.map(r => r.timingsMs[key]));
    for (const key of ['responseBytes', 'modelBytes', 'sourceBase64Bytes', 'modelWithoutSourceBase64Bytes']) metrics[key] = summary(records.map(r => r[key]));
    for (const key of ['sourceReadMs', 'sourceBase64EncodeMs', 'requestSerializeMs']) metrics[key] = summary(records.map(r => r.parentPreparationMs[key]));
    for (const key of ['sampledWorkerPeakRssBytes', 'sampledSidecarPeakRssBytes']) {
      const samples = records.map(r => r.memory[key]).filter(v => v !== null);
      if (samples.length) metrics[key] = summary(samples);
    }
    if (pass === 'diagnostic') {
      for (const key of ['engineImportMs', 'engineInspectMs']) metrics[key] = summary(records.map(r => r.diagnostic[key]));
      metrics.workerMaxRssBytes = summary(records.map(r => r.diagnostic.resourceUsage.maxRSS * 1024));
      for (const group of ['json', 'base64']) {
        for (const key of new Set(records.flatMap(r => Object.keys(r.diagnostic[group])))) {
          for (const unit of ['calls', 'ms', 'bytes']) metrics[`${group}.${key}.${unit}`] = summary(records.map(r => r.diagnostic[group][key]?.[unit] ?? 0));
        }
      }
      const commands = new Set(records.flatMap(r => r.diagnostic.sidecarRequests.map(q => q.command)));
      for (const command of commands) {
        metrics[`sidecar.${command}.totalMsPerRun`] = summary(records.map(r => r.diagnostic.sidecarRequests.filter(q => q.command === command).reduce((n, q) => n + q.roundTripMs, 0)));
        metrics[`sidecar.${command}.callsPerRun`] = summary(records.map(r => r.diagnostic.sidecarRequests.filter(q => q.command === command).length));
      }
    }
    result.summaries.push({ pass, fixture: fixture.id, metrics });
  }
  result.finishedAt = new Date().toISOString();
  await save();
  process.stdout.write(`${values.output}\n`);
}

await main();
