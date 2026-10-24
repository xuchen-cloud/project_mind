import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { checksum } from './record-worker-notices.mjs';
import { desktopRuntimeTarget } from './desktop-runtime-target.mjs';
import { dshNoticeAssets, prepareDshProduction, stageDshRuntime, verifyDshDistribution } from './stage-dsh-runtime.mjs';

const exec = promisify(execFile);
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const json = (file, value) => put(file, JSON.stringify(value));
const linkDirectory = (target, link) => symlink(
  process.platform === 'win32' ? path.resolve(path.dirname(link), target) : target,
  link,
  process.platform === 'win32' ? 'junction' : 'dir',
);
const bundledSkills = {
  'project-mind-cli/SKILL.md': '---\nname: project-mind-cli\ndescription: Use mind CLI.\n---\n',
  'project-mind-cli/references/usage.md': 'CLI reference',
  'future-builtin/SKILL.md': 'Another builtin skill',
  'future-builtin/assets/template.bin': Buffer.from([0, 255, 10]),
};
// Windows cannot retain the POSIX execute bits required by Darwin spawn-helper.
const fixturePlatform = process.platform === 'win32' ? 'linux' : 'darwin';
const fixtureTarget = `${fixturePlatform}-x64`;
const fixtureOtherTarget = `${fixturePlatform}-arm64`;
const mismatchedTarget = process.platform === 'win32' ? 'win-x64' : 'darwin-arm64';
const browser = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html';

