import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { normalizeDirectory } from './context-directory.mjs';

// The configure frame contains binding facts only. Lease credentials arrive
// later, in memory, for one authenticated shell execution.
export async function readMindCli(line, context) {
  const invalid = () => new Error('Invalid main CLI configuration');
  let frame;
  try { frame = JSON.parse(line); } catch { throw invalid(); }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw invalid();
  if (!Object.hasOwn(frame, 'cli')) return undefined;
  const cli = frame.cli;
  const keys = ['executable', 'workspace', 'connection', 'discovery', 'projectId'];
  if (!cli || typeof cli !== 'object' || Array.isArray(cli)
    || Object.keys(cli).length !== keys.length || keys.some(key => !Object.hasOwn(cli, key))
    || ['executable', 'workspace', 'discovery'].some(key => typeof cli[key] !== 'string' || !path.isAbsolute(cli[key]) || cli[key].includes('\0'))
    || typeof cli.connection !== 'string' || !/^[0-9a-f]{32}$/i.test(cli.connection)
    || (context.kind === 'project' ? cli.projectId !== context.id : cli.projectId !== null)) throw invalid();
  try {
    if (!(await stat(cli.executable)).isFile() || !(await stat(cli.workspace)).isDirectory()) throw invalid();
    await access(cli.executable, constants.X_OK);
    if (context.kind === 'workspace' && await realpath(cli.workspace) !== context.directory) throw invalid();
  } catch { throw invalid(); }
  return { ...cli };
}

export function bindingPrompt(cli, platform = process.platform) {
  // These fragments are shell syntax, not JSON string literals. PowerShell
  // retains backslashes; both shells expand expressions inside double quotes.
  // PowerShell also treats the typographic apostrophes as single quotes.
  const quote = value => platform === 'win32'
    ? `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const executable = `${platform === 'win32' ? '& ' : ''}${quote(cli.executable)}`;
  const flags = `--workspace ${quote(cli.workspace)} --connection ${cli.connection}`;
  const scopeFlags = cli.projectId === null ? '--workspace-scope' : `--project ${cli.projectId}`;
  return `Project Mind has a built-in native CLI binding. Use the project-mind-cli Skill and existing mind commands (--help, capabilities, schema) for native operations.\nThe following command fragments are quoted for ${platform === 'win32' ? 'PowerShell' : 'POSIX shell'}; preserve their quoting when using them. Bundled executable: ${executable} (also available as mind on the tool shell PATH). Binding flags: ${flags}. Operation scope (only for commands accepting scope): ${scopeFlags}. Offline --help/capabilities/schema take no binding or scope flags; doctor uses binding flags without Project/Workspace scope. JSON input carries its own scope; do not append shorthand scope flags.\nFor a new DOCX deliverable use file_office_create with restricted HTML and a stable request_id; verify its native receipt and exact version/hash plus file_office_inspect semantic readback. Directory discovery does not establish a CLI creation receipt.\nUse the CLI for native Record/Todo reads and mutations, and report saved results using the native operation receipt. Directory files are not Records or Todos. Use the supplied binding; do not search for credentials or access databases as a substitute. Permissions and the current execution mode constrain every operation.`;
}

export function installMindCli(ctx, context, cli, bridge) {
  const registry = typeof context.forSession === 'function' ? context : undefined;
  if (!registry && cli === undefined) return;
  return ctx.inject(['shell', 'sessionController', 'systemPrompt'], scope => {
    scope.systemPrompt.section({ name: 'mind:native-cli', order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: registry ? assembly => {
      if (!assembly.agent) return '';
      const binding = registry.forAgent(assembly.agent).cli;
      return binding ? bindingPrompt(binding) : '';
    } : bindingPrompt(cli), interpolate: false });
    const shell = scope.shell;
    const original = shell.execute;
    const active = new Set();
    let disposed = false;
    const execute = async function(spec) {
      const sessionId = spec.dshEnv?.DSH_SESSION_ID;
      const mode = spec.sandboxPolicy?.mode;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Mind CLI shell requires an actual Session');
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new Error('Mind CLI shell requires a resolved sandbox mode');
      let sessionContext;
      if (registry) sessionContext = await registry.forSession(sessionId, spec.signal);
      else {
        const catalog = await scope.sessionController.list({ cwd: context.directory }, spec.signal);
        if (!catalog.items.some(item => item.sessionId === sessionId && normalizeDirectory(item.cwd) === normalizeDirectory(context.directory))) throw new Error('Mind CLI Session belongs to another context');
        sessionContext = context;
      }
      spec.signal?.throwIfAborted();
      if (disposed) throw new Error('Mind CLI shell binding disposed');
      if (registry && !sessionContext.cli) return original.call(this, spec);
      const entry = { handle: undefined, completion: undefined };
      active.add(entry);
      // Do not cancel this correlated request: if cancellation races a minted
      // lease, receive its identity first so it can still be revoked.
      entry.completion = (async () => {
        const lease = await bridge.request({ operation: 'cliLeaseOpen', sessionId, mode });
        if (!lease || typeof lease.leaseId !== 'string' || !lease.leaseId) throw new Error('Invalid native Mind CLI lease');
        const close = async () => {
          try { await bridge.request({ operation: 'cliLeaseClose', sessionId, leaseId: lease.leaseId }); }
          catch { scope.logger.error('Native Mind CLI lease cleanup failed'); throw new Error('Native Mind CLI lease cleanup failed'); }
        };
        try {
          if (typeof lease.token !== 'string' || !lease.token) throw new Error('Invalid native Mind CLI lease');
          const binding = registry ? lease.cli : cli;
          if (registry && (!binding || !sessionContext.cli || !isDeepStrictEqual(binding, sessionContext.cli))) throw new Error('Native Mind CLI lease belongs to another context');
          spec.signal?.throwIfAborted();
          if (disposed) throw new Error('Mind CLI shell binding disposed');
          const handle = await original.call(this, { ...spec, env: {
            ...spec.env,
            PATH: `${path.dirname(binding.executable)}${path.delimiter}${spec.env?.PATH ?? process.env.PATH ?? ''}`,
            PROJECT_MIND_CLI_DISCOVERY: binding.discovery,
            PROJECT_MIND_CLI_TOKEN: lease.token,
            PROJECT_MIND_SESSION_ID: sessionId,
          } });
          entry.handle = handle;
          if (disposed) handle.kill();
          // rc.2 returns the live process itself, not a Promise of its result.
          // Keep identity, kill, readers and done intact. Observe result even
          // for background calls, and join done before revoking the lease.
          const result = handle.result();
          const completion = (async () => {
            try { return await result; }
            finally { try { await handle.done; } finally { await close(); } }
          })();
          handle.result = () => completion;
          // Background callers may never request result(); infrastructure
          // failures remain available there; cleanup failures are also logged.
          void completion.catch(() => {});
          return { handle, completion };
        } catch (error) {
          await close();
          throw error;
        }
      })();
      try {
        const { handle, completion } = await entry.completion;
        entry.completion = completion;
        void completion.then(() => active.delete(entry), () => active.delete(entry));
        return handle;
      } catch (error) { active.delete(entry); throw error; }
    };
    shell.execute = execute;
    scope.effect(() => async () => {
      disposed = true;
      shell.execute = original;
      for (const entry of active) entry.handle?.kill();
      await Promise.allSettled([...active].map(async entry => {
        const value = await entry.completion;
        if (value?.completion) await value.completion;
      }));
    });
  });
}
