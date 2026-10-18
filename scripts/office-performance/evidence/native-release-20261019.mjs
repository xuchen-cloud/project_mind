#!/usr/bin/env node
// Read-only extraction of an explicit historical evidence allowlist. No launches.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { statistics, parseWorkerLog } from '../summarize-native.mjs';

const root = process.env.OFFICE_PERF_EVIDENCE;
if (!root || !isAbsolute(root)) throw Error('Set OFFICE_PERF_EVIDENCE to the absolute existing raw evidence root');
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const optionNames = ['after-development', 'after-xlsx-actions', 'after-development-xlsx-actions', 'after-startup'];
const directories = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(argument);
  assert.ok(match && optionNames.includes(match[1]), `Unsupported option: ${argument}`);
  const [, name, directory] = match;
  assert.ok(!Object.hasOwn(directories, name), `Duplicate option: --${name}`);
  const rel = relative(root, resolve(root, directory));
  assert.ok(!isAbsolute(directory) && rel && !rel.startsWith('..') && !isAbsolute(rel), `--${name} must be relative to OFFICE_PERF_EVIDENCE`);
  directories[name] = rel;
}
const afterStartupDirectory = directories['after-startup'];
const afterXlsxActionsDirectory = directories['after-xlsx-actions'];
const afterDevelopmentDirectory = directories['after-development'];
const afterDevelopmentXlsxActionsDirectory = directories['after-development-xlsx-actions'];
assert.ok(!afterDevelopmentXlsxActionsDirectory || afterDevelopmentDirectory,
  '--after-development-xlsx-actions requires --after-development for the existing Word/PPT/MD source');
const selections = [
  ['baseline', 'baseline-native-release-formal', (format, sample) => ['pptx', 'md'].includes(format) || format === 'docx' && sample !== 'large'],
  ['baseline', 'baseline-native-large-word-corrected', format => format === 'docx'],
  ['baseline', 'baseline-native-release-xlsx-visual', format => format === 'xlsx'],
  ['after', 'after-native-release-verified-formal', format => !afterXlsxActionsDirectory || format !== 'xlsx'],
  ...(afterXlsxActionsDirectory ? [
    ['after-before-actions', 'after-native-release-verified-formal', format => format === 'xlsx'],
    ['after', afterXlsxActionsDirectory, format => format === 'xlsx'],
  ] : []),
  ['after-prior', 'after-native-release-other-formal', format => ['docx', 'pptx', 'md'].includes(format)],
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async path => { const bytes = await readFile(resolve(root, path)); return { value: JSON.parse(bytes), sha256: hash(bytes), bytes: bytes.length }; };
const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const portable = value => {
  if (typeof value === 'string') {
    if (value.startsWith(root)) return '$OFFICE_PERF_EVIDENCE/' + relative(root, value);
    if (value.includes('/project_mind/')) return 'repo:' + value.split('/project_mind/').at(-1);
    return value.replaceAll(root, '$OFFICE_PERF_EVIDENCE').replaceAll(repo, 'repo:/');
  }
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item)]));
  return value;
};
const sources = [], runs = [], grouped = new Map(), commandGroups = new Map(), workerGroups = new Map();
const accumulate = (map, keys, duration, status, ref) => {
  const key = JSON.stringify(keys);
  if (!map.has(key)) map.set(key, { keys, rows: [] });
  map.get(key).rows.push({ duration, status, ref });
};
const finishGroups = (map, names) => [...map.values()].map(({ keys, rows }) => ({
  ...Object.fromEntries(names.map((name, index) => [name, keys[index]])),
  ...statistics(rows.map(row => row.duration)), statusCounts: counts(rows.map(row => row.status)), refs: rows.map(row => row.ref),
}));
const phaseNames = { outer: ['readMs', 'workerAwaitMs', 'revalidationMs', 'totalMs'], worker: ['preparationAndSlotMs', 'temporarySetupAndSpawnMs', 'sendReceiveAndExecutionMs', 'exitWaitAndDecodeMs', 'totalMs'] };

