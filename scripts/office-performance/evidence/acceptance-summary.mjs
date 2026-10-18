#!/usr/bin/env node
/** Read existing native acceptance reports and memory sidecars; stdout only.
 * OFFICE_PERF_EVIDENCE=/existing/root node acceptance-summary.mjs \
 *   native-acceptance-release-docx [native-acceptance-release-pptx ...]
 * No app, browser, build, measurement, or writes are performed by this script.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tally = rows => Object.fromEntries([...new Set(rows)].map(status => [status, rows.filter(value => value === status).length]));
const checkpointName = sample => typeof sample.checkpoint === 'string' ? sample.checkpoint : sample.checkpoint?.name ?? null;
const isCycle = sample => /^cycle_\d+_(other|target)$/.test(checkpointName(sample) ?? '');
const endpoint = point => point ? { atMs: point.atMs, checkpoint: point.checkpoint, rssKiB: point.rssKiB, rssMiB: point.rssKiB / 1024 } : null;
function trajectory(points) {
  if (!points.length) return { count: 0, first: null, last: null, peak: null };
  const first = points[0], last = points.at(-1);
  const changes = points.slice(1).map((point, index) => point.rssKiB - points[index].rssKiB);
  return { count: points.length, first: endpoint(first), last: endpoint(last),
    minKiB: Math.min(...points.map(point => point.rssKiB)), maxKiB: Math.max(...points.map(point => point.rssKiB)),
    peak: endpoint(points.reduce((a, b) => b.rssKiB > a.rssKiB ? b : a)),
    deltaKiB: last.rssKiB - first.rssKiB, deltaMiB: (last.rssKiB - first.rssKiB) / 1024,
    increases: changes.filter(value => value > 0).length, decreases: changes.filter(value => value < 0).length,
    unchanged: changes.filter(value => value === 0).length,
    strictlyIncreasingAtEveryObservedStep: changes.length > 0 && changes.every(value => value > 0) };
}
export function summarizeMemory(memory, expectedCycleCount) {
  if (!memory) return { status: 'missing sidecar; no RSS inference' };
  const samples = memory.samples ?? [], cycles = samples.filter(isCycle);
  const processes = new Map();
  for (const sample of samples) for (const process of sample.processes ?? []) {
    if (!Number.isFinite(process.rssKiB) || !Number.isFinite(sample.atMs)) continue;
    if (!processes.has(process.pid)) processes.set(process.pid, { pid: process.pid,
      process: basename(process.command ?? ''), attribution: process.attribution ?? null, points: [] });
    processes.get(process.pid).points.push({ atMs: sample.atMs, checkpoint: checkpointName(sample), rssKiB: process.rssKiB, cycle: isCycle(sample) });
  }
  const finalCycleTime = cycles.at(-1)?.atMs;
  return { status: 'observed RSS only', note: memory.note ?? null, totalSamples: samples.length,
    expectedCycleCheckpoints: expectedCycleCount, observedCycleCheckpoints: cycles.length,
    missingCycleCheckpointCount: expectedCycleCount === null ? null : Math.max(0, expectedCycleCount - cycles.length),
    duplicateCycleCheckpoints: Object.entries(tally(cycles.map(checkpointName))).filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
    postCycleCheckpoints: samples.filter(sample => !isCycle(sample) && typeof sample.checkpoint === 'object' && sample.atMs > finalCycleTime)
      .map(sample => ({ atMs: sample.atMs, name: checkpointName(sample), evidence: sample.checkpoint.evidence })),
    processes: [...processes.values()].map(({ points, ...process }) => {
      points.sort((a, b) => a.atMs - b.atMs);
      const cyclePoints = points.filter(point => point.cycle), tailCycles = cyclePoints.slice(-5);
      return { ...process, overall: trajectory(points), cycles: trajectory(cyclePoints), cyclePoints: cyclePoints.map(endpoint),
        finalFiveCyclePoints: trajectory(tailCycles),
        cyclePlateau: cyclePoints.length < 2 ? 'not assessable: insufficient checkpoints'
          : tailCycles.slice(1).every((point, index) => point.rssKiB > tailCycles[index].rssKiB)
            ? 'not observed: every final-five cycle step increased'
            : tailCycles.every(point => point.rssKiB === tailCycles[0].rssKiB)
              ? 'identical RSS in final-five observed checkpoints only'
              : 'mixed changes: no plateau inferred; inspect retained cycle points',
        postCycles: trajectory(points.filter(point => finalCycleTime !== undefined && point.atMs > finalCycleTime)),
        final60Seconds: trajectory(points.filter(point => point.atMs >= points.at(-1).atMs - 60000)) };
    }),
    interpretation: 'Each PID is separate; WebKit candidate attribution is not guaranteed. RSS is not retained heap. A rise/fall or finite flat interval does not establish a leak or its absence. Post-cycle UI activity/holding is not a controlled idle/GC experiment.' };
}
function compactEvidence(value, key = '') {
  if (['resources', 'pixelChecks', 'geometry', 'chain', 'documents', 'textSample'].includes(key)) return undefined;
  if (key === 'samples' && Array.isArray(value)) return { count: value.length,
    observedViolationCount: value.filter(row => row.sameFrame === false || row.sameSurface === false || row.present === false || row.painted === false).length };
  if (Array.isArray(value)) return value.map(item => compactEvidence(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => {
    const result = compactEvidence(item, name); return result === undefined ? [] : [[name, result]];
  }));
  return value;
}
export async function summarizeAcceptance(root, directory) {
  const location = resolve(root, directory), rel = relative(root, location);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Input directory must be inside OFFICE_PERF_EVIDENCE');
  const files = (await readdir(location)).filter(file => /^(docx|pptx|xlsx|md)-.+-\d+\.json$/.test(file)).sort();
  const firstReportName = file => file.replace(/-attempt-\d+(?=\.json$)/, '');
  const reports = [];
  for (const file of files) {
    const bytes = await readFile(resolve(location, file)), report = JSON.parse(bytes);
    const filenameAttempt = Number(file.match(/-attempt-(\d+)\.json$/)?.[1] ?? 1);
    const attempt = report.runner?.attempt ?? filenameAttempt;
    const first = firstReportName(file), sharedMemoryName = first.replace(/\.json$/, '-memory.json');
    let memoryName = file.replace(/\.json$/, '-memory.json'), memoryBytes, memory;
    try { memoryBytes = await readFile(resolve(location, memoryName)); memory = JSON.parse(memoryBytes); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (attempt > 1 && memoryName !== sharedMemoryName) {
        memoryName = sharedMemoryName;
        try { memoryBytes = await readFile(resolve(location, memoryName)); memory = JSON.parse(memoryBytes); }
        catch (sharedError) { if (sharedError.code !== 'ENOENT') throw sharedError; }
      }
    }
    const sharedAcrossAttempts = memory ? memoryName === sharedMemoryName &&
      (filenameAttempt > 1 || files.some(other => other !== file && firstReportName(other) === first)) : null;
    const measurements = report.measurements ?? [], acceptance = measurements.filter(row => row.kind === 'acceptance');
    const cycles = measurements.filter(row => /^cycle_\d+_(other|target)$/.test(row.name));
    const record = row => ({ name: row.name, kind: row.kind, duration: row.duration, status: row.status,
      ...(row.error ? { error: row.error } : {}), ...(row.evidence ? { evidence: compactEvidence(row.evidence) } : {}) });
    reports.push({ source: `${rel}/${file}`, sha256: hash(bytes), scope: report.scope ?? null, attempt,
      formal: false, qualification: 'Functional acceptance run; never pooled into formal performance statistics by this script',
      status: report.status, errors: report.errors ?? [], ...(report.error === undefined ? {} : { error: report.error }),
      configuration: Object.fromEntries(['format', 'sample', 'run', 'acceptance', 'races', 'cycles', 'width', 'visible'].map(key => [key, report.config?.[key] ?? null])),
      coldOpen: measurements.find(row => row.name === 'cold_open') ? record(measurements.find(row => row.name === 'cold_open')) : null,
      acceptance: acceptance.map(record), acceptanceStatusCounts: tally(acceptance.map(row => row.status)),
      cycleMeasurements: cycles.map(({ name, duration, status, file }) => ({ name, duration, status, file })), cycleStatusCounts: tally(cycles.map(row => row.status)),
      memory: { source: memory ? `${rel}/${memoryName}` : null, sha256: memoryBytes ? hash(memoryBytes) : null,
        sharedAcrossAttempts,
        scope: memory ? sharedAcrossAttempts ? 'shared runner process across attempts; not attributable to a single attempt' : 'report-specific sidecar as recorded' : 'unavailable',
        ...summarizeMemory(memory, sharedAcrossAttempts ? null : (report.config?.cycles ?? 0) * 2) } });
  }
  return { directory: rel, reports };
}
async function main() {
  const root = process.env.OFFICE_PERF_EVIDENCE;
  if (!root || !isAbsolute(root)) throw Error('Set absolute OFFICE_PERF_EVIDENCE');
  const directories = process.argv.slice(2);
  if (!directories.length) throw Error('Supply one or more existing acceptance directories relative to OFFICE_PERF_EVIDENCE');
  const results = [];
  for (const directory of directories) results.push(await summarizeAcceptance(root, directory));
  const output = { schemaVersion: 1, evidenceRoot: '$OFFICE_PERF_EVIDENCE', results };
  const json = JSON.stringify(output, (_key, value) => typeof value === 'string' ? value.replaceAll(root, '$OFFICE_PERF_EVIDENCE') : value, 2);
  process.stdout.write(json + '\n');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch(error => { console.error(`acceptance-summary: ${error.message}`); process.exitCode = 1; });
