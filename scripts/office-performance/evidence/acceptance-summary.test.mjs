// Historical report/sidecar extraction only; no native commands or measurements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarizeAcceptance } from './acceptance-summary.mjs';

const name = 'xlsx-complex-1';
const report = (attempt, status = 'error') => ({
  runner: { attempt }, scope: 'native shell', status,
  ...(status === 'error' ? { error: `attempt ${attempt}: continuity painted=false\noriginal stack`, errors: [`original error ${attempt}`] } : {}),
  config: { format: 'xlsx', sample: 'complex', run: 1, cycles: 1 },
  measurements: [{ kind: 'acceptance', name: 'acceptance_navigation_zoom_and_mode', status,
    ...(status === 'error' ? { error: `original row failure ${attempt}`, evidence: { samples: [{ painted: false, sameFrame: true }] } } : {}) }],
});
const memory = rssKiB => ({ samples: [1, 2].map((n, i) => ({ atMs: n * 100,
  checkpoint: `cycle_1_${i ? 'target' : 'other'}`, processes: [{ pid: 12, rssKiB: rssKiB + i, command: '/system/WebContent', attribution: 'new-WebKit-candidate' }] })) });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'run'));
  return { write: (file, value) => writeFile(join(root, 'run', file), typeof value === 'string' ? value : JSON.stringify(value)),
    read: () => summarizeAcceptance(root, 'run') };
}

test('all HMR attempts retain original failure status/errors and reference the same unpartitioned memory', async t => {
  const f = await fixture(t), input = memory(1024);
  await f.write(`${name}.json`, report(1));
  await f.write(`${name}-attempt-2.json`, report(2));
  await f.write(`${name}-attempt-3.json`, report(3, 'passed'));
  await f.write(`${name}-memory.json`, input);
  await f.write(`${name}.log`, 'ignored');
  const { reports } = await f.read(); assert.equal(reports.length, 3);
  for (const attempt of [1, 2, 3]) {
    const actual = reports.find(row => row.attempt === attempt), original = report(attempt, attempt === 3 ? 'passed' : 'error');
    assert.equal(actual.status, original.status);
    assert.deepEqual(actual.errors, original.errors ?? []);
    assert.equal(actual.error, original.error);
    assert.equal(actual.acceptance[0].status, original.status);
    assert.equal(actual.acceptance[0].error, original.measurements[0].error);
    if (attempt !== 3) assert.equal(actual.acceptance[0].evidence.samples.observedViolationCount, 1);
    assert.equal(actual.memory.source, `run/${name}-memory.json`);
    assert.equal(actual.memory.sha256, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    assert.equal(actual.memory.sharedAcrossAttempts, true);
    assert.match(actual.memory.scope, /not attributable to a single attempt/);
    assert.equal(actual.memory.expectedCycleCheckpoints, null);
    assert.equal(actual.memory.missingCycleCheckpointCount, null);
    assert.equal(actual.memory.totalSamples, 2);
    assert.deepEqual(actual.memory.processes[0].cyclePoints.map(p => p.rssKiB), [1024, 1025]);
  }
});

test('filename identifies attempt-2 when runner metadata is absent, including without the first report', async t => {
  const f = await fixture(t), input = report(2); delete input.runner;
  await f.write(`${name}-attempt-2.json`, input); await f.write(`${name}-memory.json`, memory(20));
  const [actual] = (await f.read()).reports;
  assert.equal(actual.attempt, 2); assert.equal(actual.status, 'error');
  assert.equal(actual.memory.sharedAcrossAttempts, true);
  assert.equal(actual.memory.source, `run/${name}-memory.json`);
});

test('an actual attempt-specific sidecar takes precedence and a single report stays unshared', async t => {
  const f = await fixture(t);
  await f.write(`${name}.json`, report(1)); await f.write(`${name}-memory.json`, memory(10));
  let [actual] = (await f.read()).reports;
  assert.equal(actual.memory.sharedAcrossAttempts, false); assert.equal(actual.memory.expectedCycleCheckpoints, 2);
  await f.write(`${name}-attempt-2.json`, report(2)); await f.write(`${name}-attempt-2-memory.json`, memory(80));
  actual = (await f.read()).reports.find(row => row.attempt === 2);
  assert.equal(actual.memory.source, `run/${name}-attempt-2-memory.json`);
  assert.equal(actual.memory.sharedAcrossAttempts, false);
  assert.equal(actual.memory.expectedCycleCheckpoints, 2);
  assert.equal(actual.memory.processes[0].overall.first.rssKiB, 80);
});

test('missing shared sidecar stays unavailable without inventing memory or losing failure', async t => {
  const f = await fixture(t); await f.write(`${name}-attempt-2.json`, report(2));
  const [actual] = (await f.read()).reports;
  assert.equal(actual.status, 'error'); assert.equal(actual.memory.source, null);
  assert.equal(actual.memory.sha256, null); assert.equal(actual.memory.sharedAcrossAttempts, null);
  assert.match(actual.memory.status, /missing sidecar/); assert.equal(actual.memory.processes, undefined);
});

test('corrupt attempt-specific or shared sidecar is an error, never a silent fallback', async t => {
  const f = await fixture(t); await f.write(`${name}-attempt-2.json`, report(2));
  await f.write(`${name}-memory.json`, '{broken'); await assert.rejects(f.read(), SyntaxError);
  await f.write(`${name}-memory.json`, memory(10)); await f.write(`${name}-attempt-2-memory.json`, '{broken');
  await assert.rejects(f.read(), SyntaxError);
});