async function extract(label, directory, include, formal, mode = 'release', bucket = { sources, runs, grouped, commandGroups, workerGroups }, explicitRawFiles = null) {
  const { sources, runs, grouped, commandGroups, workerGroups } = bucket;
  const matrix = explicitRawFiles ? null : await load(`${directory}/matrix.json`);
  const meta = matrix?.value ?? { mode, samples: await Promise.all(explicitRawFiles.map(async file => {
    const raw = await load(`${directory}/${file}`);
    assert.ok(typeof raw.value.status === 'string' && Number.isFinite(raw.value.runner?.wallMs), `Raw report not complete: ${directory}/${file}`);
    return { file, sha256: raw.sha256, status: raw.value.status };
  })) };
  assert.equal(meta.mode, mode, directory);
  if (matrix) assert.ok(meta.finishedAt, `Matrix not finished; existing output is left untouched: ${directory}`);
  assert.equal(new Set(meta.samples.map(sample => sample.file)).size, meta.samples.length, `Duplicate selected samples: ${directory}`);
  sources.push({ label, directory, formal, mainComparison: formal && ['baseline', 'after'].includes(label), matrixSha256: matrix?.sha256 ?? null, mode: meta.mode, startedAt: meta.startedAt, finishedAt: meta.finishedAt,
    node: meta.node, machine: meta.machine, binary: portable(meta.binary), binarySha256: meta.binarySha256 ?? null,
    qualification: matrix ? meta.qualification : 'Explicit non-formal release A/B raw reports; no matrix was recorded. Machine/cache facts and historical binary SHA are not inferred from app paths or other matrices.',
    ...(explicitRawFiles ? { explicitRawFiles, modeSource: 'explicit release experiment selection; raw report does not record build mode' } : {}),
    binaryHashSource: matrix ? 'historical matrix; current app bundle may have been rebuilt and is not rehashed' : 'unavailable without historical matrix or raw binary SHA' });
  for (const sample of meta.samples) {
    const match = /^(docx|pptx|xlsx|md)-(simple|complex|large)-(\d+)\.json$/.exec(sample.file);
    assert.ok(match, `Unexpected matrix sample: ${sample.file}`);
    const [, format, cohort, repetition] = match;
    if (!include(format, cohort, Number(repetition))) continue;
    const path = `${directory}/${sample.file}`, raw = await load(path), report = raw.value;
    assert.equal(raw.sha256, sample.sha256, `Raw matrix hash mismatch: ${path}`);
    assert.equal(report.scope, 'native ProjectFileContent shell (not full application startup)', path);
    assert.equal(report.config.format, format); assert.equal(report.config.sample, cohort);
    assert.equal(report.config.run, Number(repetition));
    const validityIssues = [];
    if (report.visibility !== 'visible') validityIssues.push('report visibility is not visible');
    if (!['passed', 'over_budget'].includes(report.status)) validityIssues.push(`report status: ${report.status}`);
    if (report.error || report.errors?.length) validityIssues.push('report contains errors');
    const expected = ['cold_open', 'first_other_file', 'close_reopen', 'switch_file', ...(format === 'md' ? ['rich_to_source', 'source_to_rich'] : ['preview_to_edit'])];
    if (JSON.stringify(report.measurements.map(row => row.name)) !== JSON.stringify(expected)) validityIssues.push('scenario sequence differs from expected performance matrix');
    for (const row of report.measurements) if (!['passed', 'over_budget'].includes(row.status) || row.error) validityIssues.push(`scenario ${row.name}: ${row.status}`);
    const cold = report.measurements.find(row => row.name === 'cold_open');
    const commandRows = report.commands.map((command, index) => {
      const owners = report.measurements.filter(row => index >= row.commandOffset && index < row.commandOffset + row.commandCount);
      return { index, api: command.api, name: command.name, startTime: command.startTime, duration: command.duration ?? null,
        scenario: owners.length === 1 ? owners[0].name : null, status: command.error ? 'error' : command.duration === undefined ? 'unknown' : 'completed',
        ...(command.requestId ? { requestId: command.requestId } : {}), ...(command.error ? { error: command.error } : {}) };
    });
    const logPath = path.replace(/\.json$/, '.log'), log = await readFile(resolve(root, logPath));
    const workers = parseWorkerLog(log.toString());
    const nav = report.shell_ready?.navigation?.[0];
    const run = { source: path, rawSha256: raw.sha256, rawBytes: raw.bytes, logSha256: hash(log), label, formal, mainComparison: formal && ['baseline', 'after'].includes(label),
      matrixStatus: matrix ? sample.status : null, ...(explicitRawFiles ? { runnerBinary: portable(report.runner?.binary), binarySha256: report.runner?.binarySha256 ?? null } : {}), readinessComplete: validityIssues.length === 0, validityIssues,
      errors: report.errors ?? [], ...(report.error ? { error: report.error } : {}),
      mode, format, sample: cohort, run: Number(repetition), wallMs: report.runner?.wallMs ?? null, status: report.status, visibility: report.visibility,
      workspace: portable(report.config.workspaceRoot), width: report.config.width,
      acceptanceRequested: report.config.acceptance ?? false, racesRequested: report.config.races ?? false,
      shellReady: { startTime: report.shell_ready?.startTime ?? null, navigation: nav ? Object.fromEntries(['startTime', 'duration', 'responseEnd', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd'].map(key => [key, nav[key]])) : null },
      measurements: report.measurements.map(row => ({ name: row.name, file: row.file, version: row.version ?? null, startTime: row.startTime, duration: row.duration, status: row.status, budgetMs: row.budgetMs, ...(row.error ? { error: row.error } : {}), ...(row.reason ? { reason: row.reason } : {}),
        readiness: { stableDoubleRafPasses: row.evidence?.stableDoubleRafPasses, decodedImages: row.evidence?.decodedImages, paintedCanvases: row.evidence?.paintedCanvases,
          visualCount: row.evidence?.visuals?.length ?? null, visibility: row.evidence?.visibility } })),
      coldMarks: (cold?.resources ?? []).map(doc => ({ document: doc.document, url: doc.url,
        marks: doc.marks === undefined ? null : doc.marks.filter(mark => /^(office-xlsx:|office-component:)/.test(mark.name)).map(mark => ({ name: mark.name, startTime: mark.startTime, duration: mark.duration, ...(mark.detail === undefined ? {} : { detail: mark.detail }) })) })),
      commands: commandRows, workerRequests: workers };
    runs.push(run);
    if (!formal) continue;
    for (const row of report.measurements) {
      accumulate(grouped, [label, format, cohort, row.name], row.duration, row.status, path);
    }
    for (const command of commandRows) accumulate(commandGroups, [label, format, cohort, command.scenario, command.name], command.duration, command.status, [path, command.index]);
    for (const worker of workers) for (const [clock, phases] of Object.entries(phaseNames)) for (const phase of phases)
      accumulate(workerGroups, [label, format, cohort, clock, phase], worker.phases[clock][phase], worker.status, [path, worker.requestId]);
  }
}
// Preflight every explicitly supplied new matrix before reading cohorts or writing output.
for (const [name, directory] of Object.entries(directories)) {
  // Landing runs have no matrix; require all three complete reports below.
  if (name === 'after-startup') continue;
  const { value: matrix } = await load(`${directory}/matrix.json`);
  assert.ok(matrix.finishedAt, `Matrix not finished; existing output is left untouched: ${directory}`);
  assert.equal(matrix.mode, name === 'after-xlsx-actions' ? 'release' : 'development', directory);
}
for (const [label, directory, include] of selections) await extract(label, directory, include, true);
await extract('after-probe-not-formal', 'native-optimized-host-release-probe', (format, sample, run) => format === 'docx' && sample === 'complex' && run === 1, false);
await extract('after-xlsx-probe-not-formal', 'native-final-xlsx-probe', (format, sample) => format === 'xlsx' && sample === 'complex', false);
const outlier = runs.find(run => run.label === 'after-probe-not-formal');
assert.equal(outlier.measurements[0].duration, 1499, 'Expected preserved non-formal Word outlier');
// Exact cohort membership catches missing/extra repetitions, not just total 44.
for (const [label, formats] of [['baseline', ['docx', 'xlsx', 'pptx', 'md']], ['after', ['docx', 'xlsx', 'pptx', 'md']], ['after-prior', ['docx', 'pptx', 'md']], ...(afterXlsxActionsDirectory ? [['after-before-actions', ['xlsx']]] : [])]) {
  const selected = runs.filter(run => run.label === label && run.formal);
  assert.equal(selected.length, formats.length * 11, `${label}: unexpected matrix size`);
  for (const format of formats) for (const [sample, repetitions] of [['simple', 3], ['complex', 5], ['large', 3]])
    assert.deepEqual(selected.filter(run => run.format === format && run.sample === sample).map(run => run.run).sort((a, b) => a - b),
      Array.from({ length: repetitions }, (_, index) => index + 1), `${label}/${format}/${sample}: unexpected repetitions`);
}
assert.equal(runs.filter(run => run.label === 'after-xlsx-probe-not-formal').length, 3);
const coverage = ['baseline', 'after', 'after-prior', ...(afterXlsxActionsDirectory ? ['after-before-actions'] : [])].map(label => {
  const rows = runs.filter(run => run.label === label && run.formal);
  return { label, expectedRuns: label === 'after-prior' ? 33 : label === 'after-before-actions' ? 11 : 44, observedRuns: rows.length,
    readinessCompleteRuns: rows.filter(run => run.readinessComplete).length, statusCounts: counts(rows.map(run => run.status)) };
});
const probeGrouped = new Map();
for (const run of runs.filter(run => !run.formal)) for (const row of run.measurements)
  accumulate(probeGrouped, [run.label, run.format, run.sample, row.name], row.duration, row.status, run.source);
const pending = [];
for (const format of ['docx', 'xlsx', 'pptx', 'md']) {
  const rows = runs.filter(run => run.label === 'after' && run.format === format);
  if (rows.length !== 11 || rows.some(run => !run.readinessComplete)) pending.push({ label: 'after', format,
    status: 'final formal matrix incomplete or contains readiness failures; all observed data retained',
    observedRuns: rows.length, readinessCompleteRuns: rows.filter(run => run.readinessComplete).length });
}

// Reverted actions experiment: retained in independent buckets, never formal comparison.
const experiments = { sources: [], runs: [], grouped: new Map(), commandGroups: new Map(), workerGroups: new Map() };
await extract('actions-matrix-not-retained', 'after-native-release-xlsx-actions', format => format === 'xlsx', false, 'release', experiments);
for (const [label, directory] of [['actions-ab-before-not-retained', 'native-actions-ab-before'], ['actions-ab-after-not-retained', 'native-actions-ab-after']])
  await extract(label, directory, format => format === 'xlsx', false, 'release', experiments,
    [1, 2, 3].map(run => `xlsx-complex-${run}.json`));
for (const [label, expected] of [['actions-matrix-not-retained', 11], ['actions-ab-before-not-retained', 3], ['actions-ab-after-not-retained', 3]]) {
  const selected = experiments.runs.filter(run => run.label === label);
  assert.equal(selected.length, expected, `${label}: unexpected experiment size`);
  for (const [sample, repetitions] of expected === 11 ? [['simple', 3], ['complex', 5], ['large', 3]] : [['complex', 3]])
    assert.deepEqual(selected.filter(run => run.sample === sample).map(run => run.run).sort((a, b) => a - b),
      Array.from({ length: repetitions }, (_, index) => index + 1), `${label}/${sample}: unexpected repetitions`);
}
for (const run of experiments.runs) {
  run.disposition = 'not-retained';
  for (const row of run.measurements) accumulate(experiments.grouped, [run.label, run.format, run.sample, row.name], row.duration, row.status, run.source);
  for (const command of run.commands) accumulate(experiments.commandGroups, [run.label, run.format, run.sample, command.scenario, command.name], command.duration, command.status, [run.source, command.index]);
  for (const worker of run.workerRequests) for (const [clock, phases] of Object.entries(phaseNames)) for (const phase of phases)
    accumulate(experiments.workerGroups, [run.label, run.format, run.sample, clock, phase], worker.phases[clock][phase], worker.status, [run.source, worker.requestId]);
}
const experimentEvidence = { disposition: 'not-retained', formal: false, mainComparison: false, mode: 'release',
  scope: 'native ProjectFileContent shell (not full application startup)',
  qualification: 'Two action import splits were reverted after the coordinating agent found no cold-open benefit. The 11-run experiment and six A/B runs remain separate from each other and from all main release/development/startup statistics. A/B pairing/order beyond explicit run IDs is not inferred.',
  sources: experiments.sources, runs: experiments.runs,
  coverage: [...new Set(experiments.runs.map(run => run.label))].map(label => {
    const rows = experiments.runs.filter(run => run.label === label);
    return { label, expectedRuns: label === 'actions-matrix-not-retained' ? 11 : 3, observedRuns: rows.length,
      readinessCompleteRuns: rows.filter(run => run.readinessComplete).length, statusCounts: counts(rows.map(run => run.status)) };
  }),
  groups: finishGroups(experiments.grouped, ['label', 'format', 'sample', 'scenario']),
  commandGroups: finishGroups(experiments.commandGroups, ['label', 'format', 'sample', 'scenario', 'name']),
  workerPhaseGroups: finishGroups(experiments.workerGroups, ['label', 'format', 'sample', 'clock', 'phase']),
};

// Development uses independent buckets, never the release statistics/maps.
const development = { sources: [], runs: [], grouped: new Map(), commandGroups: new Map(), workerGroups: new Map() };
await extract('baseline', 'baseline-native-development-unlocked', (format, sample) => ['docx', 'pptx', 'md'].includes(format) && sample === 'complex', true, 'development', development);
await extract('baseline', 'baseline-native-development-xlsx', (format, sample) => format === 'xlsx' && sample === 'complex', true, 'development', development);
if (afterDevelopmentDirectory) {
  await extract('after', afterDevelopmentDirectory, (format, sample) => sample === 'complex' && (!afterDevelopmentXlsxActionsDirectory || format !== 'xlsx'), true, 'development', development);
  if (afterDevelopmentXlsxActionsDirectory) {
    await extract('after-before-actions', afterDevelopmentDirectory, (format, sample) => format === 'xlsx' && sample === 'complex', true, 'development', development);
    await extract('after', afterDevelopmentXlsxActionsDirectory, (format, sample) => format === 'xlsx' && sample === 'complex', true, 'development', development);
  }
}
const developmentLabels = ['baseline', ...(afterDevelopmentDirectory ? ['after'] : []), ...(afterDevelopmentXlsxActionsDirectory ? ['after-before-actions'] : [])];
for (const label of developmentLabels) {
  const rows = development.runs.filter(run => run.label === label);
  const formats = label === 'after-before-actions' ? ['xlsx'] : ['docx', 'pptx', 'xlsx', 'md'];
  assert.equal(rows.length, formats.length * 3, `development ${label}: unexpected complex cohort size`);
  for (const format of formats)
    assert.deepEqual(rows.filter(run => run.format === format).map(run => run.run).sort((a, b) => a - b), [1, 2, 3], `development ${label}/${format}`);
}
const developmentEvidence = {
  mode: 'development', scope: 'native ProjectFileContent shell (not full application startup)',
  qualification: 'Live development renderer resources and cold command paths; kept separate from production/release. Matrix binary SHA alone does not hash served source. Raw report/source URLs are retained in coldMarks.',
  sources: development.sources, runs: development.runs,
  stages: { baseline: 'Historical development complex cohort, 12 runs',
    after: afterDevelopmentXlsxActionsDirectory ? 'Existing Word/PPT/MD nine runs plus explicit XLSX actions three runs; separate sources retained' : 'Explicit final development complex cohort, 12 runs',
    ...(afterDevelopmentXlsxActionsDirectory ? { 'after-before-actions': 'Previous development XLSX three runs, excluded from main comparison' } : {}) },
  coverage: developmentLabels.map(label => {
    const rows = development.runs.filter(run => run.label === label);
    return { label, expectedRuns: label === 'after-before-actions' ? 3 : 12, observedRuns: rows.length, readinessCompleteRuns: rows.filter(run => run.readinessComplete).length, statusCounts: counts(rows.map(run => run.status)) };
  }),
  pending: afterDevelopmentDirectory
    ? development.runs.some(run => run.label === 'after' && !run.readinessComplete) ? [{ label: 'after', directory: afterDevelopmentDirectory, status: 'contains readiness failures; observations retained' }] : []
    : [{ label: 'after', plannedDirectory: 'after-native-development-final', status: 'awaiting coordinating agent confirmation and completed matrix; opt in with --after-development=RELATIVE_DIR' }],
  groups: finishGroups(development.grouped, ['label', 'format', 'sample', 'scenario']),
  commandGroups: finishGroups(development.commandGroups, ['label', 'format', 'sample', 'scenario', 'name']),
  workerPhaseGroups: finishGroups(development.workerGroups, ['label', 'format', 'sample', 'clock', 'phase']),
};
// Startup's full-App landing clock is distinct from document-open and runner wall.
const startupRows = [], startupGrouped = new Map();
const startupSelections = [['baseline', 'baseline-startup-release'], ['after', afterStartupDirectory ?? 'after-startup-release'],
  ...(afterStartupDirectory ? [['after-prior', 'after-startup-release']] : [])];
for (const [label, directory] of startupSelections) {
  for (const run of [1, 2, 3]) {
    const source = `${directory}/startup-landing-${run}.json`, raw = await load(source), report = raw.value;
    if (label === 'after' && afterStartupDirectory) {
      assert.ok(typeof report.status === 'string' && Number.isFinite(report.runner?.wallMs),
        `Startup report not complete; existing output is left untouched: ${source}`);
    }
    assert.equal(report.scope, 'full application landing', source);
    assert.equal(report.runner?.config?.run, run, source);
    const issues = [];
    if (report.status !== 'passed' || report.error || report.errors?.length) issues.push('startup report contains errors or non-passed status');
    if (report.visibility !== 'visible') issues.push('startup visibility is not visible');
    for (const [metric, duration] of Object.entries({ durationFromNavigation: report.durationFromNavigation,
      wallMs: report.runner?.wallMs, observerDuration: report.observerDuration })) {
      if (!Number.isFinite(duration)) issues.push(`missing/non-finite ${metric}`);
      accumulate(startupGrouped, [label, metric], duration, report.status, source);
    }
    startupRows.push({ label, mode: 'release', modeSource: 'explicit startup-release directory selection; raw report does not record build mode',
      source, rawSha256: raw.sha256, rawBytes: raw.bytes, readinessComplete: issues.length === 0, validityIssues: issues,
      binarySha256: report.runner?.binarySha256 ?? null,
      provenanceLimits: 'No startup matrix was recorded. Historical binary SHA, machine and cache qualification are not inferred from an app path or another matrix.',
      report });
  }
}
const startupEvidence = { mode: 'release', scope: 'full application landing',
  selection: startupSelections.map(([label, directory]) => ({ label, directory })),
  stages: { baseline: 'Historical landing three runs', after: 'Selected final landing three runs',
    ...(afterStartupDirectory ? { 'after-prior': 'Previous landing three runs, excluded from final startup comparison' } : {}) },
  qualification: 'Real isolated-data landing heading, fonts and stable RAF evidence as recorded; not Workspace open or document-ready. durationFromNavigation and observerDuration are browser clocks; wallMs is runner elapsed time through report receipt. Metrics are never pooled with document-open.',
  groups: finishGroups(startupGrouped, ['label', 'metric']), runs: startupRows,
  coverage: startupSelections.map(([label]) => ({ label, expectedRuns: 3, observedRuns: startupRows.filter(run => run.label === label).length,
    readinessCompleteRuns: startupRows.filter(run => run.label === label && run.readinessComplete).length })),
};

const manifestPath = 'native-fixtures-v2/manifest.json', manifest = await load(manifestPath);
const fixtures = [];
for (const item of manifest.value) {
  const path = portable(item.path).replace('$OFFICE_PERF_EVIDENCE/', '');
  const bytes = await readFile(resolve(root, path));
  assert.equal(hash(bytes), item.sha256, `Fixture manifest mismatch: ${path}`);
  fixtures.push({ ...portable(item), path, sample: item.tier === 'small' ? 'simple' : item.tier,
    hashVerifiedAgainstManifest: true, role: item.variant === 'a' ? 'native cohort candidate' : 'browser sibling; not the native simple/complex switch target' });
}
const workspace = runs[0].workspace.replace('$OFFICE_PERF_EVIDENCE/', '');
for (const sample of ['simple', 'complex', 'large']) for (const format of ['docx', 'pptx', 'xlsx', 'md']) {
  const path = `${workspace}/Performance/${sample}.${format}`, bytes = await readFile(resolve(root, path)), sha256 = hash(bytes);
  const match = fixtures.find(fixture => fixture.sha256 === sha256);
  fixtures.push({ path, format, sample, bytes: bytes.length, sha256, role: 'current workspace file, not a historical snapshot assertion', matchesManifestId: match?.id ?? null,
    provenance: format === 'md' ? 'Synthetic Markdown already present in prepared native workspace; no historical generator/manifest recorded' : match ? `native-fixtures-v2 manifest:${match.id}` : 'No matching v2 fixture hash; historical native content not inferred' });
}
const invalidPath = 'baseline-native-release-formal/invalid-large-word.json', invalid = await load(invalidPath);
const excluded = [];
for (const file of invalid.value.files) {
  const path = `baseline-native-release-formal/${file}`, raw = await load(path);
  excluded.push({ source: path, rawSha256: raw.sha256, reason: invalid.value.reason, replacement: invalid.value.replacement });
}
const output = portable({ schemaVersion: 5, date: '2026-10-19', issue: 191, parentIssue: 118,
  scope: 'native ProjectFileContent shell (not full application startup)', mode: 'release', evidenceRoot: '$OFFICE_PERF_EVIDENCE',
  qualification: {
    statistics: 'All finite raw ms from explicitly selected formal runs, including over_budget and any recorded failures with separate validityIssues; no rounding, trimming or outlier removal. Median uses midpoint for even n; p95 is nearest rank ceil(0.95*n). refs align with rawms.',
    processAndCache: 'Matrix declares serial fresh native processes, visible incognito WebViews, OS caches retained. This is process-cold, not machine/OS-cache-cold. Machine/cache facts are copied from matrices, not inferred from the generator host.',
    acceptance: 'Performance readiness only. Optional autosave/edit/race/history/Workspace acceptance is not established by this artifact.',
    clocks: 'shell/document performance marks use separate document time origins; no cross-document subtraction. null marks means field absent; [] means captured with no matching marks.',
    workerJoin: 'Request IDs and both independent cumulative clocks retained from logs. No ordering-based join to JS commands without shared requestId. Parallel/overlapping phase durations are not added.',
    fixtures: 'V2 manifest and present fixture bytes verified. Native raw reports do not persist source-byte hashes; matching current workspace bytes does not prove historical bytes. Corrected large Word selected explicitly.',
  },
  stages: { baseline: 'Selected historical baseline, 44 runs', after: afterXlsxActionsDirectory ? 'Native Verified Word/PPT/MD 33 runs plus explicit XLSX actions 11 runs; separate binaries/sources retained' : 'Final four-format Native Verified production matrix, 44 runs',
    ...(afterXlsxActionsDirectory ? { 'after-before-actions': 'Previous Native Verified XLSX 11 runs, excluded from main comparison' } : {}),
    'after-prior': 'Earlier three-format formal matrix, 33 runs; retained as its own stage and excluded from main comparison',
    'after-probe-not-formal': 'Word 1499ms cold-open probe, one run; excluded from all formal groups',
    'after-xlsx-probe-not-formal': 'Native Final XLSX complex probe, three runs; excluded from all formal groups' },
  coverage, pending,
  selection: selections.map(([label, directory]) => ({ label, directory })),
  excluded: { rationaleSource: invalidPath, rationaleSha256: invalid.sha256, runs: excluded,
    otherDirectories: 'Not enumerated or pooled: only the explicit allowlist above enters formal statistics. Non-formal Word 1499ms and three Native Final XLSX probes remain in runs with formal:false.' },
  development: developmentEvidence, startup: startupEvidence, experiments: experimentEvidence,
  fixtureManifest: { source: manifestPath, sha256: manifest.sha256 }, fixtures, sources,
  groups: finishGroups(grouped, ['label', 'format', 'sample', 'scenario']),
  probeGroups: finishGroups(probeGrouped, ['label', 'format', 'sample', 'scenario']),
  commandGroups: finishGroups(commandGroups, ['label', 'format', 'sample', 'scenario', 'name']),
  workerPhaseGroups: finishGroups(workerGroups, ['label', 'format', 'sample', 'clock', 'phase']), runs,
});
const json = JSON.stringify(output) + '\n';
assert.ok(!json.includes('/Users/'), 'Personal absolute path leaked');
assert.ok(Buffer.byteLength(json) < 2_800_000, 'Compact evidence unexpectedly exceeds 2.8 MB');
assert.equal(new Set(runs.map(run => run.source)).size, runs.length, 'Duplicate raw source');
assert.equal(output.groups.filter(group => group.label === 'after' && group.format === 'xlsx').length, 15);
await writeFile(new URL('./native-release-20261019.json', import.meta.url), json);
console.log(JSON.stringify({ bytes: Buffer.byteLength(json), coverage, pending, formalRuns: runs.filter(run => run.formal).length, nonFormalRuns: runs.filter(run => !run.formal).length, scenarioGroups: output.groups.length, developmentCoverage: output.development.coverage, startupCoverage: output.startup.coverage, experimentCoverage: output.experiments.coverage, workerRequests: runs.reduce((n, run) => n + run.workerRequests.length, 0) }));
