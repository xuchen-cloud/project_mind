export const DESKTOP_RUNTIME_TARGETS = Object.freeze({
  'aarch64-apple-darwin': { runtimeTarget: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { runtimeTarget: 'darwin-x64', platform: 'darwin', arch: 'x64' },
  'x86_64-pc-windows-msvc': { runtimeTarget: 'win-x64', platform: 'win32', arch: 'x64' },
  // Linux is the development/verification target, not an additional release platform.
  'x86_64-unknown-linux-gnu': { runtimeTarget: 'linux-x64', platform: 'linux', arch: 'x64' },
});

export function desktopRuntimeTarget(argument, env = process.env) {
  const candidates = [argument, env.TAURI_ENV_TARGET_TRIPLE, env.CARGO_BUILD_TARGET].filter(Boolean);
  if (!candidates.length) throw new Error('Specify a Rust target argument, TAURI_ENV_TARGET_TRIPLE, or CARGO_BUILD_TARGET; the runtime must not default to the build host');
  if (new Set(candidates).size !== 1) throw new Error(`Conflicting desktop Rust targets: ${candidates.join(', ')}`);
  const rustTarget = candidates[0];
  const target = DESKTOP_RUNTIME_TARGETS[rustTarget];
  if (!target) throw new Error(`Unsupported desktop Rust target: ${rustTarget}`);
  return { rustTarget, ...target };
}

export function desktopRuntimePreparation(args, env = process.env, host = process) {
  const development = args[0] === '--development';
  if (args.length > 1 || (args[0]?.startsWith('--') && !development)) {
    throw new Error('Usage: prepare-desktop-runtime.mjs [--development | <Rust target triple>]');
  }
  let requested = args[0];
  if (development) {
    requested = Object.entries(DESKTOP_RUNTIME_TARGETS).find(([, target]) =>
      target.platform === host.platform && target.arch === host.arch)?.[0];
    if (!requested) throw new Error(`Unsupported desktop development host: ${host.platform}-${host.arch}`);
  }
  return { development, target: desktopRuntimeTarget(requested, env) };
}

export function desktopResourceCommands(target, archive, productionDsh, { development = false } = {}) {
  return [
    ['packages/agent-host/scripts/prepare-runtime.mjs', target.runtimeTarget, archive],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.record-worker.config.ts'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.source-worker.config.ts'],
    ['scripts/stage-record-runtime.mjs', target.runtimeTarget],
    ['scripts/stage-source-runtime.mjs', target.runtimeTarget],
    ['scripts/build-office-runtime.mjs', target.rustTarget],
    ...development ? [] : [
      ['scripts/stage-office-runtime.mjs', target.runtimeTarget],
      ['scripts/stage-dsh-runtime.mjs', target.runtimeTarget, productionDsh],
    ],
  ];
}
