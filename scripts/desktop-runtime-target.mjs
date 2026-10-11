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

export function desktopResourceCommands(target, archive, productionHost, productionDsh) {
  return [
    ['packages/agent-host/scripts/prepare-runtime.mjs', target.runtimeTarget, archive],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.record-worker.config.ts'],
    ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn', '--config', 'vite.source-worker.config.ts'],
    // Record replaces agent-host. Pi must always be composed after that replacement.
    ['scripts/stage-record-runtime.mjs', target.runtimeTarget],
    ['scripts/stage-source-runtime.mjs', target.runtimeTarget],
    ['scripts/stage-pi-runtime.mjs', target.runtimeTarget, productionHost],
    ['scripts/stage-dsh-runtime.mjs', target.runtimeTarget, productionDsh],
  ];
}
