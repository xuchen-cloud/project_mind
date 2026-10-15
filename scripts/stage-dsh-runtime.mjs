import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DESKTOP_RUNTIME_TARGETS } from './desktop-runtime-target.mjs';
import { checksum, packageNoticeAssets } from './record-worker-notices.mjs';

const sourceNames = ['scripts', 'config', 'vendor', 'skills', 'package.json', 'package-lock.json', 'upstream.json'];
const manifestName = 'dsh-distribution.json';
const browserIndex = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html';
const excluded = new Set(['.upstream', '.downloads', '.acceptance']);
const targetFor = runtimeTarget => {
  const target = Object.values(DESKTOP_RUNTIME_TARGETS).find(entry => entry.runtimeTarget === runtimeTarget);
  if (!target) throw new Error(`Unsupported DSH runtime target: ${runtimeTarget}`);
  return target;
};
const supports = (values, value) => !values || (!values.includes(`!${value}`)
  && (!values.some(item => !item.startsWith('!')) || values.includes(value)));

const licenseDirectory = fileURLToPath(new URL('./dsh-runtime-licenses/', import.meta.url));
const licenseSupplements = {
  '@aws-sdk/credential-provider-http@3.972.75': ['Apache-2.0', '../vendor-licenses/aws-sdk-js-v3.LICENSE'],
  '@aws-sdk/credential-provider-login@3.972.80': ['Apache-2.0', '../vendor-licenses/aws-sdk-js-v3.LICENSE'],
  '@aws-sdk/nested-clients@3.997.47': ['Apache-2.0', '../vendor-licenses/aws-sdk-js-v3.LICENSE'],
  '@earendil-works/pi-ai@0.87.1': ['MIT', 'pi-0.87.1.LICENSE'],
  '@earendil-works/pi-telemetry@0.87.1': ['MIT', 'pi-0.87.1.LICENSE'],
  '@xterm/addon-serialize@0.14.0': ['MIT', 'xterm-6.0.0.LICENSE'],
  '@xterm/headless@6.0.0': ['MIT', 'xterm-6.0.0.LICENSE'],
  'brotli@1.3.3': ['MIT', 'SPDX-MIT.txt', '../vendor-licenses/aws-sdk-js-v3.LICENSE'],
  'dfa@1.2.0': ['MIT', 'SPDX-MIT.txt'],
  'fontkit@2.0.4': ['MIT', 'SPDX-MIT.txt'],
  'saxes@6.0.0': ['ISC', 'saxes-6.0.0.LICENSE'],
};
for (const target of Object.values(DESKTOP_RUNTIME_TARGETS)) {
  licenseSupplements[`@koromix/koffi-${target.platform}-${target.arch}@3.1.1`] = ['MIT', 'koffi-3.1.1.LICENSE'];
  if (target.platform !== 'win32') licenseSupplements[`@img/sharp-libvips-${target.platform}-${target.arch}@1.3.4`]
    = ['LGPL-3.0-or-later', 'SPDX-LGPL-3.0-or-later.txt', 'SPDX-GPL-3.0-or-later.txt', 'sharp-libvips-1.3.4.NOTICES'];
}

