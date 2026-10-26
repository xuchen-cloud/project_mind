// Native bootstrap keeps each provider's private session leased independently
// of Node. No exit handler in Node can cover SIGKILL.
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';

const helperKey = 'PROJECT_MIND_DSH_PROCESS_HELPER';
const directoryKey = 'PROJECT_MIND_DSH_PROCESS_DIRECTORY';
const terminalLaunch = new AsyncLocalStorage();
let ptyHook;
function interceptPty() {
  if (ptyHook) return;
  // Resolve from the provider so the exact pinned PTY implementation is used.
  const require = createRequire(import.meta.url);
  const providerRequire = createRequire(require.resolve('@deepseek-ai/dsh-subprocess-local'));
  const pty = providerRequire('node-pty');
  const original = pty.spawn;
  pty.spawn = function (program, args, options) {
    const owner = terminalLaunch.getStore();
    if (!owner) return original.call(this, program, args, options);
    // Keep the pinned native scope and its cgroup owner intact. It is not a
    // fallback session and must not contain our sentinel (TasksCurrent/kill).
    if (owner.mode === 'linux-scope') return original.call(this, program, args, options);
    if (owner.mode !== 'fallback') throw new Error('Pinned terminal containment selection changed');
    return original.call(this, owner.helper, ['--dsh-owned-exec', owner.directory, 'tool', program, ...args], options);
  };
  ptyHook = true;
}

export async function processOwnership(environment = process.env) {
  const helper = environment[helperKey];
  const directory = environment[directoryKey];
  if (!helper && !directory) return undefined; // Standalone/browser runtime.
  if (process.platform === 'win32' || !path.isAbsolute(helper ?? '') || !path.isAbsolute(directory ?? '')) {
    throw new Error('Invalid native assistant process owner');
  }
  const token = readFileSync(path.join(directory, 'secret'), 'utf8');
  const stream = connect(path.join(directory, 'lease'));
  const pins = new Map();
  const waiters = new Map();
  let pending = '';
  let failure;
  const protectedProviders = new WeakSet();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => {
    failure = error;
    readyReject(error);
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  stream.on('error', fail);
  stream.on('close', () => fail(new Error('Native assistant process owner closed')));
  stream.on('connect', () => stream.write(`WATCH ${token}\n`));
  stream.on('data', chunk => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) { if (Buffer.byteLength(pending) > 512) stream.destroy(new Error('Native process frame exceeds budget')); break; }
      if (Buffer.byteLength(pending.slice(0, end)) > 512) { stream.destroy(new Error('Native process frame exceeds budget')); return; }
      const frame = pending.slice(0, end); pending = pending.slice(end + 1);
      if (frame === 'OK') { readyResolve(); continue; }
      const [kind, rawRoot, rawGuard] = frame.split(' ');
      const root = Number(rawRoot), guard = Number(rawGuard);
      if (!Number.isSafeInteger(root) || !Number.isSafeInteger(guard)) { stream.destroy(new Error('Invalid native process identity')); return; }
      if (kind === 'PIN') {
        pins.delete(root); pins.set(root, guard);
        if (pins.size > 256) pins.delete(pins.keys().next().value);
        waiters.get(root)?.resolve(guard); waiters.delete(root);
      } else if (kind === 'GONE') { /* Keep a bounded receipt for a terminal that exited before pin(). */ }
      else { stream.destroy(new Error('Invalid native process event')); return; }
    }
  });
  const timeout = setTimeout(() => stream.destroy(new Error('Native process owner handshake timed out')), 5000);
  try { await ready; } finally { clearTimeout(timeout); }
  stream.unref();
  const owner = {
    helper, directory,
    async pin(root) {
      if (failure) throw failure;
      if (pins.has(root)) return pins.get(root);
      if (waiters.size >= 256) throw new Error('Native process launch budget exhausted');
      let timer;
      const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => { waiters.delete(root); reject(new Error('Native process registration timed out')); }, 5000);
        waiters.set(root, { resolve, reject });
      });
      try { return await promise; } finally { clearTimeout(timer); }
    },
    protect(provider) {
      if (failure) throw failure;
      if (protectedProviders.has(provider)) return;
      if (typeof provider?.selectContainmentMode !== 'function' || !provider.internals || typeof provider.spawnTerminal !== 'function') {
        throw new Error('Pinned subprocess provider ownership interface changed');
      }
      // Preserve the pinned capability probe/selection. Native Linux scopes
      // bypass internals.spawn and retain SystemdScopeOwner's all-member kill,
      // task-count observation and waitForExit; only fallback uses the shim.
      protectedProviders.add(provider);
      const selectContainmentMode = provider.selectContainmentMode;
      provider.selectContainmentMode = function (kind) {
        const mode = selectContainmentMode.call(this, kind);
        const launch = terminalLaunch.getStore();
        if (launch && kind === 'terminal') launch.mode = mode;
        return mode;
      };
      const originalSpawn = provider.internals.spawn ?? spawn;
      provider.internals.spawn = (program, args, options) => originalSpawn(helper,
        ['--dsh-owned-exec', directory, 'tool', program, ...args], options);
      const originalTerminal = provider.spawnTerminal;
      provider.spawnTerminal = async function (spec) {
        interceptPty();
        const launch = { helper, directory, mode: undefined };
        const handle = await terminalLaunch.run(launch, () => originalTerminal.call(this, spec));
        if (launch.mode === 'linux-scope') return handle;
        if (launch.mode !== 'fallback') throw new Error('Pinned terminal spawn ownership interface changed');
        let guard;
        try { guard = await owner.pin(handle.pid); }
        catch (error) {
          // Revocation is native-owned: upstream terminate() would include the
          // unfiltered sentinel and could kill it before it finishes cleanup.
          stream.destroy();
          let timer;
          try {
            await Promise.race([handle.done, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Terminal cleanup did not finish')), 5000);
            })]);
          } finally { clearTimeout(timer); handle.output.destroy(); }
          throw error;
        }
        // The sentinel must not count as an executing shell command, or become
        // a target of upstream terminal termination before its cleanup finishes.
        const inspector = handle.inspector;
        handle.inspector = new Proxy(inspector, { get(target, key) {
          if (key === 'snapshot') return () => {
            const observed = target.snapshot();
            return new Proxy(observed, { get(snapshot, name) {
              if (name === 'tree' || name === 'session') return (...args) => snapshot[name](...args).filter(member => member.pid !== guard);
              if (name === 'alive') return member => member.pid !== guard && snapshot.alive(member);
              const value = snapshot[name]; return typeof value === 'function' ? value.bind(snapshot) : value;
            } });
          };
          if (key === 'isAlive') return member => member.pid !== guard && target.isAlive(member);
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        return handle;
      };
    },
    // Only explicit test disposal calls this; production keeps the observer
    // until Node exits so normal plugin disposal cannot revoke active leases.
    close() { stream.destroy(); },
  };
  return owner;
}

export async function installProcessOwnership(ctx, environment = process.env) {
  const owner = await processOwnership(environment);
  if (owner) ctx.inject(['subprocess'], child => { owner.protect(child.subprocess); });
  return owner;
}
