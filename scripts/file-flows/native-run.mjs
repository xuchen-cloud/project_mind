/** Running this file launches a visible native app. It never builds or reuses a Workspace. */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { assertReport } from './contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(binary|out|hold|timeout)=(.+)$/.exec(arg);
  if (!match) throw Error('Use --binary=PATH [--out=NEW_TEMP_DIR] [--hold=SECONDS] [--timeout=MS]');
  return [match[1], match[2]];
}));
if (process.platform !== 'darwin') throw Error('This runner requires real macOS');
if (!options.binary || !isAbsolute(options.binary)) throw Error('Pass an absolute --binary= opt-in measurement build');
const binary = await realpath(options.binary);
const binaryBytes = await readFile(binary);
if (!['PROJECT_MIND_OFFICE_PERFORMANCE', 'PROJECT_MIND_APP_DATA_DIR', 'scripts/office-performance/native.html']
  .every(marker => binaryBytes.includes(Buffer.from(marker))))
  throw Error('Binary lacks the opt-in isolated measurement host; refusing to launch');
const timeoutMs = Number(options.timeout ?? 180000), holdMs = Number(options.hold ?? 3) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || !Number.isFinite(holdMs) || holdMs < 0)
  throw Error('Invalid timeout or hold');
const temporary = await realpath(tmpdir());
const inside = (parent, child) => { const part = relative(parent, child); return part !== '' && !part.startsWith('..') && !isAbsolute(part); };
let out;
if (options.out) {
  const requested = resolve(options.out), parent = await realpath(dirname(requested));
  if (![temporary, await realpath('/tmp')].some(base => parent === base || inside(base, parent)))
    throw Error('--out must be a new directory below macOS temporary storage');
  await mkdir(join(parent, requested.split('/').at(-1))); // deliberately fails on reuse
  out = await realpath(requested);
} else out = await realpath(await mkdtemp(join(temporary, 'project-mind-file-flows-')));
const workspaceRoot = join(out, 'workspace'), appData = join(out, 'app-data');
const assistantData = join(out, 'assistant-data'), assistantProfile = join(out, 'assistant-profile');
await mkdir(appData);
await mkdir(assistantData);
await mkdir(assistantProfile);
await mkdir(join(out, 'incoming'));
const token = randomBytes(24).toString('hex');
let child, report, seeded = false, logs = '', fatal, stopTimer, forceTimer;
const stop = () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  forceTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
};
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (request.method === 'OPTIONS') { response.end(); return; }
  if (request.method !== 'POST' || !request.url?.startsWith(`/${token}/`)) { response.writeHead(404); response.end(); return; }
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 4 * 1024 * 1024) throw Error('Report too large'); }
    const input = JSON.parse(body), endpoint = request.url.slice(token.length + 2);
    let result;
    if (endpoint === 'fixtures') {
      if (seeded) throw Error('Fixture setup already consumed');
      const source = await realpath(input.sourceRoot), destination = await realpath(input.destinationRoot);
      if (source === destination || !inside(workspaceRoot, source) || !inside(workspaceRoot, destination))
        throw Error('Native Project roots must belong to the fresh Workspace');
      seeded = true;
      const originals = {
        'move.md': '# Move target\n', 'failed-save.md': '# Save conflict target\n',
        'replace.md': '# Replacement target\n', 'unrelated.md': '# Unrelated content\n',
      };
      for (const [name, text] of Object.entries(originals)) await writeFile(join(source, name), text, { flag: 'wx' });
      const replacement = '# Native replacement\nGenerated exclusively for G14 acceptance.\n';
      const replacementPath = join(out, 'incoming', 'replacement.md');
      await writeFile(replacementPath, replacement, { flag: 'wx' });
      result = { originals, replacement, replacementPath };
      await writeFile(join(out, 'fixtures.json'), JSON.stringify({ ...input, ...result }, null, 2));
    } else if (endpoint === 'snapshot') {
      if (!seeded) throw Error('Fixture setup missing');
      result = JSON.parse(execFileSync('python3', [join(root, 'scripts/file-flows/snapshot.py'), out, JSON.stringify(input.ids)], { encoding: 'utf8', timeout: 10000 }));
    } else if (endpoint === 'result') {
      if (report) throw Error('Final report already recorded');
      report = input;
      await writeFile(join(out, 'acceptance.json'), JSON.stringify({ ...input, runner: {
        binary, binarySha256: createHash('sha256').update(binaryBytes).digest('hex'),
        harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        workspaceRoot, appData, assistantData, assistantProfile, output: out, platform: process.platform,
      } }, null, 2));
      try { assertReport(report); } catch (error) { fatal = error; }
      result = { recorded: true };
      stopTimer = setTimeout(stop, holdMs);
    } else throw Error('Unknown endpoint');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const controlUrl = `http://127.0.0.1:${server.address().port}/${token}`;
const config = { page: 'file-flows', workspaceRoot, controlUrl, visible: true };
console.log(`Launching isolated native acceptance; evidence: ${out}`);
const timer = setTimeout(() => { fatal = Error('Native acceptance timed out'); stop(); }, timeoutMs);
try {
  child = spawn(binary, [], { cwd: root, env: { ...process.env, PROJECT_MIND_APP_DATA_DIR: appData,
    PROJECT_MIND_DSH_USER_DATA: assistantData, PROJECT_MIND_DSH_PROFILE_DIR: assistantProfile,
    PROJECT_MIND_OFFICE_PERFORMANCE: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
} finally {
  clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(forceTimer); server.close();
  await writeFile(join(out, 'native.log'), logs);
}
if (fatal) throw fatal;
assertReport(report);
console.log(`Passed native component + IPC assertions: ${join(out, 'acceptance.json')}`);
