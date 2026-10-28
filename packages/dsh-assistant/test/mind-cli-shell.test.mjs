import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindingPrompt } from '../scripts/mind-cli.mjs';

const run = promisify(execFile);
const connection = '0123456789abcdef0123456789abcdef';
// This is an external Node process: the shell, not this test, parses the flags.
const collector = "-e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' --";
const workspaces = [
  ['ordinary path', '/workspace/project'],
  ['Chinese and spaces', '/工作区/我的 项目'],
  ['single quote', "/workspace/O'Brien"],
  ['typographic apostrophes', '/workspace/O’Neil/‘quoted’/‚low‛'],
  ['dollar expansions', '/workspace/$HOME/${HOME}/$(echo expanded)'],
  ['backticks', '/workspace/`echo expanded`'],
  ['combined shell characters', "/中文 空格/O'Brien/$HOME/`echo expanded`"],
  ['Windows drive', String.raw`C:\Users\中文 用户\Mind`],
  ['UNC', String.raw`\\server\共享 空间\Mind`],
  ['extended drive', String.raw`\\?\C:\Users\中文 用户\Mind`],
  ['extended UNC', String.raw`\\?\UNC\server\共享 空间\Mind`],
  ['trailing backslash', 'C:\\工作区\\O\'Brien $HOME `literal`\\'],
  ['trailing double backslash', '\\\\server\\共享 空间\\\\'],
];

function promptParts(executable, workspace, platform) {
  const prompt = bindingPrompt({ executable, workspace, connection, projectId: null }, platform);
  const flags = /Binding flags: ([\s\S]*?)\. Operation scope/.exec(prompt)?.[1];
  const command = /Bundled executable: ([\s\S]*?) \(also available as mind/.exec(prompt)?.[1];
  assert.ok(flags, 'the real prompt must expose binding flags before Operation scope');
  assert.ok(command, 'the real prompt must expose the bundled executable');
  return { flags, command };
}

const shells = [
  { name: 'bash', platform: 'linux', executable: 'bash', args: ['--noprofile', '--norc', '-c'], node: '"$MIND_TEST_NODE"' },
  { name: 'PowerShell', platform: 'win32', executable: process.env.MIND_TEST_PWSH || 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], node: '& $env:MIND_TEST_NODE' },
];

async function available(t, shell) {
  if (shell.name === 'PowerShell' && process.platform !== 'win32' && !process.env.MIND_TEST_PWSH) {
    t.skip('PowerShell is optional on non-Windows hosts; set MIND_TEST_PWSH to a real pwsh executable to run these shell round trips');
    return false;
  }
  try {
    await run(shell.executable, shell.name === 'bash' ? ['--version'] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 15_000 });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && shell.name === 'bash' && process.platform === 'win32') {
      t.skip(`${shell.name} executable unavailable: ${shell.executable}; ${shell.name === 'PowerShell' ? 'set MIND_TEST_PWSH to enable real PowerShell coverage' : 'install bash to enable POSIX shell coverage'}`);
      return false;
    }
    throw error;
  }
}

async function assertArgv(shell, command, workspace) {
  let stdout;
  try {
    ({ stdout } = await run(shell.executable, [...shell.args, command], {
      env: { ...process.env, MIND_TEST_NODE: process.execPath },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    assert.fail(`${shell.name} could not execute the prompt command (exit ${error.code}):\n${error.stderr || error.message}\nstdout: ${error.stdout || ''}`);
  }
  assert.deepEqual(JSON.parse(stdout.trim()), ['--workspace', workspace, '--connection', connection], `${shell.name} must preserve every binding argument exactly`);
}

for (const shell of shells) {
  test(`${shell.name}: real prompt binding flags survive an external argv round trip`, async t => {
    if (!await available(t, shell)) return;
    for (const [name, workspace] of workspaces) {
      await t.test(name, async () => {
        const { flags } = promptParts(process.execPath, workspace, shell.platform);
        await assertArgv(shell, `${shell.node} ${collector} ${flags}`, workspace);
      });
    }
  });

  test(`${shell.name}: bundled executable from the real prompt is directly callable`, async t => {
    if (!await available(t, shell)) return;
    const directory = await mkdtemp(path.join(tmpdir(), "mind-cli-shell 中文 空格 O'Brien $HOME `literal`-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, process.platform === 'win32' ? 'mind node.exe' : 'mind node');
    // Native .exe on Windows avoids introducing cmd.exe's separate quoting rules.
    // On POSIX a symlink to Node also exercises shell lookup of the exact path.
    if (process.platform === 'win32') await copyFile(process.execPath, executable);
    else await symlink(process.execPath, executable);
    const workspace = "C:\\中文 空间\\O'Brien $HOME `literal`\\";
    const { command, flags } = promptParts(executable, workspace, shell.platform);
    await assertArgv(shell, `${command} ${collector} ${flags}`, workspace);
  });
}
