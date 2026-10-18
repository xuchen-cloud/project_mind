#!/usr/bin/env node
// Historical complex x5 extraction only. Does not launch or measure anything.
// OFFICE_PERF_EVIDENCE=/absolute/raw/root src-tauri/resources/agent-host/node scripts/office-performance/evidence/native-phases-20261019.mjs [--xlsx-directory=after-native-release-xlsx-actions]
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseWorkerLog, statistics } from '../summarize-native.mjs';

const root = process.env.OFFICE_PERF_EVIDENCE;
assert.ok(root && isAbsolute(root), 'Set OFFICE_PERF_EVIDENCE to the existing absolute raw evidence root');
const directory = 'after-native-release-verified-formal', formats = ['docx', 'pptx', 'xlsx', 'md'];
const options = process.argv.slice(2);
assert.ok(options.length <= 1 && options.every(option => option.startsWith('--xlsx-directory=')), 'Only --xlsx-directory=RELATIVE_DIR is supported, at most once');
const xlsxDirectory = options.length ? options[0].slice('--xlsx-directory='.length) : null;
if (xlsxDirectory !== null) {
  const path = relative(root, resolve(root, xlsxDirectory));
  assert.ok(xlsxDirectory && !isAbsolute(xlsxDirectory) && path && path !== '..' && !path.startsWith('../'), 'XLSX directory must be inside OFFICE_PERF_EVIDENCE');
}
// An override writes a separate artifact; the original final44-derived output
// remains intact even when the new matrix has finished.
const output = xlsxDirectory === null ? 'native-phases-20261019.json' : 'native-phases-20261019-xlsx-actions.json';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async path => { const bytes = await readFile(resolve(root, path)); return { value: JSON.parse(bytes), sha256: hash(bytes) }; };
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ms = value => finite(value) ? value : null;
const delta = (end, start) => finite(end) && finite(start) ? ms(end - start) : null;
const portable = value => {
  if (typeof value === 'string') {
    if (value.startsWith(root)) return '$OFFICE_PERF_EVIDENCE/' + relative(root, value);
    if (value.includes('/project_mind/')) return 'repo:' + value.split('/project_mind/').at(-1);
    return value.replaceAll(root, '$OFFICE_PERF_EVIDENCE').replaceAll(repo, 'repo:/');
  }
  if (Array.isArray(value)) return value.map(portable);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v)])) : value;
};
const matrix = await load(`${directory}/matrix.json`);
assert.equal(matrix.value.mode, 'release'); assert.ok(matrix.value.finishedAt, 'Unfinished matrix');
assert.equal(new Set(matrix.value.samples.map(row => row.file)).size, matrix.value.samples.length);
const xlsxMatrix = xlsxDirectory === null ? matrix : await load(`${xlsxDirectory}/matrix.json`);
if (xlsxDirectory !== null) {
  assert.equal(xlsxMatrix.value.mode, 'release');
  assert.ok(xlsxMatrix.value.finishedAt && Number.isFinite(Date.parse(xlsxMatrix.value.finishedAt)), 'Unfinished XLSX matrix; no output written');
  const expected = ['simple', 'complex', 'large'].flatMap(sample => Array.from({ length: sample === 'complex' ? 5 : 3 }, (_, index) => `xlsx-${sample}-${index + 1}.json`)).sort();
  assert.deepEqual(xlsxMatrix.value.samples.map(row => row.file).sort(), expected, 'Completed XLSX matrix must contain exactly simple3/complex5/large3');
}
const selected = formats.flatMap(format => [1, 2, 3, 4, 5].map(run => {
  const sourceMatrix = format === 'xlsx' ? xlsxMatrix : matrix;
  const sourceDirectory = format === 'xlsx' && xlsxDirectory !== null ? xlsxDirectory : directory;
  const file = `${format}-complex-${run}.json`, matches = sourceMatrix.value.samples.filter(row => row.file === file);
  assert.equal(matches.length, 1, file); return { ...matches[0], format, run, directory: sourceDirectory };
}));
assert.equal(matrix.value.samples.filter(row => /-complex-\d+\.json$/.test(row.file)).length, 20);
const groups = new Map(), runs = [];
function collect(format, scenario, clock, phase, duration, ref) {
  const key = JSON.stringify([format, scenario, clock, phase]);
  if (!groups.has(key)) groups.set(key, { format, scenario, clock, phase, rows: [] });
  groups.get(key).rows.push({ duration: ms(duration), ref });
}
const rendererPairs = [
  ['entry_to_ready', 'entry', 'ready'], ['entry_to_initialize', 'entry', 'host-initialized'],
  ['main_import', 'main-import-start', 'main-import-end'], ['font_guard', 'font-load-start', 'font-load-end'],
  ['react_to_context', 'react-render', 'first-app-context'], ['context_to_attach', 'first-app-context', 'runtime-attached'],
  ['attach_to_content', 'runtime-attached', 'initial-content-loaded'],
  ['content_to_rendered_hooks', 'initial-content-loaded', 'rendered-hooks-complete'],
  ['rendered_to_steady', 'rendered-hooks-complete', 'lifecycle-3'],
  ['calculation_request_to_start', 'initial-calculation-requested', 'initial-calculation-starting'],
  ['calculation_start_to_applied', 'initial-calculation-starting', 'initial-calculation-applied'],
  ['applied_to_ready', 'initial-calculation-applied', 'ready'],
];
function span(marks, name, from, to) {
  const starts = marks.filter(row => row.name === from), ends = marks.filter(row => row.name === to);
  const start = starts.length === 1 ? ms(starts[0].startTime) : null, end = ends.length === 1 ? ms(ends[0].startTime) : null;
  const duration = delta(end, start);
  return { name, from, to, start, end, duration, status: duration === null ? 'unavailable' : 'observed',
    ...(duration === null ? { reason: `endpoint counts ${starts.length}/${ends.length}; require unique finite monotonic endpoints` } : {}) };
}
const intersection = (a, b) => a.duration !== null && b.duration !== null ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) : null;
function snapshot(doc, scenario) {
  const marks = doc.marks ?? [], ordered = marks.map((row, index) => ({ ...row, index })).filter(row => finite(row.startTime)).sort((a, b) => a.startTime - b.startTime || a.index - b.index);
  const spans = marks.some(row => row.name.startsWith('office-xlsx:')) ? rendererPairs.map(([name, from, to]) => span(marks, name, `office-xlsx:${from}`, `office-xlsx:${to}`)) : [];
  const main = spans.find(row => row.name === 'main_import'), font = spans.find(row => row.name === 'font_guard');
  return { clock: doc.document === 0 ? 'host' : `${scenario}/document-${doc.document}/snapshot-local`, document: doc.document, url: doc.url,
    attribution: doc.document === 0 ? 'cumulative host marks; not all belong to this scenario' : 'observed iframe lifetime; reused iframe snapshots are not new executions or scenario durations',
    marksStatus: doc.marks === undefined ? 'unavailable' : marks.length ? 'observed' : 'no_matching_captured_marks',
    marks: doc.marks === undefined ? null : marks.map(row => [row.name, row.entryType ?? null, ms(row.startTime), ms(row.duration), row.detail ?? null]),
    adjacentGaps: ordered.slice(1).map((row, index) => [ordered[index].index, row.index, delta(row.startTime, ordered[index].startTime)]),
    spans, mainFontOverlapMs: main && font ? intersection(main, font) : null,
    fontOutcome: marks.some(row => row.name === 'office-xlsx:font-load-timeout') ? 'timeout' : marks.some(row => row.name === 'office-xlsx:font-load-loaded') ? 'loaded' : 'unknown',
    resourceEntries: doc.entries ?? null };
}
// Split a host scenario into disjoint wall-clock segments. Active interval IDs
// expose concurrency; summing overlapping command/module spans is never required.
function partition(start, end, intervals) {
  if (!finite(start) || !finite(end) || end < start) return null;
  const clipped = intervals.filter(row => finite(row.start) && finite(row.end) && row.end >= start && row.start <= end);
  const edges = [...new Set([start, end, ...clipped.flatMap(row => [Math.max(start, row.start), Math.min(end, row.end)])])].sort((a, b) => a - b);
  return edges.slice(1).map((edge, i) => [edges[i], edge, edge - edges[i], clipped.filter(row => row.start < edge && row.end > edges[i]).map(row => row.id)]);
}
for (const sample of selected) {
  const source = `${sample.directory}/${sample.file}`, raw = await load(source), report = raw.value;
  assert.equal(raw.sha256, sample.sha256, source);
  assert.equal(report.config.format, sample.format); assert.equal(report.config.sample, 'complex'); assert.equal(report.config.run, sample.run);
  assert.equal(report.scope, 'native ProjectFileContent shell (not full application startup)');
  const expected = ['cold_open', 'first_other_file', 'close_reopen', 'switch_file', ...(sample.format === 'md' ? ['rich_to_source', 'source_to_rich'] : ['preview_to_edit'])];
  assert.deepEqual(report.measurements.map(row => row.name), expected, source);
  const commandObjects = report.commands.map((row, index) => {
    const owners = report.measurements.filter(s => index >= s.commandOffset && index < s.commandOffset + s.commandCount);
    assert.ok(owners.length <= 1, `Ambiguous command ownership ${source}/${index}`);
    const scenario = owners[0]?.name ?? null;
    collect(sample.format, scenario, 'host', `command:${row.name}`, row.duration, [sample.run, index]);
    return { ...row, index, scenario };
  });
  const scenarios = report.measurements.map(row => {
    const documents = (row.resources ?? []).map(doc => snapshot(doc, row.name));
    const hostMarks = (row.resources ?? []).find(doc => doc.document === 0)?.marks ?? [];
    const end = finite(row.startTime) && finite(row.duration) ? row.startTime + row.duration : null;
    const currentMarks = hostMarks.filter(mark => mark.startTime >= row.startTime && mark.startTime <= end);
    const moduleSpans = [sample.format, 'host'].map(name => span(currentMarks, `module:${name}`, `office-component:${name}:requested`, `office-component:${name}:ready`));
    const mounted = currentMarks.filter(mark => mark.name === `office-component:${sample.format}:mounted`);
    const tail = mounted.length === 1 ? { name: 'wrapper_commit_to_scenario_ready', start: ms(mounted[0].startTime), end, duration: delta(end, mounted[0].startTime) } : { name: 'wrapper_commit_to_scenario_ready', start: null, end, duration: null };
    const hostSpans = [...moduleSpans, tail];
    collect(sample.format, row.name, 'host', 'scenario_total', row.duration, [sample.run, row.name]);
    for (const item of hostSpans) collect(sample.format, row.name, 'host', item.name, item.duration, [sample.run, row.name]);
    // Only the first cold snapshot has an unambiguous new iframe observation.
    if (row.name === 'cold_open' && sample.format === 'xlsx') for (const doc of documents.filter(doc => doc.document !== 0)) {
      for (const item of doc.spans) collect(sample.format, row.name, 'iframe', item.name, item.duration, [sample.run, doc.document]);
      collect(sample.format, row.name, 'iframe', 'main_font_overlap', doc.mainFontOverlapMs, [sample.run, doc.document]);
    }
    const intervals = [...moduleSpans.filter(item => item.duration !== null).map(item => ({ ...item, id: item.name })),
      ...commandObjects.filter(item => item.scenario === row.name).map(item => ({ id: `command:${item.index}`, start: ms(item.startTime), end: finite(item.startTime) && finite(item.duration) ? item.startTime + item.duration : null }))];
    return { name: row.name, file: row.file, fileId: row.fileId ?? null, version: row.version ?? null, start: ms(row.startTime), end, duration: ms(row.duration), status: row.status ?? 'unknown',
      budgetMs: row.budgetMs ?? null, commandRange: [row.commandOffset, row.commandCount],
      readiness: row.evidence ? { visibility: row.evidence.visibility ?? null, stableDoubleRafPasses: row.evidence.stableDoubleRafPasses ?? null,
        decodedImages: row.evidence.decodedImages ?? null, paintedCanvases: row.evidence.paintedCanvases ?? null, visualCount: row.evidence.visuals?.length ?? null } : null,
      hostSpans, hostSegments: partition(ms(row.startTime), end, intervals), documents };
  });
  const logPath = source.replace(/\.json$/, '.log'), log = await readFile(resolve(root, logPath));
  const workers = parseWorkerLog(log.toString());
  for (const worker of workers) for (const [clock, phases] of Object.entries(worker.phases)) for (const [phase, duration] of Object.entries(phases))
    collect(sample.format, null, `native-${clock}`, phase, duration, [sample.run, worker.requestId]);
  runs.push({ source, rawSha256: raw.sha256, logSha256: hash(log), format: sample.format, sample: 'complex', repetition: sample.run,
    status: report.status ?? 'unknown', matrixStatus: sample.status ?? 'unknown', errors: report.errors ?? [], error: report.error ?? null, visibility: report.visibility ?? 'unknown',
    runner: report.runner, config: report.config, shellReady: report.shell_ready ?? null,
    commands: commandObjects.map(row => [row.index, row.scenario, row.api, row.name, ms(row.startTime), ms(row.duration), row.error ?? null, row.requestId ?? null]),
    scenarios, finalDocuments: (report.resources ?? []).map(doc => snapshot(doc, 'final')),
    workerMarks: [...log.toString().matchAll(/\[office-performance\]\s+(\S+)\s+(read|worker-slot|worker-spawn|worker-response|worker-decode|worker-complete|revalidated)\s+(\S+)/g)].map(match => [match[1], match[2], ms(Number(match[3]))]),
    workers: workers.map(worker => ({ ...worker, scenario: null, commandIndex: null })) });
}
const table = [...groups.values()].map(({ rows, ...keys }) => ({ ...keys, ...statistics(rows.map(row => row.duration)),
  unavailable: rows.filter(row => row.duration === null).length,
  status: rows.every(row => row.duration !== null) ? 'observed' : rows.every(row => row.duration === null) ? 'unavailable' : 'partial', refs: rows.map(row => row.ref) }));
