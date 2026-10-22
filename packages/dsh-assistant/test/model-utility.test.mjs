import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const entry = new URL('../scripts/model-utility-entry.mjs', import.meta.url);
const profile = baseUrl => ({ providerFamily: 'openai_compatible', baseUrl,
  defaultModel: 'fixture-model', supportsText: true, enabled: true });
const frame = baseUrl => ({ operation: 'generate', profile: profile(baseUrl), modelId: 'fixture-model',
  apiKey: 'synthetic-secret', prompt: 'A synthetic prompt',
  capacity: { contextWindow: 32768, maxTokens: 4096, source: 'conservative' } });

function launch(input, options = {}) {
  const child = spawn(process.execPath, [entry.pathname], { env: { ...process.env,
    OPENAI_API_KEY: 'ambient-key-must-not-be-used', ...options.env },
    cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const result = once(child, 'close').then(([code]) => {
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, stdout);
    return JSON.parse(lines[0]);
  });
  if (input !== undefined) child.stdin.end(typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input));
  return { child, result, output: () => stdout };
}
const run = input => launch(input).result;

async function provider(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(body.stream, true);
    await handler(body, res, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function response(res, { text = 'Answer 😀', finish = 'stop', tool, usage = 8 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  send({ role: 'assistant' });
  if (text) send({ content: text });
  if (tool) send({ tool_calls: [{ index: 0, id: 'call_nonce', type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] });
  send({}, finish);
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12,
    completion_tokens: usage, total_tokens: 12 + usage } })}\n\ndata: [DONE]\n\n`);
  res.end();
}

test('capacity resolves through DSH and explicitly falls back for a custom model', async () => {
  const fallback = await run({ operation: 'capacity', profile: profile('http://127.0.0.1:1/v1'), modelId: 'fixture-model' });
  assert.deepEqual(fallback, { ok: true, data: { inputBytes: 27648, outputTokens: 4096,
    contextWindow: 32768, maxTokens: 4096, source: 'conservative' } });
  const known = await run({ operation: 'capacity', profile: profile('https://api.openai.com/v1'), modelId: 'gpt-4o' });
  assert.equal(known.ok, true);
  assert.equal(known.data.source, 'dsh-catalog');
  assert.equal(known.data.contextWindow, 128000);
  assert.ok(known.data.maxTokens >= 4096);
  assert.equal(known.data.outputTokens, 4096);
});

test('generation uses the DSH HTTP adapter with no tools and bounded output tokens', async t => {
  const mock = await provider(t, (body, res) => {
    assert.ok(!body.tools?.length);
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 4096);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'A synthetic prompt' }]);
    response(res);
  });
  const result = await run(frame(mock.url));
  assert.equal(result.ok, true);
  assert.equal(result.data.text, 'Answer 😀');
  assert.equal(result.data.usage.inputTokens, 12);
  assert.equal(result.data.usage.outputTokens, 8);
  assert.equal(mock.requests.length, 1);
});

test('probe verifies a nonce schema call, result correlation, and second answer', async t => {
  const mock = await provider(t, (body, res, index) => {
    if (index === 1) {
      const tool = body.tools[0].function;
      assert.equal(tool.parameters.additionalProperties, false);
      response(res, { text: '', finish: 'tool_calls', tool: { name: tool.name,
        arguments: { nonce: tool.parameters.properties.nonce.const } } });
    } else {
      assert.equal(index, 2);
      assert.ok(!body.tools?.length);
      assert.equal(body.messages.at(-1).role, 'tool');
      assert.equal(body.messages.at(-1).tool_call_id, 'call_nonce');
      response(res, { text: JSON.parse(body.messages.at(-1).content).answer });
    }
  });
  assert.deepEqual(await run({ ...frame(mock.url), operation: 'probe' }),
    { ok: true, data: { toolCallingVerified: true } });
  assert.equal(mock.requests.length, 2);
});

for (const [name, plan, code] of [
  ['empty', { text: '  ' }, 'MODEL_FAILED'],
  ['length', { finish: 'length' }, 'BUDGET_EXCEEDED'],
  ['output Unicode overflow', { text: '😀'.repeat(24001) }, 'BUDGET_EXCEEDED'],
  ['usage overflow', { usage: 4097 }, 'BUDGET_EXCEEDED'],
  ['unexpected tool', { tool: { name: 'unexpected', arguments: {} }, finish: 'tool_calls' }, 'TOOL_CALL_UNSUPPORTED'],
]) test(`generation rejects ${name}`, async t => {
  const mock = await provider(t, (_body, res) => response(res, plan));
  assert.deepEqual(await run(frame(mock.url)), { ok: false, error: { code } });
});

test('24000 astral Unicode codepoints are accepted', async t => {
  const mock = await provider(t, (_body, res) => response(res, { text: '😀'.repeat(24000) }));
  const result = await run(frame(mock.url));
  assert.equal(result.ok, true);
  assert.equal([...result.data.text].length, 24000);
  assert.ok([...result.data.text].every(char => char === '😀'));
});

test('provider failures expose only a generic code and no credential or provider error', async t => {
  const mock = await provider(t, (_body, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'synthetic-secret private provider diagnostics' } }));
  });
  assert.deepEqual(await run(frame(mock.url)), { ok: false, error: { code: 'MODEL_FAILED' } });
  assert.equal(mock.requests.length, 1);
});

for (const mismatch of ['no-tool', 'wrong-nonce', 'wrong-name', 'wrong-answer']) {
  test(`probe rejects ${mismatch}`, async t => {
    const mock = await provider(t, (body, res, index) => {
      if (mismatch === 'no-tool') return response(res);
      if (index === 2) return response(res, { text: 'invented answer' });
      const tool = body.tools[0].function;
      response(res, { text: '', finish: 'tool_calls', tool: {
        name: mismatch === 'wrong-name' ? 'unexpected' : tool.name,
        arguments: { nonce: mismatch === 'wrong-nonce' ? 'wrong' : tool.parameters.properties.nonce.const },
      } });
    });
    assert.deepEqual(await run({ ...frame(mock.url), operation: 'probe' }),
      { ok: false, error: { code: 'TOOL_CALL_UNSUPPORTED' } });
  });
}

test('input byte and context token budgets reject before any HTTP request', async () => {
  for (const input of [
    { prompt: 'x'.repeat(27649) },
    { prompt: '中'.repeat(10000) },
    { prompt: 'x'.repeat(2 * 1024 * 1024 + 1), capacity: { contextWindow: 4000000, maxTokens: 4096, source: 'dsh-catalog' } },
  ]) assert.deepEqual(await run({ ...frame('http://127.0.0.1:1/v1'), ...input }),
    { ok: false, error: { code: 'BUDGET_EXCEEDED' } });
});

test('stream overflow aborts the upstream connection', async t => {
  let aborted;
  const closed = new Promise(resolve => { aborted = resolve; });
  const mock = await provider(t, (_body, res) => {
    res.on('close', aborted);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x'.repeat(24001) }, finish_reason: null }] })}\n\n`);
  });
  assert.deepEqual(await run(frame(mock.url)), { ok: false, error: { code: 'BUDGET_EXCEEDED' } });
  await closed;
});

