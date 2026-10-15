import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopRuntimeTarget } from './desktop-runtime-target.mjs';

const defaultRepository = fileURLToPath(new URL('..', import.meta.url));

function cargoEnvironment(env) {
  let config = {};
  if (env.TAURI_CONFIG) {
    try { config = JSON.parse(env.TAURI_CONFIG); }
    catch { throw new Error('TAURI_CONFIG must contain a JSON object'); }
    if (!config || Array.isArray(config) || typeof config !== 'object') {
      throw new Error('TAURI_CONFIG must contain a JSON object');
    }
  }
  if (config.bundle !== undefined && (!config.bundle || Array.isArray(config.bundle) || typeof config.bundle !== 'object')) {
    throw new Error('TAURI_CONFIG.bundle must be an object');
  }
  return { ...env, TAURI_CONFIG: JSON.stringify({
    ...config, bundle: { ...config.bundle, externalBin: [] },
  }) };
}

function runCargo(args, { cwd, env, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { cwd, env, stdio: output ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    if (output) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`cargo ${args[0]} failed (${signal ?? code})`)));
  });
}

export async function prepareCli({ repository = defaultRepository, env = process.env, targetArgument, cargo = runCargo } = {}) {
  const target = desktopRuntimeTarget(targetArgument, env);
  const manifest = path.join(repository, 'src-tauri', 'Cargo.toml');
  const childEnv = cargoEnvironment(env);
  const context = { cwd: repository, env: childEnv };
  const metadataText = await cargo(['metadata', '--no-deps', '--format-version', '1', '--locked', '--manifest-path', manifest], { ...context, output: true });
  let metadata;
  try { metadata = JSON.parse(metadataText); }
  catch { throw new Error('cargo metadata returned invalid JSON'); }
  if (typeof metadata.target_directory !== 'string' || !path.isAbsolute(metadata.target_directory)) {
    throw new Error('cargo metadata did not provide an absolute target_directory');
  }
  await cargo(['build', '--release', '--locked', '--bin', 'mind', '--target', target.rustTarget, '--manifest-path', manifest], context);
  const extension = target.platform === 'win32' ? '.exe' : '';
  const binary = path.join(metadata.target_directory, target.rustTarget, 'release', `mind${extension}`);
  const info = await lstat(binary);
  if (!info.isFile() || info.size === 0) throw new Error(`Built CLI is missing or empty: ${binary}`);
  const directory = path.join(repository, 'src-tauri', 'binaries');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `mind-${target.rustTarget}${extension}`);
  await copyFile(binary, destination);
  process.stdout.write(`Prepared CLI sidecar for ${target.rustTarget}: ${destination}\n`);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/prepare-cli.mjs [Rust target triple]');
  await prepareCli({ targetArgument: process.argv[2] });
}