const result = portable({ schema: 1, scope: 'existing final release Native Verified ProjectFileContent shell; complex cohort x5 per format; not full App startup or CPU profiling',
  source: { directory, matrixSha256: matrix.sha256, metadata: Object.fromEntries(Object.entries(matrix.value).filter(([key]) => key !== 'samples')) },
  ...(xlsxDirectory === null ? {} : {
    formatSources: Object.fromEntries(formats.map(format => {
      const replacement = format === 'xlsx', sourceMatrix = replacement ? xlsxMatrix : matrix;
      return [format, { label: replacement ? 'after-xlsx-actions' : 'after', directory: replacement ? xlsxDirectory : directory,
        matrixSha256: sourceMatrix.sha256, metadata: Object.fromEntries(Object.entries(sourceMatrix.value).filter(([key]) => key !== 'samples')) }];
    })),
    previousSources: [{ format: 'xlsx', label: 'previous-final-release-xlsx', directory, matrixSha256: matrix.sha256,
      phaseArtifact: 'scripts/office-performance/evidence/native-phases-20261019.json',
      retainedSamples: matrix.value.samples.filter(row => row.file.startsWith('xlsx-')).map(row => ({ ...row, source: `${directory}/${row.file}` })),
      note: 'Previous XLSX raw files and original phase artifact retained; excluded from replacement aggregates. Top-level source remains the base matrix; use formatSources for each active format.' }],
  }),
  columns: { commands: ['index', 'scenario(null=setup)', 'api', 'name', 'hostStartMs', 'durationMs', 'error', 'requestId'],
    marks: ['name', 'entryType', 'documentStartMs', 'durationMs', 'detail'], adjacentGaps: ['fromRawMarkIndex', 'toRawMarkIndex', 'deltaMs'],
    hostSegments: ['startMs', 'endMs', 'durationMs', 'activeIntervalIds(empty=unattributed)'], workerMarks: ['requestId', 'stage', 'cumulativeMs'] },
  interpretation: {
    statistics: 'Milliseconds, elapsed wall time; rawms follow refs order; p95 is nearest rank ceil(.95*n). null is unavailable, never zero or pass.',
    clocks: 'Host commands, scenario boundaries and document 0 marks share one run clock. Each iframe snapshot is kept local: URL/index do not establish lifecycle identity. performance.timeOrigin is absent; do not align iframe, host, Rust or runner times.',
    capture: 'All recorded document marks/resources are retained, including repeated marks and final snapshots. Native harness captured only office-component/office-xlsx marks, last 100 per document. Missing marks do not prove absent work. Span endpoints require unique marks; adjacent gaps are elapsed intervals, not attribution.',
    file: 'project_file_resolve, file_versions_list, project_file_read_bytes and file_source_read are real command envelope durations, including bridge/native/serialization. commandOffset/count identifies scenario. first_other_file AND close_reopen open simple fixtures even in the complex cohort; file identity is retained.',
    module: 'requested->ready is lazy component module load/evaluation elapsed, potentially network/cache and shared imports. mounted is React wrapper commit, not renderer ready. wrapper_commit_to_scenario_ready bundles renderer import, initialize, font, parse, layout, paint and readiness waits.',
    font: 'XLSX font_guard is the existing Promise.race registration/loading/timeout guard, not isolated font fetch/decode CPU. main_import completion is module evaluation completion; asynchronous bootstrap continues. main_font_overlap must not be added twice.',
    renderer: 'entry_to_ready contains other spans; calculation_start_to_applied includes session/queue/application waits. Rendered/Steady and rendered-hooks-complete are lifecycle signals, not isolated layout or paint timing. Only cold iframe spans are aggregated; later snapshots may repeat the same iframe lifetime.',
    outer: 'Rust inspect origin: read includes File validation/lookup/version/content read/base64; workerAwait contains the worker plus surrounding await; revalidation repeats File validation/read after await. These are sequential within outer, total is not an extra phase.',
    worker: 'Separate Rust worker-entry origin: preparationAndSlot includes frame serialization/admission; temporarySetupAndSpawn includes temp setup/OS spawn/process attachment; sendReceiveAndExecution includes parallel send/receive, Node boot/import, engine inspect and response; exitWaitAndDecode includes process wait/JSON decode. total is not an extra phase.',
    overlap: 'Host segment active IDs show observed module/command concurrency. Native worker work is nested in outer workerAwait, not additive. Worker pipe send/receive run concurrently. No exact JS-command/native-request join exists: JS commands lack requestId; workers are grouped only by run/format and include both complex and simple inspections, never labeled cold by log order.',
    status: 'Original scenario/run status is retained; observed timing is not an acceptance pass. No missing cost is estimated from a residual or assigned to CPU.' },
  unavailable: [
    { cost: 'isolated engine inspect / Node module import / IPC send vs receive', formats, ms: null, reason: 'Office worker has one combined response interval, no engine/internal Node spans; MD has no Office inspect worker (not applicable).' },
    { cost: 'pure OS spawn', formats: ['docx', 'pptx', 'xlsx'], ms: null, reason: 'Recorded spawn segment includes temporary setup and process attachment.' },
    { cost: 'renderer module / fonts', formats: ['docx', 'pptx', 'md'], ms: null, reason: 'No renderer-internal marks in captured reports; host component import is separate from iframe runtime loading.' },
    { cost: 'font transfer / font decode / document parse / layout / paint separately', formats, ms: null, reason: 'No matching isolated spans. ResourceTiming entries are retained but do not isolate decode/layout/paint; positive visual gates are evidence of readiness, not cost measurements.' },
    { cost: 'full App startup / cross-clock critical path / CPU / heap', formats, ms: null, reason: 'Document-shell reports, no timeOrigin alignment, CPU profiler or heap capture.' } ],
  table, runs });
const json = JSON.stringify(result) + '\n';
assert.ok(!json.includes('/Users/'), 'Machine-specific path escaped portable normalization');
await writeFile(new URL(`./${output}`, import.meta.url), json);
console.log(JSON.stringify({ output: `scripts/office-performance/evidence/${output}`, runs: runs.length, groups: table.length, bytes: Buffer.byteLength(json), workerRequests: runs.reduce((n, row) => n + row.workers.length, 0) }));
