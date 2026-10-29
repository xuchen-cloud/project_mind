// Run with Node's test runner after the real mind binary has been built:
//   node --test scripts/cli-usability.test.mjs
// MIND_CLI_TEST_BINARY overrides target/debug/mind[.exe]. No mock binary or
// automatic build is used. MIND_CLI_TEST_PWSH optionally selects PowerShell 7.
// PowerShell tests exercise its real parser -> native mind argv, on the current
// host OS. Running them on macOS does not validate Windows or PowerShell 5.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const binary = path.resolve(process.env.MIND_CLI_TEST_BINARY
  ?? path.join(repo, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'mind.exe' : 'mind'));
const binding = { workspaceId: 'cli-usability-fixture', generation: 'isolated-open-1' };
const object = { workspaceId: binding.workspaceId, scope: { kind: 'workspace' }, kind: 'record', id: '44' };
const revision = `sha256:${'a'.repeat(64)}`;
const sourceRef = { object, revision, title: '隔离测试：火车排期', fileVersion: null,
  recordVersion: null, blockId: null, locator: null, excerpt: '' };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
// PowerShell treats all five of these characters as single-quote delimiters.
// Double the original code point instead of replacing a smart quote with ASCII.
const psLiteral = value => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
// PowerShell's Windows host may re-emit native lines with CRLF. Normalize only
// that transport newline; pattern quotes, backslashes and path prefixes stay exact.
const normalizePowerShellNewlines = text => text.replaceAll('\r\n', '\n');
const utf8Bom = value => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value, 'utf8')]);
const utf16LE = value => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
const business = result => result.calls.filter(call => call.route === '/v1/call');

