import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { boot, initProfile, loadProfileDirectory, createRuntimeResolution, PluginPackages, readProfilePatches, loadOverlayPatches, loadLayeredEnv, installFailLoud } from '@deepseek-ai/dsh-app-boot';
import { provideCmdline } from '@deepseek-ai/dsh-cmdline';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy';
import { assistantEnvironment } from './isolation.mjs';
import { readSharedModel, sharedModelPatches, installSharedCredential, installSharedSelection } from './shared-model.mjs';
import { readProject, bindProject } from './project-workspace.mjs';
import { createSourceBridge, installSourceService, installSourceTitles } from './source-bridge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const embedded = process.argv.includes('--embedded');
const args = process.argv.slice(2).filter(arg => arg !== '--embedded');
let input;
let sharedModel;
let project;
let sourceBridge;
let parentClosed = false;
if (embedded) {
  input = createInterface({ input: process.stdin });
  input.on('close', () => { parentClosed = true; });
  const frame = await new Promise((resolve, reject) => {
    input.once('line', resolve);
    input.once('close', () => reject(new Error('Main application closed before AI configuration')));
  });
  sharedModel = readSharedModel(frame);
  project = await readProject(frame);
  sourceBridge = createSourceBridge(input, line => process.stdout.write(line));
}
Object.assign(process.env, assistantEnvironment());
const home = process.env.DSH_HOME;
const cwd = embedded ? project.directory : path.join(home, 'workspace');
await mkdir(cwd, { recursive: true });
process.chdir(cwd);
const environment = loadLayeredEnv('mind-dsh', cwd);
const releaseProxy = await installProxyFromEnvironment(environment, message => process.stderr.write(`${message}\n`));
const sharedProfile = embedded && process.env.PROJECT_MIND_DSH_PROFILE_DIR;
if (sharedProfile && !path.isAbsolute(sharedProfile)) throw new Error('Main assistant profile directory must be absolute');
const dir = sharedProfile || path.join(home, 'profiles', 'assistant');
initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const installAnchor = path.join(root, 'package.json');
const profile = loadProfileDirectory('mind-dsh', dir, installAnchor);
if (profile.skippedBundles.length) throw new Error(JSON.stringify(profile.skippedBundles));
const resolution = await createRuntimeResolution({ installAnchor, profile });
const overlays = loadOverlayPatches('mind-dsh', path.join(root, 'config', 'desktop.patch.yml'));
const extraPatch = process.env.PROJECT_MIND_DSH_PATCH;
if (extraPatch) overlays.push(...loadOverlayPatches('mind-dsh', path.resolve(extraPatch)));
if (embedded) overlays.push(...sharedModelPatches(sharedModel));
const profileContext = { name: 'assistant', dir, patchPath: profile.patchPath, installAnchor, cwd, home, startedBundles: profile.layers.map(layer => layer.packageName), overlays, telemetryDisabledEnv: '1' };
const config = path.join(dir, 'cordis.yml');
await writeFile(config, '[]\n');
let ctx;
let closing;
let stopping = false;
const dispose = () => closing ??= (async () => {
  sourceBridge?.close();
  try { await ctx?.fiber.dispose(); } finally { await releaseProxy(); }
})();
const stop = code => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(code || 1), 5000);
  void dispose().then(() => { clearTimeout(timeout); process.exit(code); }, error => { console.error(error); process.exit(1); });
};
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
installFailLoud('mind-dsh', process, dispose);
const readyListeners = [];
try {
  ctx = await boot('mind-dsh', config, readProfilePatches('mind-dsh', profileContext, profile), async host => {
    ctx = host;
    host.provide('profileContext', profileContext);
    host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    await host.plugin(PluginPackages, { resolution });
    if (embedded) {
      installSharedCredential(host, sharedModel); installSharedSelection(host, sharedModel);
      installSourceTitles(host);
    }
    provideCmdline(host, { args, exit: stop, ready: { onReady(listener) { readyListeners.push(listener); return () => { const index = readyListeners.indexOf(listener); if (index >= 0) readyListeners.splice(index, 1); }; } } });
  });
  if (embedded) {
    await bindProject(ctx, project);
    await installSourceService(ctx, project, sourceBridge);
  }
  for (const listener of readyListeners) listener();
  if (process.send) process.send({ type: 'ready', port: ctx.webServer.port });
  if (embedded) {
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`);
    process.stdout.write(`MIND_DSH_READY ${JSON.stringify({ url })}\n`);
    input.on('line', line => { if (line === 'shutdown') stop(0); });
    input.once('close', () => stop(0));
    if (parentClosed) stop(0);
  }
} catch (error) {
  console.error(error);
  await dispose();
  process.exitCode = 1;
}