// Reuse the strict collector with temporary notice inputs for exact pinned
// packages whose npm archives omit root license files. These inputs never
// modify dependencies, and their complete text lands in the release notices.
export async function dshNoticeAssets(roots) {
  const sources = JSON.parse(await readFile(path.join(licenseDirectory, 'sources.json')));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mind-dsh-notices-'));
  try {
    const inputs = [];
    for (const [index, root] of roots.entries()) {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
      const nestedOffice = /^@deepseek-ai\/libreoffice-kit-(?:darwin-(?:arm64|x64)|win32-x64)$/.test(pkg.name)
        && pkg.version === '0.1.5' && pkg.license === 'MPL-2.0';
      const supplement = licenseSupplements[`${pkg.name}@${pkg.version}`];
      const hasRootNotice = (await readdir(root)).some(name => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name));
      if (hasRootNotice || (!nestedOffice && !supplement)) { inputs.push(root); continue; }
      if (supplement && pkg.license !== supplement[0]) throw new Error(`DSH supplement license mismatch: ${pkg.name}@${pkg.version}`);
      const sections = [];
      const include = async name => {
        await regularFile(path.join(root, name));
        sections.push(`--- Published package file: ${name} ---\n${await readFile(path.join(root, name), 'utf8')}`);
      };
      if (nestedOffice) {
        for (const name of ['LibreOffice-MPL-2.0.txt', 'DeepSeek-Harness-MIT.txt', 'LibreOffice-third-party.html']) await regularFile(path.join(root, 'licenses', name));
        for (const name of (await readdir(path.join(root, 'licenses'))).sort()) await include(`licenses/${name}`);
        const prebuild = JSON.parse(await readFile(path.join(root, 'prebuilds.json')));
        const program = prebuild.engine.programDirectory;
        if (typeof program !== 'string' || path.posix.isAbsolute(program) || program.split('/').includes('..')) throw new Error('Invalid LibreOffice program license path');
        for (const name of ['LICENSE', 'NOTICE']) await include(`${program}/${name}`);
      } else {
        for (const file of supplement.slice(1)) {
          const source = sources.find(entry => entry.file === file);
          if (!source) throw new Error(`Missing DSH license source: ${file}`);
          const text = await readFile(path.join(licenseDirectory, file), 'utf8');
          if (checksum(text) !== source.sha256) throw new Error(`DSH license source checksum mismatch: ${file}`);
          const label = file.startsWith('SPDX-') ? 'SPDX reference text (template, not an upstream copyright notice)' : 'Source license/notice';
          sections.push(`--- ${label}: ${source.source} ---\n${text}`);
        }
        if (['brotli', 'dfa', 'fontkit'].includes(pkg.name)) {
          const readme = pkg.name === 'brotli' ? 'readme.md' : 'README.md';
          const text = await readFile(path.join(root, readme), 'utf8');
          const start = text.lastIndexOf('## License');
          if (start < 0 || !/^## License\s+MIT\s*$/.test(text.slice(start))) throw new Error(`Missing published MIT declaration: ${pkg.name}`);
          sections.push(`--- Published package file: ${readme} (License) ---\n${text.slice(start)}`);
        }
        if (pkg.name === 'brotli') {
          const decoder = await readFile(path.join(root, 'dec/decode.js'), 'utf8');
          if (!decoder.startsWith('/* Copyright 2013 Google Inc.') || !decoder.includes('*/')) throw new Error('Missing brotli decoder attribution');
          sections.push(`--- Published package file: dec/decode.js (Apache-2.0 notice) ---\n${decoder.slice(0, decoder.indexOf('*/') + 2)}`);
        }
        if (pkg.name.startsWith('@img/sharp-libvips-')) await include('README.md');
      }
      const proxy = path.join(temporary, String(index));
      await mkdir(proxy);
      await writeFile(path.join(proxy, 'package.json'), JSON.stringify(pkg));
      await writeFile(path.join(proxy, 'LICENSE-DSH-SUPPLEMENT.txt'), `Published package metadata:\n${JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, author: pkg.author, repository: pkg.repository }, null, 2)}\n\n${sections.join('\n\n')}`);
      inputs.push(proxy);
    }
    const assets = await packageNoticeAssets(inputs, 'DSH Assistant production dependencies');
    assets.notices = assets.notices.replace('in NODE-LICENSE.', 'in ../agent-host/NODE-LICENSE.');
    return assets;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function copyClean(source, destination, omitDependencies = false) {
  await cp(source, destination, { recursive: true, filter: async file => {
    const parts = path.relative(source, file).split(path.sep);
    if (parts.some(part => excluded.has(part)) || (omitDependencies && parts.includes('node_modules'))) return false;
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Unexpected DSH source symlink: ${file}`);
    return true;
  } });
}

// Install from a fresh root, with the local file dependency available before ci.
// Never reuse the source node_modules or execute host-native lifecycle scripts.
export async function prepareDshProduction(source, destination, target, run) {
  await mkdir(destination);
  for (const name of sourceNames) await copyClean(path.join(source, name), path.join(destination, name), true);
  await run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', `--os=${target.platform}`, `--cpu=${target.arch}`], destination);
  // dsh-subprocess-local's postinstall only repairs this helper's mode. Apply
  // that repair immediately after ci, using the release target, not the host.
  const helper = path.join(destination, 'node_modules/node-pty/prebuilds', `${target.platform}-${target.arch}`, 'spawn-helper');
  try { await regularFile(helper); }
  catch (error) { if (error.code === 'ENOENT' && target.platform !== 'darwin') return; throw error; }
  await chmod(helper, 0o755);
}

async function copyDependencies(source, destination, target, lock) {
  const roots = [];
  const visit = async (directory, output) => {
    await mkdir(output, { recursive: true });
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      const input = path.join(directory, entry.name);
      const copied = path.join(output, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) { await visit(input, copied); continue; }
      const location = path.relative(source, input).split(path.sep).join('/');
      let pinned = lock.packages[location];
      let root = input;
      // npm ci represents this pinned file dependency as a link. Materialize it
      // so the shipped tree remains portable, including on Windows.
      if (entry.isSymbolicLink()) {
        if (location !== 'node_modules/dsh-desktop-client-ui' || !pinned?.link
          || pinned.resolved !== 'vendor/dsh-desktop-client-ui') throw new Error(`Unexpected DSH dependency link: ${location}`);
        root = await realpath(input);
        if (root !== await realpath(path.join(source, pinned.resolved))) throw new Error('DSH vendor dependency link escapes its pinned vendor root');
        pinned = lock.packages[pinned.resolved];
      } else if (!entry.isDirectory()) throw new Error(`Invalid DSH dependency entry: ${location}`);
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
      if (!pinned || pinned.dev || pinned.version !== pkg.version) throw new Error(`DSH dependency differs from production lockfile: ${location}`);
      if (!supports(pkg.os, target.platform) || !supports(pkg.cpu, target.arch)) {
        if (!pinned.optional) throw new Error(`Required DSH dependency does not support ${target.runtimeTarget}: ${pkg.name}`);
        continue;
      }
      await copyClean(root, copied, true);
      roots.push(copied);
      try { await lstat(path.join(root, 'node_modules')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await visit(path.join(root, 'node_modules'), path.join(copied, 'node_modules'));
    }
  };
  await visit(path.join(source, 'node_modules'), path.join(destination, 'node_modules'));
  return roots;
}

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid DSH runtime file: ${file}`);
  return info;
}

async function sharedNode(repository, runtimeTarget) {
  const target = targetFor(runtimeTarget);
  const root = path.join(repository, 'src-tauri/resources/agent-host');
  const pinned = JSON.parse(await readFile(path.join(repository, 'packages/agent-host/runtime-manifest.json')));
  const receipt = JSON.parse(await readFile(path.join(root, 'runtime.json')));
  const executable = target.platform === 'win32' ? 'node.exe' : 'node';
  await regularFile(path.join(root, executable));
  if (receipt.target !== runtimeTarget || receipt.nodeVersion !== pinned.nodeVersion
    || receipt.sourceArchiveChecksum !== pinned.targets[runtimeTarget]?.sha256
    || receipt.nodeChecksum !== checksum(await readFile(path.join(root, executable)))) throw new Error('DSH requires the staged pinned Node for the same target');
  return { executable: `../agent-host/${executable}`, version: receipt.nodeVersion, checksum: receipt.nodeChecksum };
}

async function inventory(directory) {
  const files = [];
  const visit = async name => {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Invalid DSH distribution symlink: ${name}`);
    if (name.split('/').some(part => excluded.has(part))) throw new Error(`DSH distribution contains source cache: ${name}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(file)).sort()) await visit(name ? `${name}/${child}` : child);
    } else if (info.isFile()) {
      if (name !== manifestName) files.push({ file: name, checksum: checksum(await readFile(file)), executable: Boolean(info.mode & 0o111) });
    } else throw new Error(`Invalid DSH distribution file: ${name}`);
  };
  await visit('');
  return files;
}

async function validateAssets(directory, target) {
  for (const name of ['skills/project-mind-cli/SKILL.md', 'scripts/runtime.mjs', 'scripts/skills.mjs', 'scripts/builtin-skills.mjs', 'scripts/skill-management.mjs', 'scripts/isolation.mjs', 'config/desktop.patch.yml', 'package.json', 'package-lock.json', 'upstream.json', browserIndex,
    'node_modules/dsh-desktop-client-ui/package.json']) await regularFile(path.join(directory, name));
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json')));
  for (const location of Object.keys(lock.packages).filter(name => name.includes('node_modules/'))) {
    const pinned = lock.packages[location];
    if (pinned.dev || pinned.optional || !supports(pinned.os, target.platform) || !supports(pinned.cpu, target.arch)) continue;
    const pkg = JSON.parse(await readFile(path.join(directory, location, 'package.json')));
    const version = pinned.link ? lock.packages[pinned.resolved]?.version : pinned.version;
    if (pkg.version !== version || !supports(pkg.os, target.platform) || !supports(pkg.cpu, target.arch)) throw new Error(`DSH dependency target/version mismatch: ${location}`);
  }
  // The pinned node-pty ships prebuilds: no node-gyp or general postinstall approval.
  const pty = path.join(directory, 'node_modules/node-pty');
  if (lock.packages['node_modules/node-pty']) {
    const prebuilt = path.join(pty, 'prebuilds', `${target.platform}-${target.arch}`);
    const names = target.platform === 'win32'
      ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
      : target.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node'];
    for (const name of names) await regularFile(path.join(prebuilt, name));
    if (target.platform === 'darwin' && !((await lstat(path.join(prebuilt, 'spawn-helper'))).mode & 0o111)) throw new Error('DSH node-pty spawn-helper requires executable permissions');
  }
  if (lock.packages['node_modules/koffi']) {
    const location = `node_modules/@koromix/koffi-${target.platform}-${target.arch}`;
    const root = path.join(directory, location);
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
    if (pkg.version !== lock.packages[location]?.version || !supports(pkg.os, target.platform)
      || !supports(pkg.cpu, target.arch)) throw new Error('DSH Koffi target/version mismatch');
    const binaries = (await readdir(root, { recursive: true })).filter(name => path.basename(name) === 'koffi.node');
    if (!binaries.length) throw new Error(`Missing DSH Koffi prebuilt for ${target.platform}-${target.arch}`);
    for (const name of binaries) await regularFile(path.join(root, name));
  }
}

export async function verifyDshDistribution(directory, runtimeTarget) {
  const target = targetFor(runtimeTarget);
  await regularFile(path.join(directory, manifestName));
  const bytes = await readFile(path.join(directory, manifestName));
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.target !== runtimeTarget || manifest.entry !== 'scripts/runtime.mjs'
    || manifest.installAnchor !== 'package.json' || manifest.browserIndex !== browserIndex
    || !Array.isArray(manifest.packages) || !manifest.packages.length || !Array.isArray(manifest.files)) throw new Error('Invalid DSH distribution manifest or target mismatch');
  if (JSON.stringify(manifest.files) !== JSON.stringify(await inventory(directory))) throw new Error('DSH distribution inventory differs from the staged build');
  if (manifest.lockfileChecksum !== checksum(await readFile(path.join(directory, 'package-lock.json')))
    || manifest.noticesChecksum !== checksum(await readFile(path.join(directory, 'DSH-THIRD-PARTY-NOTICES.txt')))) throw new Error('DSH lockfile or notices differ from the manifest');
  const roots = manifest.files.filter(entry => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry.file))
    .map(entry => path.dirname(path.join(directory, entry.file)));
  const notices = await dshNoticeAssets(roots);
  if (JSON.stringify(manifest.packages) !== JSON.stringify(notices.packages)
    || checksum(notices.notices) !== manifest.noticesChecksum) throw new Error('DSH package license inventory differs from the manifest');
  const node = await sharedNode(path.resolve(directory, '../../..'), runtimeTarget);
  if (JSON.stringify(manifest.node) !== JSON.stringify(node)) throw new Error('DSH shared Node differs from the staged build');
  await validateAssets(directory, target);
  return { manifest, manifestChecksum: checksum(bytes) };
}

