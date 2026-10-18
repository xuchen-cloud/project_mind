#!/usr/bin/env node
/** Read-only native report summarizer. No app/process launches or measurements.
 * Usage: node scripts/office-performance/summarize-native.mjs \
 *   --input=baseline:/absolute/directory --input=after:/absolute/directory \
 *   [--metadata=/absolute/context.json] [--output=/absolute/summary.json]
 * --baseline=DIR and --after=DIR are aliases. Repeating a label pools its runs.
 * Metadata JSON is retained verbatim (e.g. machine/cache/build facts per label);
 * absent facts are not inferred from this summarizer's machine or environment.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ms = value => finiteMs(value) ? value : null;
const array = value => Array.isArray(value) ? value : [];
const omit = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const errorPresent = value => value !== undefined && value !== null && value !== '' && value !== false;

export function statistics(values) {
  const rawms = values.map(ms), sorted = rawms.filter(value => value !== null).sort((a, b) => a - b);
  const n = sorted.length, middle = Math.floor(n / 2);
  return { n, rawms, median: n ? n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    max: n ? sorted[n - 1] : null, p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null };
}

function statusOf(record, command = false) {
  if (errorPresent(record.error) || ['error', 'failed'].includes(record.status)) return 'failed';
  if (record.status === 'skipped') return 'skipped';
  if (!finiteMs(record.duration)) return 'unknown';
  if (record.status === 'over_budget' || record.withinBudget === false ||
      (finiteMs(record.budgetMs) && record.duration > record.budgetMs)) return 'over_budget';
  if (record.status === 'passed') return 'passed';
  // native-page records duration in finally and error on rejection/ok:false.
  // This is command completion evidence, not a performance-budget pass.
  return command && record.status === undefined ? 'completed' : 'unknown';
}

function combined(statuses) {
  if (!statuses.length) return 'unknown';
  for (const status of ['failed', 'over_budget', 'unknown']) if (statuses.includes(status)) return status;
  return statuses.every(status => status === statuses[0]) ? statuses[0] : 'unknown';
}

function grouped(records, keys) {
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify(keys.map(name => record[name]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map(rows => ({ ...Object.fromEntries(keys.map(key => [key, rows[0][key]])),
    ...statistics(rows.map(row => row.duration)), status: combined(rows.map(row => row.status)),
    counts: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
    records: rows.map(row => omit(row, [...keys, 'duration'])) }));
}

const stampNames = ['read', 'worker-slot', 'worker-spawn', 'worker-response', 'worker-decode', 'worker-complete', 'revalidated'];
export function parseWorkerLog(text) {
  const requests = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\[office-performance\]\s+(\S+)\s+(read|worker-slot|worker-spawn|worker-response|worker-decode|worker-complete|revalidated)\s+(\S+)/);
    if (!match) continue;
    const [, requestId, stage, raw] = match;
    if (!requests.has(requestId)) requests.set(requestId, { requestId, stamps: {}, issues: [] });
    const request = requests.get(requestId);
    if (Object.hasOwn(request.stamps, stage)) {
      request.stamps[stage] = null;
      request.issues.push(`duplicate ${stage} stamp; ambiguous value discarded`);
    } else {
      request.stamps[stage] = ms(Number(raw));
      if (request.stamps[stage] === null) request.issues.push(`invalid ${stage} stamp`);
    }
  }
  return [...requests.values()].map(({ requestId, stamps, issues }) => {
    const diff = (end, start) => {
      if (!finiteMs(stamps[end]) || (start && !finiteMs(stamps[start]))) return null;
      const value = stamps[end] - (start ? stamps[start] : 0);
      if (value < 0) { issues.push(`nonmonotonic ${start ?? 'origin'} -> ${end}`); return null; }
      return value;
    };
    const outer = { readMs: diff('read'), workerAwaitMs: diff('worker-complete', 'read'),
      revalidationMs: diff('revalidated', 'worker-complete'), totalMs: ms(stamps.revalidated) };
    const worker = { preparationAndSlotMs: diff('worker-slot'), temporarySetupAndSpawnMs: diff('worker-spawn', 'worker-slot'),
      sendReceiveAndExecutionMs: diff('worker-response', 'worker-spawn'),
      exitWaitAndDecodeMs: diff('worker-decode', 'worker-response'), totalMs: ms(stamps['worker-decode']) };
    const missing = stampNames.filter(name => !finiteMs(stamps[name]));
    return { requestId, status: issues.length || missing.length ? 'unknown' : 'complete',
      cumulativeMs: Object.fromEntries(stampNames.map(name => [name, ms(stamps[name])])),
      phases: { outer, worker }, missing, issues };
  });
}

const commandKind = name => ['file_versions_list', 'file_versions_get'].includes(name) ? 'version' : name === 'file_office_inspect' ? 'inspect' :
  name === 'file_office_recalculate' ? 'recalc' : null;
const identity = (report, file) => {
  const config = report.config ?? report.runner?.config ?? {};
  const match = basename(file).match(/^(docx|pptx|xlsx|md)-(.+)-(\d+)\.json$/);
  return { format: config.format ?? match?.[1] ?? null, sample: config.sample ?? match?.[2] ?? null,
    run: config.run ?? (match ? Number(match[3]) : null) };
};
const isMatrix = value => Array.isArray(value?.samples) && (!value.samples.length || value.samples.some(sample => typeof sample?.file === 'string'));
const isStartup = value => value && (Object.hasOwn(value, 'durationFromNavigation') || value.scope === 'full application landing' ||
  value.config?.page === 'startup' || value.runner?.config?.page === 'startup');
const isRun = (value, file) => value && (isStartup(value) || Array.isArray(value.measurements) ||
  (value.status !== undefined && identity(value, file).format !== null));
function scenarioRecords(report, format) {
  const records = [...array(report.measurements)];
  if (isStartup(report) || report.status === 'skipped' || report.status === 'setup') return records;
  const expected = ['cold_open', 'first_other_file', 'close_reopen', 'switch_file',
    ...(format === 'md' ? ['rich_to_source', 'source_to_rich'] : ['preview_to_edit'])];
  const config = report.config ?? report.runner?.config;
  for (let cycle = 1; cycle <= (config?.cycles ?? 0); cycle++) expected.push(`cycle_${cycle}_other`, `cycle_${cycle}_target`);
  for (const name of expected) if (!records.some(record => record.name === name))
    records.push({ name, duration: null, status: 'unknown', reason: 'missing native scenario measurement' });
  return records;
}
const reportMetadata = report => omit(report, ['measurements', 'commands', 'resources', 'commits', 'errors', 'error',
  'status', 'samples', 'evidence', 'diagnostics', 'durationFromNavigation', 'observerDuration', 'shell_ready', 'nav']);

async function optionalFile(file, issues, json = true) {
  try { const text = await readFile(file, 'utf8'); return json ? JSON.parse(text) : text; }
  catch (error) { issues.push({ source: file, issue: error.code === 'ENOENT' ? 'missing file' : String(error.message) }); return null; }
}

function summarizeMemory(document) {
  if (!document || !Array.isArray(document.samples)) return { status: 'unknown', samples: null, peakPerPid: null };
  const samples = document.samples.map(sample => ({ atMs: ms(sample.atMs), checkpoint: sample.checkpoint ?? null,
    candidates: array(sample.processes).filter(process => typeof process.attribution === 'string' &&
      process.attribution.startsWith('new-WebKit-candidate')).map(process => ({ pid: process.pid ?? null,
      command: process.command ?? null, rssKiB: ms(process.rssKiB) })) }));
  const processes = new Map();
  let invalid = false;
  for (const sample of samples) for (const process of sample.candidates) {
    if (process.pid === null || process.rssKiB === null) { invalid = true; continue; }
    const prior = processes.get(process.pid);
    if (!prior || process.rssKiB > prior.rssKiB) processes.set(process.pid, process);
  }
  return { status: processes.size && !invalid ? 'observed' : 'unknown', note: document.note ?? null,
    samples, peakPerPid: processes.size ? [...processes.values()] : null };
}

async function summarizeLabel(label, directories) {
  const issues = [], sources = [], measurements = [], commands = [], startupRows = [], workerLogs = [], memory = [];
  const failures = [], overBudget = [], runStatuses = [];
  for (const directory of [...new Set(directories)]) {
    const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile()).map(file => file.name).sort();
    const documents = new Map(), matrixEntries = new Map();
    for (const file of files.filter(file => file.endsWith('.json') && !file.endsWith('-memory.json'))) {
      const document = await optionalFile(join(directory, file), issues);
      if (document !== null) documents.set(file, document);
    }
    for (const [file, document] of documents) if (isMatrix(document)) {
      sources.push({ source: join(directory, file), type: 'matrix', metadata: reportMetadata(document) });
      for (const sample of document.samples) {
        if (typeof sample.file !== 'string' || basename(sample.file) !== sample.file || !sample.file.endsWith('.json')) {
          issues.push({ source: join(directory, file), issue: 'invalid matrix sample filename' }); continue;
        }
        if (matrixEntries.has(sample.file)) issues.push({ source: join(directory, file), issue: `duplicate matrix reference: ${sample.file}` });
        else matrixEntries.set(sample.file, sample);
      }
    }
    const runFiles = new Set([...documents].filter(([file, document]) => !isMatrix(document) && isRun(document, file)).map(([file]) => file));
    for (const file of matrixEntries.keys()) runFiles.add(file);
    // Interrupted native-run writes sidecars even when no result POST succeeds.
    for (const file of files) if (/^(docx|pptx|xlsx|md)-.+-\d+(?:-memory\.json|\.log|\.json)$/.test(file))
      runFiles.add(file.replace(/(?:-memory\.json|\.log)$/, '.json'));
    if (!runFiles.size) issues.push({ source: directory, issue: 'no native run reports or matrix samples' });
    for (const file of [...runFiles].sort()) {
      const source = join(directory, file), index = matrixEntries.get(file);
      const raw = documents.get(file), fallback = !raw && index;
      const report = raw ?? (index ? { ...index, config: identity({}, file) } : { config: identity({}, file), status: 'unknown' });
      if (!raw) issues.push({ source, issue: index ? 'raw report missing; using matrix measurement summary, command/startup details unknown' : 'raw report missing; sidecar only' });
      const id = identity(report, file), context = { source, ...id };
      if (id.format === null || id.sample === null) issues.push({ source, issue: 'format/sample missing; retained as null' });
      sources.push({ source, type: fallback ? 'matrix-fallback' : raw ? 'run' : 'missing-run',
        reportedStatus: report.status ?? null, metadata: reportMetadata(report),
        matrixSample: index ? omit(index, ['measurements']) : null });
      const records = scenarioRecords(report, id.format);
      let runStatus = combined(records.map(record => statusOf(record)));
      if (isStartup(report)) {
        const row = { ...context, scope: report.scope ?? null, duration: ms(report.durationFromNavigation),
          durationFromNavigation: ms(report.durationFromNavigation), observerDuration: ms(report.observerDuration),
          status: statusOf({ ...report, duration: report.durationFromNavigation }), reportedStatus: report.status ?? null,
          error: report.error ?? null, visibility: report.visibility ?? null };
        if (!row.scope) row.status = combined([row.status, 'unknown']);
        startupRows.push(row); runStatus = row.status;
        if (row.status === 'failed') failures.push({ ...row, type: 'startup' });
        if (row.status === 'over_budget') overBudget.push({ ...row, type: 'startup' });
      }
      for (const record of records) {
        const row = { ...context, scenario: record.name ?? null, kind: record.kind ?? 'performance',
          duration: ms(record.duration), status: statusOf(record), reportedStatus: record.status ?? null,
          file: record.file ?? null, budgetMs: ms(record.budgetMs), error: record.error ?? null,
          reason: record.reason ?? null };
        if (row.scenario === null || id.format === null || id.sample === null) row.status = combined([row.status, 'unknown']);
        measurements.push(row);
        if (row.status === 'failed') failures.push({ ...row, type: 'measurement' });
        if (row.status === 'over_budget' || record.status === 'over_budget') overBudget.push({ ...row, type: 'measurement' });
      }
      for (const [commandIndex, command] of array(report.commands).entries()) {
        const kind = commandKind(command.name);
        if (!kind) continue;
        const owners = records.filter(record => Number.isInteger(record.commandOffset) && Number.isInteger(record.commandCount) &&
          commandIndex >= record.commandOffset && commandIndex < record.commandOffset + record.commandCount);
        const row = { ...context, command: kind, name: command.name, index: commandIndex, duration: ms(command.duration),
          startTime: ms(command.startTime), scenario: owners.length === 1 ? owners[0].name ?? null : null,
          requestId: command.requestId ?? null, status: statusOf(command, true), error: command.error ?? null };
        commands.push(row);
        runStatus = combined([runStatus, row.status === 'completed' ? 'passed' : row.status]);
        if (row.status === 'failed') failures.push({ ...row, type: 'command' });
        if (row.status === 'over_budget') overBudget.push({ ...row, type: 'command' });
      }
      if (errorPresent(report.error) || array(report.errors).length || ['error', 'failed'].includes(report.status)) {
        runStatus = 'failed';
        failures.push({ ...context, type: 'run', error: report.error ?? null, errors: report.errors ?? null });
      } else if (report.status === 'over_budget') runStatus = combined([runStatus, 'over_budget']);
      else if (report.status === 'skipped') runStatus = 'skipped';
      else if (report.status !== 'passed') runStatus = 'unknown';
      if (!raw) runStatus = combined([runStatus, 'unknown']);
      runStatuses.push(runStatus);
      if (runStatus === 'over_budget') overBudget.push({ ...context, type: 'run', reportedStatus: report.status ?? null });

      const logFile = source.replace(/\.json$/, '.log');
      const log = await optionalFile(logFile, issues, false);
      const requests = log === null ? null : parseWorkerLog(log).map(request => ({ ...request,
        // Existing reports omit requestId. Never guess joins by array order.
        commandIndices: array(report.commands).flatMap((command, i) => command.requestId === request.requestId ? [i] : []),
      }));
      if (requests?.some(request => request.status === 'unknown')) issues.push({ source: logFile, issue: 'incomplete or invalid worker phase stamps' });
      if (requests?.length === 0 && array(report.commands).some(command => ['inspect', 'recalc'].includes(commandKind(command.name))))
        issues.push({ source: logFile, issue: 'worker commands present but phase stamps missing' });
      workerLogs.push({ ...context, source: logFile, status: requests?.length && requests.every(request => request.status === 'complete') ? 'complete' : 'unknown', requests });
      if (raw && !isStartup(report) && !Array.isArray(report.commands)) issues.push({ source, issue: 'commands missing' });
      const memoryFile = source.replace(/\.json$/, '-memory.json');
      memory.push({ ...context, source: memoryFile, ...summarizeMemory(await optionalFile(memoryFile, issues)) });
    }
  }
  return { label, directories: [...new Set(directories)], status: combined([...runStatuses, ...(issues.length ? ['unknown'] : [])]),
    sources, scenarios: grouped(measurements, ['format', 'sample', 'scenario', 'kind']),
    commands: grouped(commands, ['format', 'sample', 'command']),
    startup: { status: combined(startupRows.map(row => row.status)), groups: grouped(startupRows, ['scope']) },
    workerLogs, memory, failures, over_budget: overBudget, issues };
}

export async function summarize(inputs, metadata = null) {
  const labels = new Map();
  for (const { label, directory } of inputs) {
    if (!label || !isAbsolute(directory)) throw Error('Each input requires a label and absolute directory');
    if (!labels.has(label)) labels.set(label, []);
    labels.get(label).push(resolve(directory));
  }
  if (!labels.size) throw Error('At least one --input, --baseline or --after is required');
  const datasets = [];
  for (const [label, directories] of labels) datasets.push(await summarizeLabel(label, directories));
  return { schemaVersion: 1, metadata, methodology: {
    units: 'milliseconds unless named otherwise; rawms retains nulls; n counts all finite observed durations, including failed elapsed times',
    percentile: 'nearest-rank: sorted[ceil(0.95*n)-1]; median averages the middle pair for even n; empty statistics are null',
    grouping: 'sample is config.sample (run cohort); records.file preserves the actual file used, including first_other_file',
    status: 'passed requires explicit passed plus finite duration; commands without errors and with duration are completed, not budget-passed; missing data is unknown; skipped is not passed',
    matrix: 'raw reports take precedence over matrix summaries; each run file is counted once per directory; matrix fallback leaves run completeness unknown',
    clocks: 'outer: inspect entry -> read -> worker-complete -> revalidated; worker: request entry -> worker-slot -> worker-spawn -> worker-response -> worker-decode; distinct origins',
    phases: 'preparationAndSlot includes validation/base64/frame preparation and slot wait; temporarySetupAndSpawn includes temp setup; sendReceiveAndExecution includes parallel pipe send/receive and engine work; exitWaitAndDecode includes child wait and JSON decode',
    totals: 'outer.workerAwait overlaps the entire worker timeline; cumulative stamps and overlapping/parallel commands are never added; worker inspect is not end-to-end open or full app startup',
    correlation: 'scenario from explicit commandOffset/commandCount only; worker requests joined to commands only by exact requestId; empty commandIndices means unavailable',
    startup: 'scope and durationFromNavigation are kept separate from document open; shell_ready and runner.wallMs are not startup substitutes',
    memory: 'only explicitly marked new-WebKit-candidate RSS in KiB, not heap; ownership is not guaranteed, unrelated WebKit may be included; peakPerPid is sampled peak, never a summed process/application total',
    environment: 'metadata retained verbatim from inputs; no machine/cache/build facts inferred from the summarizer environment',
  }, datasets };
}

async function main(args) {
  const inputs = []; let metadata = null, output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/office-performance/summarize-native.mjs --input=label:/absolute/directory [--input=label:/absolute/directory ...] [--baseline=/absolute/directory] [--after=/absolute/directory] [--metadata=/absolute/context.json] [--output=/absolute/summary.json]');
      return;
    }
    const eq = args[i].indexOf('='), key = eq < 0 ? args[i] : args[i].slice(0, eq);
    const value = eq < 0 ? args[++i] : args[i].slice(eq + 1);
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`);
    if (key === '--input') {
      const colon = value.indexOf(':');
      if (colon < 1) throw Error('--input must be label:/absolute/directory');
      inputs.push({ label: value.slice(0, colon), directory: value.slice(colon + 1) });
    } else if (key === '--baseline' || key === '--after') inputs.push({ label: key.slice(2), directory: value });
    else if (key === '--metadata') metadata = JSON.parse(await readFile(value, 'utf8'));
    else if (key === '--output') output = resolve(value);
    else throw Error(`Unknown option: ${key}`);
  }
  const json = JSON.stringify(await summarize(inputs, metadata)) + '\n';
  if (output) await writeFile(output, json, { flag: 'wx' });
  else process.stdout.write(json);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(error => { console.error(`summarize-native: ${error.message}`); process.exitCode = 1; });