async function fixture(t) {
  const repository = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mind-dsh-staging-')));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const source = path.join(repository, 'packages/dsh-assistant');
  const production = path.join(repository, 'production');
  const destination = path.join(repository, 'src-tauri/resources/dsh-assistant');
  const shared = path.join(repository, 'src-tauri/resources/agent-host');
  const target = desktopRuntimeTarget(process.platform === 'win32' ? 'x86_64-unknown-linux-gnu' : 'x86_64-apple-darwin', {});
  const dependencies = { '@deepseek-ai/dsh-web-frontend': '1.0.0', 'dsh-desktop-client-ui': 'file:vendor/dsh-desktop-client-ui', 'node-pty': '1.2.0-beta.15' };
  const lock = { lockfileVersion: 3, packages: { '': { dependencies },
    'node_modules/@deepseek-ai/dsh-web-frontend': { version: '1.0.0' },
    'node_modules/dsh-desktop-client-ui': { link: true, resolved: 'vendor/dsh-desktop-client-ui' },
    'vendor/dsh-desktop-client-ui': { version: '0.1.0' },
    'node_modules/node-pty': { version: '1.2.0-beta.15' },
    [`node_modules/@fixture/${fixtureTarget}`]: { version: '1.0.0', optional: true, os: [fixturePlatform], cpu: ['x64'] },
    [`node_modules/@fixture/${fixtureOtherTarget}`]: { version: '1.0.0', optional: true, os: [fixturePlatform], cpu: ['arm64'] },
    'node_modules/dev-only': { version: '1.0.0', dev: true },
  } };
  await json(path.join(source, 'package.json'), { name: 'fixture-dsh', type: 'module', dependencies });
  await json(path.join(source, 'package-lock.json'), lock);
  await json(path.join(source, 'upstream.json'), { commit: 'pinned-upstream' });
  await put(path.join(source, 'config/desktop.patch.yml'), '[]\n');
  await put(path.join(source, 'scripts/isolation.mjs'), 'export const isolated = true;');
  await put(path.join(source, 'scripts/skills.mjs'), 'export const bundledSkillEnvironment = {};');
  await put(path.join(source, 'scripts/builtin-skills.mjs'), 'export const prepareBundledSkills = async () => {};');
  await put(path.join(source, 'scripts/skill-management.mjs'), 'export const manageSkill = async () => {};');
  await put(path.join(source, 'scripts/shared-model.mjs'), 'export const mainModel = true;');
  await put(path.join(source, 'scripts/runtime.mjs'), `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { brand } from 'dsh-desktop-client-ui';
const root = fileURLToPath(new URL('..', import.meta.url));
const cwd = path.join(process.env.DSH_HOME, 'workspace');
await mkdir(cwd, {recursive:true}); process.chdir(cwd);
console.log(JSON.stringify({anchor:path.join(root,'package.json'), cwd:process.cwd(), brand, browser:await readFile(path.join(root,'${browser}'),'utf8')}));`);
  await json(path.join(source, 'vendor/dsh-desktop-client-ui/package.json'), { name: 'dsh-desktop-client-ui', version: '0.1.0', type: 'module', main: 'index.js', license: 'MIT' });
  await put(path.join(source, 'vendor/dsh-desktop-client-ui/index.js'), "export const brand = 'DSH';");
  await put(path.join(source, 'vendor/dsh-desktop-client-ui/LICENSE'), 'MIT vendor license');
  for (const cache of ['.upstream', '.downloads', '.acceptance']) {
    await put(path.join(source, cache, 'secret'), 'source-only');
    await put(path.join(source, 'scripts', cache, 'secret'), 'source-only');
  }
  await put(path.join(source, 'scripts/model-utility-entry.mjs'), 'export {};');
  await put(path.join(source, 'scripts/model-utility.mjs'), 'export {};');
  await put(path.join(source, 'node_modules/dev-only/index.js'), 'never ship source dependencies');
  for (const [name, contents] of Object.entries(bundledSkills)) await put(path.join(source, 'skills', name), contents);
  await put(path.join(repository, 'user-home/.agents/skills/private/SKILL.md'), 'user-local skill');
  await cp(source, production, { recursive: true });
  await rm(path.join(production, 'node_modules'), { recursive: true });
  for (const [name, os, cpu] of [
    ['@deepseek-ai/dsh-web-frontend'], ['node-pty'],
    [`@fixture/${fixtureTarget}`, [fixturePlatform], ['x64']], [`@fixture/${fixtureOtherTarget}`, [fixturePlatform], ['arm64']],
  ]) {
    const root = path.join(production, 'node_modules', name);
    await json(path.join(root, 'package.json'), { name, version: lock.packages[`node_modules/${name}`].version, license: 'MIT', os, cpu });
    await put(path.join(root, 'LICENSE'), `MIT ${name}`);
  }
  await put(path.join(production, browser), '<html>DSH browser</html>');
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['x64', 'arm64']) {
      const prebuilt = path.join(production, 'node_modules/node-pty/prebuilds', `${platform}-${arch}`);
      const names = platform === 'win32'
        ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
        : platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
      for (const name of names) await put(path.join(prebuilt, name), `${platform}-${arch}/${name}`);
      if (platform === 'darwin') await chmod(path.join(prebuilt, 'spawn-helper'), 0o755);
    }
  }
  await linkDirectory('../vendor/dsh-desktop-client-ui', path.join(production, 'node_modules/dsh-desktop-client-ui'));
  await put(path.join(shared, 'node'), 'shared-pinned-node');
  await put(path.join(shared, 'dist/record-document-worker.mjs'), 'keep-record');
  await json(path.join(repository, 'packages/agent-host/runtime-manifest.json'), { nodeVersion: '24.21.0', targets: { [fixtureTarget]: { sha256: 'pinned-archive' } } });
  await json(path.join(shared, 'runtime.json'), { target: fixtureTarget, nodeVersion: '24.21.0', sourceArchiveChecksum: 'pinned-archive', nodeChecksum: checksum('shared-pinned-node') });
  return { repository, source, production, destination, shared, target, lock };
}