export async function stageDshRuntime(repository, runtimeTarget, production) {
  const target = targetFor(runtimeTarget);
  if (!production) throw new Error('Usage: stage-dsh-runtime.mjs <runtime target> <fresh production DSH directory>');
  const source = path.join(repository, 'packages/dsh-assistant');
  const resources = path.join(repository, 'src-tauri/resources');
  const node = await sharedNode(repository, runtimeTarget);
  const lockBytes = await readFile(path.join(source, 'package-lock.json'));
  for (const name of ['package.json', 'package-lock.json']) {
    if (checksum(await readFile(path.join(source, name))) !== checksum(await readFile(path.join(production, name)))) throw new Error(`DSH production ${name} differs from repository`);
  }
  const lock = JSON.parse(lockBytes);
  const staging = await mkdtemp(path.join(resources, '.dsh-runtime-'));
  try {
    for (const name of sourceNames) await copyClean(path.join(production, name), path.join(staging, name), true);
    const roots = await copyDependencies(production, staging, target, lock);
    await validateAssets(staging, target);
    const { notices, packages } = await dshNoticeAssets(roots);
    await writeFile(path.join(staging, 'DSH-THIRD-PARTY-NOTICES.txt'), notices);
    const manifest = { schemaVersion: 1, target: runtimeTarget, entry: 'scripts/runtime.mjs', installAnchor: 'package.json', browserIndex, node,
      lockfileChecksum: checksum(lockBytes), noticesChecksum: checksum(notices), packages, files: await inventory(staging) };
    await writeFile(path.join(staging, manifestName), JSON.stringify(manifest, null, 2) + '\n');
    await verifyDshDistribution(staging, runtimeTarget);
    const destination = path.join(resources, 'dsh-assistant');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    process.stdout.write(`Prepared production DSH resources: ${runtimeTarget}\n`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageDshRuntime(fileURLToPath(new URL('..', import.meta.url)), process.argv[2], process.argv[3]);
}