test('internal timeout cancels a stalled HTTP provider', async t => {
  let aborted;
  const closed = new Promise(resolve => { aborted = resolve; });
  const mock = await provider(t, (_body, res) => { res.on('close', aborted); });
  assert.deepEqual(await run({ ...frame(mock.url), timeoutMs: 1000 }),
    { ok: false, error: { code: 'BUDGET_EXCEEDED' } });
  await closed;
});

test('native SIGTERM cancels a stalled provider and emits one sanitized response', async t => {
  let received, aborted;
  const ready = new Promise(resolve => { received = resolve; });
  const closed = new Promise(resolve => { aborted = resolve; });
  const mock = await provider(t, (_body, res) => { res.on('close', aborted); received(); });
  const child = launch(frame(mock.url));
  await ready;
  child.child.kill('SIGTERM');
  assert.deepEqual(await child.result, { ok: false, error: { code: 'CANCELLED' } });
  await closed;
});

test('caller HOME, .env and DSH config are never loaded and no session files are written', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'mind-model-utility-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, '.env'), 'OPENAI_API_KEY=untrusted-env-key\n');
  await writeFile(path.join(home, 'cordis.yml'), 'invalid: [config that must not load');
  const before = await readdir(home);
  const mock = await provider(t, (_body, res) => response(res));
  const result = await launch(frame(mock.url), { cwd: home,
    env: { HOME: home, DSH_HOME: home, PROJECT_MIND_DSH_PROFILE_DIR: home } }).result;
  assert.equal(result.ok, true);
  assert.deepEqual(await readdir(home), before);
});

test('entry consumes exactly one JSON frame through EOF', async () => {
  const request = { operation: 'capacity', profile: profile('http://127.0.0.1:1/v1'), modelId: 'fixture-model' };
  const child = launch();
  child.child.stdin.write(JSON.stringify(request) + '\n');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.output(), '');
  child.child.stdin.end();
  assert.equal((await child.result).ok, true);
  for (const raw of ['', '{', JSON.stringify(request) + '\n' + JSON.stringify(request),
    Buffer.from([0xff])]) {
    assert.deepEqual(await run(raw), { ok: false, error: { code: 'INVALID_REQUEST' } });
  }
});

test('frame bytes above 16MiB are rejected', async () => {
  assert.deepEqual(await run(' '.repeat(16 * 1024 * 1024 + 1)),
    { ok: false, error: { code: 'BUDGET_EXCEEDED' } });
});

test('invalid/disabled profiles, unsupported family, missing credentials and capacity reject', async () => {
  const input = frame('http://127.0.0.1:1/v1');
  for (const patch of [{ profile: { ...input.profile, enabled: false } },
    { profile: { ...input.profile, supportsText: false } },
    { profile: { ...input.profile, baseUrl: 'https://user:synthetic-secret@example.com/v1' } },
    { apiKey: '' }, { capacity: { contextWindow: 1, maxTokens: -1, source: 'fake' } },
    { operation: 'unknown' }]) {
    const result = await run({ ...input, ...patch });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.error), ['code']);
  }
  assert.deepEqual(await run({ ...input, profile: { ...input.profile, providerFamily: 'gemini_compatible' } }),
    { ok: false, error: { code: 'TOOL_CALL_UNSUPPORTED' } });
});