test('fresh DSH preparation copies vendor before target npm ci and excludes source caches and node_modules', async t => {
  const f = await fixture(t);
  const fresh = path.join(f.repository, 'fresh');
  await prepareDshProduction(f.source, fresh, f.target, async (command, args, cwd) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${fixturePlatform}`, '--cpu=x64']);
    assert.equal(cwd, fresh);
    assert.equal(await readFile(path.join(cwd, 'vendor/dsh-desktop-client-ui/index.js'), 'utf8'), "export const brand = 'DSH';");
    for (const [name, contents] of Object.entries(bundledSkills)) {
      assert.deepEqual(await readFile(path.join(cwd, 'skills', name)), Buffer.from(contents));
    }
    await assert.rejects(lstat(path.join(cwd, 'node_modules')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(path.join(cwd, 'scripts')), ['builtin-skills.mjs', 'isolation.mjs', 'model-utility-entry.mjs', 'model-utility.mjs', 'runtime.mjs', 'shared-model.mjs', 'skill-management.mjs', 'skills.mjs']);
    await put(path.join(cwd, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'), 'fresh-helper');
    await put(path.join(cwd, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 'other-target');
  });
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(fresh, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(fresh, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'))).mode & 0o111, 0);
});

test('DSH staging preserves imports/browser and independent home, selects target dependencies, licenses and shared Node', async t => {
  const f = await fixture(t);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const verified = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.equal(verified.manifest.node.executable, '../agent-host/node');
  assert.deepEqual(verified.manifest.packages.map(pkg => pkg.name), ['@deepseek-ai/dsh-web-frontend', `@fixture/${fixtureTarget}`, 'dsh-desktop-client-ui', 'node-pty']);
  assert.equal((await lstat(path.join(f.destination, 'node_modules/dsh-desktop-client-ui'))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(f.destination, 'scripts/shared-model.mjs'), 'utf8'), 'export const mainModel = true;');
  if (fixturePlatform === 'darwin') assert.equal((await lstat(path.join(f.destination, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'))).mode & 0o111, 0o111);
  for (const name of ['node', 'node.exe', '.upstream', '.downloads', '.acceptance', 'node_modules/dev-only', `node_modules/@fixture/${fixtureOtherTarget}`]) {
    await assert.rejects(lstat(path.join(f.destination, name)), { code: 'ENOENT' });
  }
  assert.match(await readFile(path.join(f.destination, 'DSH-THIRD-PARTY-NOTICES.txt'), 'utf8'), /DSH Assistant production dependencies/);
  assert.equal(await readFile(path.join(f.shared, 'dist/record-document-worker.mjs'), 'utf8'), 'keep-record');
  const home = path.join(f.repository, 'independent-home');
  const { stdout } = await exec(process.execPath, [path.join(f.destination, 'scripts/runtime.mjs')], { cwd: os.tmpdir(), env: { ...process.env, DSH_HOME: home } });
  assert.deepEqual(JSON.parse(stdout), { anchor: path.join(f.destination, 'package.json'), cwd: path.join(home, 'workspace'), brand: 'DSH', browser: '<html>DSH browser</html>' });
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  assert.equal((await verifyDshDistribution(f.destination, fixtureTarget)).manifestChecksum, verified.manifestChecksum);
  await put(path.join(f.destination, 'unlisted.txt'), 'unlisted');
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /inventory differs/);
  await rm(path.join(f.destination, 'unlisted.txt'));
  await put(path.join(f.destination, browser), 'tampered');
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /inventory differs/);
});

test('node-pty staging retains only target prebuilds and preserves all other package files', async t => {
  const f = await fixture(t);
  const location = 'node_modules/node-pty';
  const retained = {
    'lib/utils.js': 'official loader',
    'lib/windowsTerminal.js': 'official Windows implementation',
    'lib/unixTerminal.js': 'official Unix implementation',
    'src/unix/pty.cc': 'upstream native source',
    'README.md': 'upstream documentation',
    'third_party/conpty/LICENSE': 'upstream third-party license',
    [`prebuilds/${fixtureTarget}/resources/extra.bin`]: Buffer.from([0, 255, 10]),
  };
  for (const [name, contents] of Object.entries(retained)) await put(path.join(f.production, location, name), contents);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.deepEqual(await readdir(path.join(f.destination, location, 'prebuilds')), [fixtureTarget]);
  for (const [name, contents] of Object.entries(retained)) {
    assert.deepEqual(await readFile(path.join(f.destination, location, name)), Buffer.from(contents));
    assert.ok(manifest.files.some(entry => entry.file === `${location}/${name}`));
  }
  assert.equal(await readFile(path.join(f.destination, location, 'LICENSE'), 'utf8'), 'MIT node-pty');
  assert.deepEqual((await readdir(path.join(f.production, location, 'prebuilds'))).sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
});

test('arm64 and Linux staging select the release target and fail if its node-pty prebuild is missing', async t => {
  for (const target of ['darwin-arm64', 'linux-x64']) await t.test(target, {
    skip: target.startsWith('darwin-') && process.platform === 'win32'
      ? 'Darwin spawn-helper requires POSIX execute bits unavailable on Windows' : false,
  }, async t => {
    const f = await fixture(t);
    await json(path.join(f.repository, 'packages/agent-host/runtime-manifest.json'), {
      nodeVersion: '24.21.0', targets: { [target]: { sha256: 'pinned-archive' } },
    });
    await json(path.join(f.shared, 'runtime.json'), {
      target, nodeVersion: '24.21.0', sourceArchiveChecksum: 'pinned-archive', nodeChecksum: checksum('shared-pinned-node'),
    });
    await stageDshRuntime(f.repository, target, f.production);
    const verified = await verifyDshDistribution(f.destination, target);
    const prebuilds = 'node_modules/node-pty/prebuilds';
    assert.deepEqual(await readdir(path.join(f.destination, prebuilds)), [target]);
    assert.equal(await readFile(path.join(f.destination, prebuilds, target, 'pty.node'), 'utf8'), `${target}/pty.node`);
    if (target.startsWith('darwin-')) {
      assert.equal((await lstat(path.join(f.destination, prebuilds, target, 'spawn-helper'))).mode & 0o111, 0o111);
    }
    await rm(path.join(f.production, prebuilds, target), { recursive: true });
    await assert.rejects(stageDshRuntime(f.repository, target, f.production), { code: 'ENOENT' });
    assert.equal((await verifyDshDistribution(f.destination, target)).manifestChecksum, verified.manifestChecksum);
  });
});

test('verification rejects non-target node-pty prebuilds even with a matching manifest inventory', async t => {
  const f = await fixture(t);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  const file = 'node_modules/node-pty/prebuilds/win32-arm64/conpty.node';
  await put(path.join(f.destination, file), 'unexpected prebuild');
  const files = [...manifest.files, { file, checksum: checksum('unexpected prebuild'), executable: false }]
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  await json(path.join(f.destination, 'dsh-distribution.json'), { ...manifest, files });
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /non-target node-pty prebuild/);
});

test('all bundled skills and resources ship with verified inventory; required skill is mandatory', async t => {
  const f = await fixture(t);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.deepEqual(manifest.files.filter(entry => entry.file.startsWith('skills/')).map(entry => entry.file).sort(),
    Object.keys(bundledSkills).map(name => `skills/${name}`).sort());
  for (const [name, contents] of Object.entries(bundledSkills)) {
    const entry = manifest.files.find(entry => entry.file === `skills/${name}`);
    assert.equal(entry.checksum, checksum(contents));
    assert.deepEqual(await readFile(path.join(f.destination, 'skills', name)), Buffer.from(contents));
  }
  assert.deepEqual((await readdir(path.join(f.destination, 'skills'))).sort(), ['future-builtin', 'project-mind-cli']);
  for (const module of ['scripts/builtin-skills.mjs', 'scripts/skill-management.mjs']) {
    assert.ok(manifest.files.some(entry => entry.file === module));
    const contents = await readFile(path.join(f.production, module));
    await rm(path.join(f.production, module));
    await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
    await writeFile(path.join(f.production, module), contents);
    await verifyDshDistribution(f.destination, fixtureTarget);
  }
  const resource = path.join(f.destination, 'skills/future-builtin/assets/template.bin');
  await put(resource, 'tampered');
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /inventory differs/);
  await writeFile(resource, bundledSkills['future-builtin/assets/template.bin']);
  const reference = path.join(f.destination, 'skills/project-mind-cli/references/usage.md');
  await rm(reference);
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /inventory differs/);
  await writeFile(reference, bundledSkills['project-mind-cli/references/usage.md']);
  await put(path.join(f.destination, 'skills/unlisted/SKILL.md'), 'unlisted skill');
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /inventory differs/);
  await rm(path.join(f.destination, 'skills/unlisted'), { recursive: true });
  await rm(path.join(f.production, 'skills/project-mind-cli/SKILL.md'));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
  await verifyDshDistribution(f.destination, fixtureTarget);
  await rm(path.join(f.production, 'scripts/skills.mjs'));
  await put(path.join(f.production, 'skills/project-mind-cli/SKILL.md'), bundledSkills['project-mind-cli/SKILL.md']);
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
  await verifyDshDistribution(f.destination, fixtureTarget);
  // Even a self-consistent inventory cannot omit the required builtin entrypoint.
  await rm(path.join(f.destination, 'skills/project-mind-cli/SKILL.md'));
  await json(path.join(f.destination, 'dsh-distribution.json'), {
    ...manifest, files: manifest.files.filter(entry => entry.file !== 'skills/project-mind-cli/SKILL.md'),
  });
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), { code: 'ENOENT' });
});

test('staging rejects wrong shared target, mismatched locks, missing browser, wrong required CPU, and leaves prior release intact', async t => {
  const f = await fixture(t);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  await assert.rejects(verifyDshDistribution(f.destination, mismatchedTarget), /target mismatch/);
  const receiptPath = path.join(f.shared, 'runtime.json');
  const receipt = await readFile(receiptPath);
  await json(receiptPath, { ...JSON.parse(receipt), target: mismatchedTarget });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /same target/);
  await writeFile(receiptPath, receipt);
  await json(path.join(f.production, 'package-lock.json'), { ...f.lock, changed: true });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /differs from repository/);
  await copyFile(path.join(f.source, 'package-lock.json'), path.join(f.production, 'package-lock.json'));
  await rm(path.join(f.production, browser));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
  await verifyDshDistribution(f.destination, fixtureTarget);
  await put(path.join(f.production, browser), '<html>DSH browser</html>');
  await json(path.join(f.production, 'node_modules/@deepseek-ai/dsh-web-frontend/package.json'), { name: '@deepseek-ai/dsh-web-frontend', version: '1.0.0', license: 'MIT', cpu: ['arm64'] });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), new RegExp(`does not support ${fixtureTarget}`));
  await verifyDshDistribution(f.destination, fixtureTarget);
});

test('staging rejects dev packages and escaping vendor links from supplied production tree', async t => {
  const f = await fixture(t);
  await json(path.join(f.production, 'node_modules/dev-only/package.json'), { name: 'dev-only', version: '1.0.0' });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /production lockfile/);
  await rm(path.join(f.production, 'node_modules/dev-only'), { recursive: true });
  await rm(path.join(f.production, 'node_modules/dsh-desktop-client-ui'));
  await linkDirectory(path.join(f.source, 'vendor/dsh-desktop-client-ui'), path.join(f.production, 'node_modules/dsh-desktop-client-ui'));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /escapes/);
});

test('Windows staging uses shared node.exe and requires target ConPTY assets with scripts disabled', async t => {
  const f = await fixture(t);
  const pinnedPath = path.join(f.repository, 'packages/agent-host/runtime-manifest.json');
  await json(pinnedPath, { nodeVersion: '24.21.0', targets: { 'win-x64': { sha256: 'pinned-archive' } } });
  await json(path.join(f.shared, 'runtime.json'), { target: 'win-x64', nodeVersion: '24.21.0', sourceArchiveChecksum: 'pinned-archive', nodeChecksum: checksum('shared-pinned-node') });
  await copyFile(path.join(f.shared, 'node'), path.join(f.shared, 'node.exe'));
  const prebuilt = path.join(f.production, 'node_modules/node-pty/prebuilds/win32-x64');
  for (const name of ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) await put(path.join(prebuilt, name), name);
  await put(path.join(prebuilt, 'conpty/resources/extra.bin'), Buffer.from([0, 255, 10]));
  await stageDshRuntime(f.repository, 'win-x64', f.production);
  const { manifest } = await verifyDshDistribution(f.destination, 'win-x64');
  assert.equal(manifest.node.executable, '../agent-host/node.exe');
  assert.deepEqual(await readdir(path.join(f.destination, 'node_modules/node-pty/prebuilds')), ['win32-x64']);
  for (const name of await readdir(prebuilt, { recursive: true })) {
    if (!(await lstat(path.join(prebuilt, name))).isFile()) continue;
    const relative = `node_modules/node-pty/prebuilds/win32-x64/${name.split(path.sep).join('/')}`;
    assert.deepEqual(await readFile(path.join(f.destination, relative)), await readFile(path.join(prebuilt, name)));
    assert.ok(manifest.files.some(entry => entry.file === relative));
  }
  await rm(path.join(prebuilt, 'conpty/conpty.dll'));
  await assert.rejects(stageDshRuntime(f.repository, 'win-x64', f.production), { code: 'ENOENT' });
  await verifyDshDistribution(f.destination, 'win-x64');
});

test('nested locked production dependencies retain their files and licenses; missing required packages fail', async t => {
  const f = await fixture(t);
  const location = 'node_modules/node-pty/node_modules/fixture-nested';
  f.lock.packages[location] = { version: '2.0.0' };
  for (const root of [f.source, f.production]) await json(path.join(root, 'package-lock.json'), f.lock);
  await json(path.join(f.production, location, 'package.json'), { name: 'fixture-nested', version: '2.0.0', license: 'MIT' });
  await put(path.join(f.production, location, 'LICENSE'), 'nested license');
  await put(path.join(f.production, location, 'index.js'), 'nested implementation');
  await put(path.join(f.production, location, '.downloads/secret'), 'cache');
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.equal(manifest.packages.find(pkg => pkg.name === 'fixture-nested').version, '2.0.0');
  assert.equal(await readFile(path.join(f.destination, location, 'index.js'), 'utf8'), 'nested implementation');
  await assert.rejects(lstat(path.join(f.destination, location, '.downloads')), { code: 'ENOENT' });
  await rm(path.join(f.production, location), { recursive: true });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
});

test('license text is mandatory and receipt metadata is checked alongside file checksums', async t => {
  const f = await fixture(t);
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const receiptPath = path.join(f.destination, 'dsh-distribution.json');
  const receipt = JSON.parse(await readFile(receiptPath));
  await json(receiptPath, { ...receipt, lockfileChecksum: 'wrong' });
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /lockfile or notices/);
  await json(receiptPath, { ...receipt, packages: receipt.packages.slice(1) });
  await assert.rejects(verifyDshDistribution(f.destination, fixtureTarget), /license inventory/);
  await rm(path.join(f.production, 'node_modules/@deepseek-ai/dsh-web-frontend/LICENSE'));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /Missing third-party license text/);
});

test('Koffi target optional package and prebuilt are mandatory when Koffi is installed', async t => {
  const f = await fixture(t);
  f.lock.packages['node_modules/koffi'] = { version: '3.1.1' };
  for (const arch of ['x64', 'arm64']) {
    const location = `node_modules/@koromix/koffi-${fixturePlatform}-${arch}`;
    f.lock.packages[location] = { version: '3.1.1', optional: true, os: [fixturePlatform], cpu: [arch] };
    await json(path.join(f.production, location, 'package.json'), { name: `@koromix/koffi-${fixturePlatform}-${arch}`, version: '3.1.1', license: 'MIT', os: [fixturePlatform], cpu: [arch] });
    await put(path.join(f.production, location, 'LICENSE'), 'fixture Koffi license');
    await put(path.join(f.production, location, `${fixturePlatform}_${arch}/koffi.node`), 'fixture Koffi prebuilt');
  }
  for (const root of [f.source, f.production]) await json(path.join(root, 'package-lock.json'), f.lock);
  await json(path.join(f.production, 'node_modules/koffi/package.json'), { name: 'koffi', version: '3.1.1', license: 'MIT' });
  await put(path.join(f.production, 'node_modules/koffi/LICENSE'), 'fixture Koffi license');
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.ok(manifest.files.some(entry => entry.file === `node_modules/@koromix/koffi-${fixturePlatform}-x64/${fixturePlatform}_x64/koffi.node`));
  await assert.rejects(lstat(path.join(f.destination, `node_modules/@koromix/koffi-${fixturePlatform}-arm64`)), { code: 'ENOENT' });
  await rm(path.join(f.production, `node_modules/@koromix/koffi-${fixturePlatform}-x64/${fixturePlatform}_x64/koffi.node`));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /Missing DSH Koffi prebuilt/);
  await rm(path.join(f.production, `node_modules/@koromix/koffi-${fixturePlatform}-x64`), { recursive: true });
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), { code: 'ENOENT' });
});

test('pinned omitted licenses retain original attribution and clearly labeled SPDX references', async t => {
  const f = await fixture(t);
  const root = path.join(f.repository, 'license-fixture');
  await json(path.join(root, 'package.json'), { name: '@img/sharp-libvips-darwin-arm64', version: '1.3.4', license: 'LGPL-3.0-or-later' });
  await put(path.join(root, 'README.md'), 'Published libvips runtime attribution');
  const reference = await dshNoticeAssets([root]);
  assert.match(reference.notices, /SPDX reference text \(template, not an upstream copyright notice\)/);
  assert.match(reference.notices, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(reference.notices, /Published libvips runtime attribution/);
  await json(path.join(root, 'package.json'), { name: '@earendil-works/pi-ai', version: '0.87.1', license: 'MIT' });
  const pi = await dshNoticeAssets([root]);
  assert.match(pi.notices, /Copyright \(c\) 2025 Mario Zechner/);
  assert.match(pi.notices, /f07218c4d4bbc12bef056a7058c3dd49dfe41abe/);
  assert.match(pi.notices, /DSH Assistant production dependencies/);
});

test('license fallback refuses unknown SPDX, unknown packages, and unverified versions', async t => {
  const f = await fixture(t);
  const root = path.join(f.repository, 'unknown-license');
  for (const pkg of [
    { name: '@earendil-works/pi-ai', version: '0.87.1', license: 'LicenseRef-Unknown' },
    { name: '@earendil-works/pi-ai', version: '9.0.0', license: 'MIT' },
    { name: 'unverified-package', version: '1.0.0', license: 'MIT' },
  ]) {
    await json(path.join(root, 'package.json'), pkg);
    await assert.rejects(dshNoticeAssets([root]), /license mismatch|Missing third-party license text/);
  }
});

test('staging materializes the pinned scoped web bundle and includes its MIT attribution', async t => {
  const f = await fixture(t);
  const location = 'node_modules/@deepseek-ai/dsh-web-app';
  const vendor = 'vendor/dsh-web-app';
  f.lock.packages[location] = { resolved: vendor, link: true };
  f.lock.packages[vendor] = { version: '0.2.0-rc.2' };
  for (const root of [f.source, f.production]) {
    await json(path.join(root, 'package-lock.json'), f.lock);
    await json(path.join(root, vendor, 'package.json'), { name: '@deepseek-ai/dsh-web-app', version: '0.2.0-rc.2', license: 'MIT', type: 'module', main: 'lib/index.js' });
    await put(path.join(root, vendor, 'LICENSE'), 'MIT Copyright (c) 2026 DeepSeek');
    await put(path.join(root, vendor, 'lib/index.js'), "export const name = 'web-app';");
  }
  await linkDirectory(path.join(f.production, vendor), path.join(f.production, location));
  await stageDshRuntime(f.repository, fixtureTarget, f.production);
  const { manifest } = await verifyDshDistribution(f.destination, fixtureTarget);
  assert.equal((await lstat(path.join(f.destination, location))).isSymbolicLink(), false);
  assert.equal((await import(pathToFileURL(path.join(f.destination, location, 'lib/index.js')).href)).name, 'web-app');
  assert.ok(manifest.packages.some(pkg => pkg.name === '@deepseek-ai/dsh-web-app' && pkg.version === '0.2.0-rc.2'));
  assert.match(await readFile(path.join(f.destination, 'DSH-THIRD-PARTY-NOTICES.txt'), 'utf8'), /Copyright \(c\) 2026 DeepSeek/);
  await rm(path.join(f.production, location));
  await linkDirectory(path.join(f.source, vendor), path.join(f.production, location));
  await assert.rejects(stageDshRuntime(f.repository, fixtureTarget, f.production), /escapes/);
});