function recordPage(text, overrides = {}) {
  const lines = text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
  return { sourceRef, text, spans: [], nextCursor: null, complete: true, rangeComplete: true,
    headRevision: 7, format: 'markdown',
    window: { offset: 1, limit: null, totalLines: lines, startLine: 1, endLine: lines }, ...overrides };
}
function recordHandler(body, options = {}) {
  return request => {
    assert.equal(request.method, 'record.get');
    assert.deepEqual(request.params.object, object);
    assert.equal(request.params.format, 'markdown');
    return recordPage(body, options);
  };
}
function expectExit(result, code) {
  assert.equal(result.code, code, `exit ${result.code}, expected ${code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}
function assertOneConnection(result) {
  assert.equal(result.calls.filter(call => call.route === '/v1/connect').length, 1);
}
function spawnCaptured(executable, args, { env, stdin = '', onStdout, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, args, { env, cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', firstOutputMs = null, callbackError;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeout}ms: ${path.basename(executable)} ${args.slice(0, 3).join(' ')}`));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      firstOutputMs ??= performance.now() - started;
      stdout += chunk;
      try { onStdout?.(stdout, performance.now() - started); }
      catch (error) { callbackError = error; child.kill(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (callbackError) reject(callbackError);
      else resolve({ code, signal, stdout, stderr, firstOutputMs, totalMs: performance.now() - started });
    });
    // Commands which reject arguments before consuming stdin can close the pipe.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { child.kill(); reject(error); } });
    child.stdin.end(stdin);
  });
}
async function powershell(env) {
  const candidates = process.env.MIND_CLI_TEST_PWSH ? [process.env.MIND_CLI_TEST_PWSH]
    : ['pwsh', ...(process.platform === 'darwin' ? ['/tmp/mind-cli-pwsh-7.6.9/pwsh'] : [])];
  for (const executable of candidates) {
    try {
      const result = await spawnCaptured(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$PSVersionTable.PSVersion.ToString(); $PSNativeCommandArgumentPassing'], { env, timeout: 10000 });
      if (result.code === 0 && /^7\./m.test(result.stdout)) return { executable, version: result.stdout.trim() };
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) throw error;
    }
  }
  return undefined;
}
async function fixture(t) {
  assert.ok((await stat(binary)).isFile(), `Build the real mind binary first: ${binary}`);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mind-cli-usability-中文 空格-')));
  const token = `synthetic-${randomUUID()}`;
  const grant = 'a'.repeat(32);
  let active;
  const server = createServer(async (request, response) => {
    const run = active;
    try {
      assert.ok(run, 'unexpected request outside an active test command');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      run.calls.push({ route: request.url, ...body });
      assert.equal(body.instanceId, 'isolated-cli-usability');
      assert.equal(body.grantId, grant);
      assert.ok(body.requestId);
      let data;
      if (request.url === '/v1/connect') {
        assert.equal(await realpath(body.workspacePath), root);
        data = binding;
      } else {
        assert.equal(request.url, '/v1/call');
        assert.deepEqual(body.binding, binding);
        data = await run.handler(body);
      }
      response.setHeader('Content-Type', 'application/json');
      if (data?.$error) response.end(JSON.stringify({ apiVersion: 1, requestId: body.requestId, ok: false, error: data.$error }));
      else response.end(JSON.stringify({ apiVersion: 1, requestId: body.requestId, ok: true, data }));
    } catch (error) {
      run?.errors.push(error);
      response.statusCode = 500;
      response.end('Isolated test Bridge assertion failed');
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const discovery = path.join(root, 'discovery.json');
  await writeFile(discovery, JSON.stringify({ instanceId: 'isolated-cli-usability', port: server.address().port, endpointVersion: 1 }));
  // Explicitly remove ambient Mind bindings and proxy settings. No user token,
  // discovery file, Workspace, or running application is contacted by the test.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('PROJECT_MIND_') && !/^(https?|all|no)_proxy$/i.test(key)));
  Object.assign(env, { PROJECT_MIND_CLI_DISCOVERY: discovery, PROJECT_MIND_CLI_TOKEN: token,
    PROJECT_MIND_WORKSPACE: root, PROJECT_MIND_CONNECTION: grant, PROJECT_MIND_WORKSPACE_SCOPE: '1',
    NO_PROXY: '127.0.0.1,localhost' });
  async function run(args, handler, options = {}) {
    assert.equal(active, undefined, 'fixture commands must run sequentially');
    const state = { handler, calls: [], errors: [] };
    active = state;
    try {
      const result = options.shell
        ? await spawnCaptured(options.shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `& ${psLiteral(binary)} ${args.map(psLiteral).join(' ')}; exit $LASTEXITCODE`], { env, ...options })
        : await spawnCaptured(binary, args, { env, ...options });
      assert.deepEqual(state.errors.map(error => error.stack), [], `Bridge assertions failed:\n${state.errors.map(String).join('\n')}`);
      return { ...result, calls: state.calls };
    } finally { active = undefined; }
  }
  return { root, env, run };
}

test('compiled mind CLI usability through an isolated native HTTP Bridge', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  await t.test('real binary is mandatory and runs without the application', async () => {
    const result = await f.run(['--version'], () => { throw new Error('version must be local'); });
    expectExit(result, 0);
    assert.match(result.stdout, /^mind \d+\./);
    assert.deepEqual(result.calls, []);
  });

  await t.test('grep distinguishes selected lines, no match, invalid regex and unreadable source (0/1/2)', async () => {
    const body = 'unrelated\n中文 火车\n';
    const matched = await f.run(['grep', '-Fn', '火车', 'record:44'], recordHandler(body));
    expectExit(matched, 0);
    assert.equal(matched.stdout, 'record:44:2:中文 火车\n');
    assertOneConnection(matched);
    const absent = await f.run(['grep', '-F', 'not-present', 'record:44'], recordHandler(body));
    expectExit(absent, 1);
    assert.equal(absent.stdout, '');
    const invalid = await f.run(['grep', '[', 'record:44'], () => { throw new Error('invalid regex must not read'); });
    expectExit(invalid, 2);
    assert.match(invalid.stderr, /pattern|bracket|regex/i);
    assert.deepEqual(business(invalid), []);
    const denied = await f.run(['grep', '-F', '火车', 'record:44'], () => ({ $error: {
      code: 'SOURCE_NOT_READY', message: 'Fixture extraction is unavailable', retryable: false,
    } }));
    expectExit(denied, 2);
    assert.match(denied.stderr, /SOURCE_NOT_READY/);
  });

  await t.test('grep supports -e OR -f, UTF-8 BOM, CRLF and quoted pattern-file paths', async () => {
    const file = path.join(f.root, "patterns 中文 空格 ['single'].txt");
    const pathPattern = String.raw`\\?\D:\商店 BA\[1]\排期.md`;
    await writeFile(file, utf8Bom(`beta\r\n${pathPattern}\r\n`));
    const body = `alpha\r\nbeta\r\n${pathPattern}\r\n-leading\r\nother\r\n`;
    const result = await f.run(['grep', '-Fn', '-e', 'alpha', '--file=' + file, '-e', '-leading', 'record:44'], recordHandler(body));
    expectExit(result, 0);
    assert.equal(result.stdout, `record:44:1:alpha\nrecord:44:2:beta\nrecord:44:3:${pathPattern}\nrecord:44:4:-leading\n`);
    assertOneConnection(result);
    const empty = path.join(f.root, 'empty-patterns.txt');
    await writeFile(empty, '');
    const noPatterns = await f.run(['grep', '-F', '-f', empty, 'record:44'], recordHandler(body));
    expectExit(noPatterns, 1);
    assert.equal(noPatterns.stdout, '');
    const blank = path.join(f.root, 'blank-patterns.txt');
    await writeFile(blank, '\r\n');
    const blankPattern = await f.run(['grep', '-F', '-f', blank, 'record:44'], recordHandler('one\ntwo\n'));
    expectExit(blankPattern, 0);
    assert.equal(blankPattern.stdout, 'record:44:one\nrecord:44:two\n');
  });

  await t.test('grep UTF-16 has an actionable diagnostic and stdin patterns are OR-ed', async () => {
    const file = path.join(f.root, 'UTF16 中文.txt');
    await writeFile(file, utf16LE('火车\r\n'));
    const invalid = await f.run(['grep', '-F', '-f', file, 'record:44'], () => { throw new Error('UTF-16 must fail before reading'); });
    expectExit(invalid, 2);
    assert.match(invalid.stderr, /UTF-16/);
    assert.match(invalid.stderr, /UTF-8/);
    assert.equal(invalid.stdout, '');
    assert.deepEqual(business(invalid), []);
    const stdin = await f.run(['grep', '-Fn', '-e', 'alpha', '-f', '-', 'record:44'], recordHandler('alpha\nbeta\nno\n'),
      { stdin: utf8Bom('beta\r\n') });
    expectExit(stdin, 0);
    assert.equal(stdin.stdout, 'record:44:1:alpha\nrecord:44:2:beta\n');
  });

  await t.test('grep combines -Fin and honors --, --regexp=value and leading slashes/dashes', async () => {
    for (const [args, pattern] of [
      [['-Fin', '--', '-MiXeD=开头'], '-mixed=开头'],
      [['-Fnx', '--regexp=/开头/中文'], '/开头/中文'],
      [['-Fnx', '--regexp=--query=字面'], '--query=字面'],
    ]) {
      const result = await f.run(['grep', ...args, 'record:44'], recordHandler(`${pattern}\nnot selected\n`));
      expectExit(result, 0);
      assert.equal(result.stdout, `record:44:1:${pattern}\n`);
    }
    const basic = await f.run(['grep', '-n', 'a+b', 'record:44'], recordHandler('a+b\nab\naaab\n'));
    expectExit(basic, 0);
    assert.equal(basic.stdout, 'record:44:1:a+b\n');
    const extended = await f.run(['grep', '-En', '^a+b$', 'record:44'], recordHandler('a+b\nab\naaab\n'));
    expectExit(extended, 0);
    assert.equal(extended.stdout, 'record:44:2:ab\nrecord:44:3:aaab\n');
  });

  await t.test('grep -q stops before another page and partial File coverage is not a clean miss', async () => {
    const quiet = await f.run(['grep', '-Fq', 'hit', 'record:44'], request => {
      assert.equal(request.method, 'record.get');
      assert.equal(request.params.cursor, undefined);
      return recordPage('hit\n', { complete: false, rangeComplete: false, nextCursor: 'unread-next-page' });
    });
    expectExit(quiet, 0);
    assert.equal(quiet.stdout, '');
    assert.equal(business(quiet).length, 1);
    const partial = await f.run(['grep', '-F', 'missing', 'file:55'], request => {
      assert.equal(request.method, 'source.read');
      assert.equal(request.params.source.object.kind, 'file');
      return { sourceRef: { ...sourceRef, object: { ...object, kind: 'file', id: '55' }, fileVersion: 3 },
        text: 'available only\n', spans: [], nextCursor: null, complete: false, rangeComplete: false,
        extraction: { state: 'partial', reason: 'page_limit', coverage: { complete: false } } };
    });
    expectExit(partial, 2);
    assert.match(partial.stderr, /incomplete|coverage|unread/i);
    assert.doesNotMatch(partial.stderr, /Invalid grep read response|invalid continuation/i);
  });

  await t.test('grep snapshots metadata before body reads and preserves File cursor selection', async () => {
    let metadataComplete = false;
    const inventory = await f.run(['grep', '--kind=record', '-Fn', 'hit'], request => {
      if (request.method === 'record.list') {
        assert.deepEqual(request.params.scope, { kind: 'workspace' });
        assert.equal(request.params.mode, 'metadata');
        const second = request.params.cursor === 'inventory-2';
        if (second) metadataComplete = true;
        return { items: [{ object: { ...object, id: second ? '45' : '44' } }], totalCount: 2,
          hasMore: !second, nextCursor: second ? null : 'inventory-2', staleCount: 0 };
      }
      assert.equal(request.method, 'record.get');
      assert.ok(metadataComplete, 'a legacy body read must not invalidate an unfinished inventory cursor');
      return recordPage(`hit ${request.params.object.id}\n`, {
        sourceRef: { ...sourceRef, object: request.params.object },
      });
    });
    expectExit(inventory, 0);
    assert.deepEqual(business(inventory).map(call => call.method), ['record.list', 'record.list', 'record.get', 'record.get']);
    assert.equal(inventory.stdout, 'record:44:1:hit 44\nrecord:45:1:hit 45\n');
    const fileObject = { ...object, kind: 'file', id: '55' };
    const paged = await f.run(['grep', '-Fn', 'joined line', 'file:55'], request => {
      assert.equal(request.method, 'source.read');
      assert.deepEqual(request.params.source.object, fileObject);
      // source.read cursors bind whether fileVersion was originally supplied.
      // Pin revision while preserving that original selection on continuation.
      assert.ok(request.params.source.fileVersion == null);
      const second = request.params.cursor === 'file-2';
      if (second) assert.equal(request.params.source.revision, revision);
      return { sourceRef: { ...sourceRef, object: fileObject, fileVersion: 3 },
        text: second ? ' line\n' : 'joined', spans: [], nextCursor: second ? null : 'file-2',
        complete: second, rangeComplete: second,
        extraction: { state: 'ready', reason: null, coverage: { complete: true } } };
    });
    expectExit(paged, 0);
    assert.equal(paged.stdout, 'file:55:1:joined line\n');
    assert.equal(business(paged).length, 2);
  });

  const ps = await powershell(f.env);
  await t.test('PowerShell 7 parser preserves literal patterns through native argv and exact-line grep',
    { skip: ps ? false : 'PowerShell 7 unavailable; native-binary base tests still execute' }, async t => {
      t.diagnostic(`Host=${process.platform}; PowerShell=${ps.version.replaceAll('\n', ' / ')}. This is not Windows/PS5.1 certification.`);
      const patterns = [
        '中文 空格 火车', String.raw`\\?\D:\商店 BA\[a]\排期.md`, String.raw`\\server\共享 中文\排期.md`,
        String.raw`\\?\UNC\server\共享\排期.md`, '\\?\\',
        `single'quote double"quote back\`tick`, '$(throw "must not execute") &|;[]{}*?!%#<>=',
        '/开头/中文', '-开头-flag', '--query=保留字面', 'ends-with-backslash\\', '',
        'U2018 中文\u2018单引号', 'U2019 中文\u2019单引号',
        'U201A 中文\u201a单引号', 'U201B 中文\u201b单引号',
        `混合\u2018\u2019\u201a\u201b'引号 ${String.raw`\\?\D:\中文\[排期]`}`,
      ];
      const body = `${patterns.join('\n')}\n`;
      for (const [index, pattern] of patterns.entries()) {
        const result = await f.run(['grep', '-Fxn', '--regexp', pattern, 'record:44'], recordHandler(body), { shell: ps.executable });
        expectExit(result, 0);
        assert.equal(normalizePowerShellNewlines(result.stdout), `record:44:${index + 1}:${pattern}\n`, `literal changed: ${JSON.stringify(pattern)}`);
      }
      const query = `中文 ${String.raw`\\?\D:\a\b`} ' \u2018\u2019\u201a\u201b " \` $() &|;[]{}*?!%#<>= / -`;
      const result = await f.run(['search', '--format=json', `--query=${query}`], request => {
        assert.equal(request.method, 'source.search');
        assert.deepEqual(request.params.scope, { kind: 'workspace' });
        assert.equal(request.params.query, query);
        return { items: [], hasMore: false, nextCursor: null, staleCount: 0 };
      }, { shell: ps.executable });
      expectExit(result, 0);
      assert.equal(JSON.parse(result.stdout).ok, true);
      const file = path.join(f.root, "PS patterns 中文 [\u2018\u2019\u201a\u201b'quoted'].txt");
      await writeFile(file, utf8Bom(`${patterns[1]}\r\n${patterns[3]}\r\n`));
      const fileResult = await f.run(['grep', '-Fxn', `--file=${file}`, 'record:44'], recordHandler(body), { shell: ps.executable });
      expectExit(fileResult, 0);
      assert.equal(normalizePowerShellNewlines(fileResult.stdout), `record:44:2:${patterns[1]}\nrecord:44:4:${patterns[3]}\n`);
    });

  await t.test('record stdout appears before the second page response (actual streaming)', async t => {
    const visible = deferred();
    let firstVisibleMs, secondReleasedMs;
    const started = performance.now();
    let gateTimer;
    const result = await f.run(['record', 'get', '44'], async request => {
      assert.equal(request.method, 'record.get');
      assert.equal(request.params.format, 'markdown', 'default human reads preserve table/Markdown structure');
      if (!request.params.cursor) return recordPage('first-visible-line\n', {
        complete: false, rangeComplete: false, nextCursor: 'record-page-2',
        window: { offset: 1, limit: null, totalLines: 2, startLine: 1, endLine: 1 },
      });
      assert.equal(request.params.cursor, 'record-page-2');
      assert.equal(request.params.revision, revision);
      await Promise.race([visible.promise, new Promise((_, reject) => {
        gateTimer = setTimeout(() => reject(new Error('first page was buffered instead of streamed')), 2500);
      })]).finally(() => clearTimeout(gateTimer));
      secondReleasedMs = performance.now() - started;
      return recordPage('second-page-line\n', {
        window: { offset: 1, limit: null, totalLines: 2, startLine: 2, endLine: 2 } });
    }, { onStdout(stdout, elapsed) {
      if (firstVisibleMs === undefined && stdout.includes('first-visible-line')) { firstVisibleMs = elapsed; visible.resolve(); }
    } });
    expectExit(result, 0);
    assert.ok(firstVisibleMs !== undefined && firstVisibleMs < secondReleasedMs);
    assert.match(result.stdout, /first-visible-line/);
    assert.match(result.stdout, /second-page-line/);
    assert.equal(business(result).length, 2);
    assertOneConnection(result);
    t.diagnostic(`First content ${firstVisibleMs.toFixed(1)}ms; second response released ${secondReleasedMs.toFixed(1)}ms; total ${result.totalMs.toFixed(1)}ms`);
  });

  await t.test('record windows reach the service directly without replaying or slicing the prefix twice', async () => {
    const result = await f.run(['record', 'get', '44', '--format=plain', '--offset=400', '--limit=2'], request => {
      assert.equal(request.method, 'record.get');
      assert.equal(request.params.offset, 400);
      assert.equal(request.params.limit, 2);
      assert.equal(request.params.format, 'text');
      assert.ok(request.params.cursor == null);
      return recordPage('target line\nnext line\n', { format: 'text', complete: false, rangeComplete: true,
        window: { offset: 400, limit: 2, totalLines: 1000, startLine: 400, endLine: 401 } });
    });
    expectExit(result, 0);
    assert.equal(result.stdout, 'target line\nnext line\n');
    assert.equal(business(result).length, 1);
  });

  await t.test('Markdown stdout is exact and metadata goes to stderr; JSON remains one page', async () => {
    const parts = ['  # 发布🚄\n\n```powershell\n', '$x = "\\\\?\\D:\\中文"\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> 引用\n'];
    const handler = request => {
      assert.equal(request.method, 'record.get');
      assert.equal(request.params.format, 'markdown');
      const second = request.params.cursor === 'markdown-2';
      if (second) assert.equal(request.params.revision, revision);
      return recordPage(parts[second ? 1 : 0], { nextCursor: second ? null : 'markdown-2', complete: second,
        rangeComplete: second, window: { offset: 1, limit: null, totalLines: 12, startLine: second ? 4 : 1, endLine: second ? 12 : 3 } });
    };
    const result = await f.run(['record', 'get', '44', '--format=markdown'], handler);
    expectExit(result, 0);
    assert.equal(result.stdout, parts.join(''));
    assert.match(result.stderr, /Head revision: 7/);
    assert.equal(business(result).length, 2);
    const json = await f.run(['record', 'get', '44', '--json'], request => {
      assert.equal(request.method, 'record.get');
      assert.equal(request.params.format, 'text', 'legacy JSON keeps the original source projection');
      return recordPage('json-first-page', {
        format: 'text', complete: false, rangeComplete: false, nextCursor: 'not-fetched',
      });
    });
    expectExit(json, 0);
    assert.equal(JSON.parse(json.stdout).data.nextCursor, 'not-fetched');
    assert.equal(business(json).length, 1);
  });

  await t.test('search --all follows each cursor once and preserves the original query', async () => {
    const cursors = [null, 'search-2', 'search-3'];
    const result = await f.run(['search', '火车 排期', '--all', '--limit=1', '--kind=record,file'], request => {
      assert.equal(request.method, 'source.search');
      assert.deepEqual(request.params.scope, { kind: 'workspace' });
      assert.equal(request.params.query, '火车 排期');
      assert.equal(request.params.limit, 1);
      assert.deepEqual(request.params.kinds, ['record', 'file']);
      const index = cursors.indexOf(request.params.cursor ?? null);
      assert.notEqual(index, -1);
      const ref = { ...sourceRef, object: { ...object, id: String(44 + index) } };
      return { items: [{ objectKey: `${binding.workspaceId}/workspace/record/${44 + index}`, sourceRef: ref,
        title: `唯一排期${index + 1}`, excerpt: '火车 排期', score: 1, coverage: { complete: true, chars: 10 } }],
        hasMore: index < 2, nextCursor: cursors[index + 1] ?? null, staleCount: 0 };
    });
    expectExit(result, 0);
    assert.deepEqual(business(result).map(call => call.params.cursor ?? null), cursors);
    for (let index = 1; index <= 3; index++) assert.equal(result.stdout.split(`唯一排期${index}`).length - 1, 1);
    assertOneConnection(result);
  });

  await t.test('text edit --dry-run sends exact UTF-8 BOM content and numeric baseline without writes', async () => {
    const before = path.join(f.root, "before 中文 'quote'.md");
    const after = path.join(f.root, 'after 中文.md');
    const oldText = '  # 标题\r\n\r\n旧正文\\?\\D:\\商店 $()\r\n';
    const newText = '  # 标题\r\n\r\n新正文 & | ; [ ] { }\r\n';
    await writeFile(before, utf8Bom(oldText));
    await writeFile(after, utf8Bom(newText));
    const expectedEdits = [
      { args: ['edit', '--before-file', before, '--body-file', after], edit: { kind: 'markdown', beforeMarkdown: oldText, afterMarkdown: newText } },
      { args: ['replace', '--old-text-file', before, '--new-text-file', after], edit: { kind: 'replace', oldText, newText } },
      { args: ['append', '--body-file', after], edit: { kind: 'append', markdown: newText } },
    ];
    for (const { args, edit } of expectedEdits) {
      const result = await f.run(['record', args[0], '44', ...args.slice(1), '--base-revision=7', '--dry-run'], request => {
        assert.equal(request.method, 'record.text.patch.preview');
        assert.deepEqual(request.params.record, object);
        assert.equal(request.params.baseRevision, 7);
        assert.deepEqual(request.params.edit, edit);
        assert.equal(Object.hasOwn(request.params, 'requestId'), false);
        return { dryRun: true, baseRevision: 7, noChange: false };
      });
      expectExit(result, 0);
      assert.equal(JSON.parse(result.stdout).data.dryRun, true);
      assert.deepEqual(business(result).map(call => call.method), ['record.text.patch.preview']);
    }
  });

  // These exercise the compiled CLI's DTO translation, not the native Contact
  // database. Native permission, persistence and CAS tests belong to the backend.
  await t.test('contact search preserves literal queries and zero-based pagination', async () => {
    const query = `中文 ‘’‚‛'" \` $() &|;[]{}*?!%#<>= ${String.raw`\\?\D:\商店 BA`}`;
    for (const args of [
      ['contact', 'search', query, '--limit=3', '--offset=0', '--json'],
      ['contact', 'list', `--query=${query}`, '--limit=3', '--offset=0', '--json'],
      ['contact', 'search', '--limit=3', '--offset=0', '--json', '--', '-中文开头'],
    ]) {
      const result = await f.run(args, request => {
        assert.equal(request.method, args[1] === 'list' ? 'contact.list' : 'contact.search');
        assert.deepEqual(request.params, { query: args.includes('--') ? '-中文开头' : query, limit: 3, offset: 0 });
        return { items: [], totalCount: 0, hasMore: false };
      });
      expectExit(result, 0);
      assert.equal(JSON.parse(result.stdout).ok, true);
      assert.equal(business(result).length, 1);
      assertOneConnection(result);
    }
    const items = [
      { id: 18, name: '张"三', nicknames: '老张\t三哥\n‘’‚‛', email: 'zhang@example.test', employeeId: '工号\\01', department: '' },
      { id: 19, name: '李四', nicknames: '小李', email: 'line\tmail\nnext\rend\\literal',
        employeeId: '员工\t二\n三\r四\\x', department: '研\t发\n部\r门\\研发' },
    ];
    const expected = [
      ['18', String.raw`"张\"三"`, 'zhang@example.test', String.raw`工号\01`, String.raw`"老张\t三哥\n‘’‚‛"`, ''].join('\t'),
      ['19', '"李四"', String.raw`line\tmail\nnext\rend\literal`, String.raw`员工\t二\n三\r四\x`,
        '"小李"', String.raw`研\t发\n部\r门\研发`].join('\t'),
    ].join('\n') + '\n';
    for (const verb of ['search', 'list']) {
      const displayed = await f.run(['contact', verb, '--query', query], request => {
        assert.equal(request.method, `contact.${verb}`);
        assert.deepEqual(request.params, { query });
        return { items, totalCount: 2, hasMore: false };
      });
      expectExit(displayed, 0);
      assert.equal(displayed.stdout, expected, 'names/nicknames stay JSON-quoted; other fields retain backslashes and escape only row/column separators');
      const rows = displayed.stdout.trimEnd().split('\n');
      assert.equal(rows.length, 2);
      // Keep the empty final department column: trim only the output newline.
      for (const row of displayed.stdout.slice(0, -1).split('\n')) assert.equal(row.split('\t').length, 6);
      assert.match(displayed.stderr, /2 of 2 contacts/);
      assert.equal(business(displayed).length, 1);
      assertOneConnection(displayed);
    }
  });

  await t.test('contact add sends supplied fields literally without content scope', async () => {
    const fields = { name: `张‘’‚‛'三`, nicknames: '老张; 张 三', notes: String.raw`中文 \\?\D:\项目 $() &|`,
      email: 'zhang+tag@example.test', employeeId: '工号[01]', role: '', department: '研发 & 产品',
      pinyinFull: 'zhang san', pinyinAbbr: 'zs' };
    const flags = { name: '--name', nicknames: '--nicknames', notes: '--notes', email: '--email',
      employeeId: '--employee-id', role: '--role', department: '--department', pinyinFull: '--pinyin-full', pinyinAbbr: '--pinyin-abbr' };
    const result = await f.run(['contact', 'add', ...Object.entries(fields).map(([key, value]) => `${flags[key]}=${value}`), '--json'], request => {
      assert.equal(request.method, 'contact.create');
      assert.deepEqual(Object.keys(request.params).sort(), ['fields', 'requestId']);
      assert.deepEqual(request.params.fields, fields);
      assert.equal(request.params.requestId, request.requestId);
      return { contact: { id: 18, revision: 1, ...fields }, operation: { requestId: request.requestId, operationId: 'isolated-create' } };
    });
    expectExit(result, 0);
    assert.deepEqual(JSON.parse(result.stdout).data.contact, { id: 18, revision: 1, ...fields });
    assert.equal(business(result).length, 1);
    assertOneConnection(result);
  });

  await t.test('contact update resolves CAS once and sends only supplied fields', async () => {
    const fields = { notes: '新备注 ‘’‚‛ $()', employeeId: '' };
    const result = await f.run(['contact', 'update', '18', '--notes', fields.notes, '--employee-id=', '--json'], request => {
      if (request.method === 'contact.get') {
        assert.deepEqual(request.params, { id: 18 });
        return { id: 18, revision: 9, name: '保持姓名', email: 'keep@example.test', notes: '旧备注', employeeId: '旧工号' };
      }
      assert.equal(request.method, 'contact.update');
      assert.deepEqual(request.params, { id: 18, baseRevision: 9, requestId: request.requestId, fields });
      return { contact: { id: 18, revision: 10, name: '保持姓名', email: 'keep@example.test', ...fields },
        operation: { requestId: request.requestId, operationId: 'isolated-update' } };
    });
    expectExit(result, 0);
    assert.deepEqual(business(result).map(call => call.method), ['contact.get', 'contact.update']);
    assert.equal(business(result)[0].requestId, business(result)[1].requestId);
    assert.equal(JSON.parse(result.stdout).data.contact.revision, 10);
    assertOneConnection(result);
    const explicit = await f.run(['contact', 'update', '--id=18', '--base-revision=10', '--notes=', '--json'], request => {
      assert.equal(request.method, 'contact.update', 'an explicit CAS baseline must not trigger an independent read');
      assert.deepEqual(request.params, { id: 18, baseRevision: 10, requestId: request.requestId, fields: { notes: '' } });
      return { contact: { id: 18, revision: 11, name: '保持姓名', notes: '' }, operation: { requestId: request.requestId } };
    });
    expectExit(explicit, 0);
    assert.equal(business(explicit).length, 1);
  });

  await t.test('PowerShell contact notes-file preserves Chinese, smart quotes, BOM and CRLF',
    { skip: ps ? false : 'PowerShell 7 unavailable; native-binary Contact DTO tests still execute' }, async () => {
      const file = path.join(f.root, "contact notes 中文 [‘’‚‛'quoted'].txt");
      const notes = `中文 ‘’‚‛'" \` $() &|;[]{}*?!%#<>=\r\n${String.raw`\\?\D:\商店 BA\排期`}\r\n`;
      await writeFile(file, utf8Bom(notes));
      const result = await f.run(['contact', 'update', '18', '--notes-file', file, '--json'], request => {
        if (request.method === 'contact.get') {
          assert.deepEqual(request.params, { id: 18 });
          return { id: 18, revision: 12, name: '保持姓名', email: 'keep@example.test' };
        }
        assert.equal(request.method, 'contact.update');
        assert.deepEqual(request.params, { id: 18, baseRevision: 12, requestId: request.requestId, fields: { notes } });
        return { contact: { id: 18, revision: 13, name: '保持姓名', notes }, operation: { requestId: request.requestId } };
      }, { shell: ps.executable });
      expectExit(result, 0);
      assert.equal(JSON.parse(result.stdout).data.contact.notes, notes);
      assert.deepEqual(business(result).map(call => call.method), ['contact.get', 'contact.update']);
      assertOneConnection(result);
    });
});
