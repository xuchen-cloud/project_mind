import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalProvider } from './fixtures/local-provider.mjs';

const message = (content = 'Synthetic prompt') => ({ role: 'user', content });
const post = (provider, messages = [message()], options = {}, query = '') => fetch(`${provider.url}/chat/completions${query}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-test-token', 'x-api-key': 'secret-api-key' },
  body: JSON.stringify({ model: 'local-test-model', stream: true, messages, ...options }),
});
const frames = (text) => text.trim().split('\n\n').map((frame) => {
  assert.ok(frame.startsWith('data: '));
  const data = frame.slice(6);
  return data === '[DONE]' ? data : JSON.parse(data);
});
const textOf = (events) => events.filter((event) => event !== '[DONE]').map((event) => event.choices[0]?.delta.content ?? '').join('');
async function fixture(t, options) {
  const provider = await startLocalProvider(options);
  t.after(() => provider.close());
  return provider;
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for fixture state');
}

test('loopback ephemeral API advertises a model and streams deterministic OpenAI frames and usage', async (t) => {
  const provider = await fixture(t, { chunks: ['Hello ', '世界'] });
  assert.match(provider.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/v1$/);
  const models = await (await fetch(`${provider.url}/models`)).json();
  assert.equal(models.data[0].id, 'local-test-model');
  const response = await post(provider, undefined, { stream_options: { include_usage: true } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = frames(await response.text());
  assert.equal(textOf(events), 'Hello 世界');
  assert.deepEqual(events[0].choices, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
  assert.equal(events[3].choices[0].finish_reason, 'stop');
  assert.deepEqual(events[4].usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  assert.deepEqual(events[4].choices, []);
  assert.equal(events[5], '[DONE]');
  for (const event of events.slice(0, -1)) {
    assert.equal(event.id, 'local-1');
    assert.equal(event.object, 'chat.completion.chunk');
    assert.equal(event.model, 'local-test-model');
    assert.equal(event.created, 0);
  }
});

test('captures multi-turn structure without headers, content, metadata or query secrets', async (t) => {
  const provider = await fixture(t);
  await (await post(provider, [message('secret-prompt')], { metadata: { api_key: 'secret-metadata' } }, '?key=secret-query')).text();
  await (await post(provider, [message('secret-prompt'), { role: 'assistant', content: 'secret-reply' }, message('Follow up')])).text();
  assert.deepEqual(provider.requests.map(({ id, roles, messageCount, outcome }) => ({ id, roles, messageCount, outcome })), [
    { id: 1, roles: ['user'], messageCount: 1, outcome: 'completed' },
    { id: 2, roles: ['user', 'assistant', 'user'], messageCount: 3, outcome: 'completed' },
  ]);
  assert.ok(!JSON.stringify(provider.requests).includes('secret'));
});

test('manual chunks are observable incrementally and one-shot failure recovers', async (t) => {
  const provider = await fixture(t);
  const control = provider.enqueueResponse({ manual: true, chunks: ['first', 'second'] });
  const response = await post(provider);
  const reader = response.body.getReader();
  const decode = new TextDecoder();
  assert.match(decode.decode((await reader.read()).value), /"role":"assistant"/);
  let arrived = false;
  const pending = reader.read().then((value) => { arrived = true; return value; });
  await delay(30);
  assert.equal(arrived, false);
  control.advance();
  assert.match(decode.decode((await pending).value), /"content":"first"/);
  assert.equal(provider.requests[0].outcome, 'streaming');
  control.advance();
  let rest = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest += decode.decode(value); }
  assert.match(rest, /"content":"second"/);
  assert.match(rest, /\[DONE\]/);
  const { failNext } = provider;
  failNext(503);
  const failure = await post(provider);
  assert.equal(failure.status, 503);
  assert.equal((await failure.json()).error.message, 'Explicit local provider failure');
  assert.equal(textOf(frames(await (await post(provider)).text())), 'Local test provider reply.');
  assert.deepEqual(provider.requests.map((request) => request.outcome), ['completed', 'failed', 'completed']);
});

test('timed mode sends headers before text and respects initial delay', async (t) => {
  const provider = await fixture(t);
  provider.enqueueResponse({ chunks: ['delayed'], initialDelayMs: 100, delayMs: 20 });
  const response = await post(provider);
  assert.equal(provider.requests[0].outcome, 'streaming');
  const start = performance.now();
  const result = await response.text();
  assert.ok(performance.now() - start >= 80, 'text must remain delayed after headers');
  assert.equal(textOf(frames(result)), 'delayed');
});

test('aborting a paused stream releases it and subsequent requests work', async (t) => {
  const provider = await fixture(t);
  provider.enqueueResponse({ manual: true });
  const response = await post(provider);
  await response.body.cancel();
  await until(() => provider.requests[0].outcome === 'aborted');
  assert.equal(textOf(frames(await (await post(provider)).text())), 'Local test provider reply.');
});

test('UI markers act only on latest user text and queue controls override them', async (t) => {
  const provider = await fixture(t);
  const failed = await post(provider, [message('[local:fail]')]);
  assert.equal(failed.status, 400);
  await failed.text();
  assert.equal(textOf(frames(await (await post(provider, [message('[local:fail]'), message('Recover')])).text())), 'Local test provider reply.');
  const slow = await post(provider, [message([{ type: 'text', text: '[local:slow]' }])]);
  await delay(30);
  assert.equal(provider.requests[2].outcome, 'streaming');
  await slow.body.cancel();
  await until(() => provider.requests[2].outcome === 'aborted');
  provider.enqueueResponse({ chunks: ['override'] });
  assert.equal(textOf(frames(await (await post(provider, [message('[local:fail] [local:slow]')])).text())), 'override');
});

test('invalid input, unknown routes, methods and resource limits return explicit errors', async (t) => {
  const provider = await fixture(t, { maxRequests: 1, maxBodyBytes: 200 });
  assert.equal((await fetch(`${provider.url}/unknown`)).status, 404);
  assert.equal((await fetch(`${provider.url}/chat/completions`)).status, 405);
  assert.equal((await fetch(`${provider.url}/chat/completions`, { method: 'POST', body: '{broken' })).status, 400);
  assert.equal((await post(provider, undefined, { stream: false })).status, 400);
  assert.equal((await post(provider, [message('x'.repeat(300))])).status, 413);
  assert.equal(provider.requests.length, 0);
  await (await post(provider)).text();
  assert.equal((await post(provider)).status, 429);
  assert.equal(provider.requests.length, 1);
});

test('close terminates paused streams, is idempotent and releases the listening port', async (t) => {
  const provider = await fixture(t);
  provider.enqueueResponse({ manual: true });
  const response = await post(provider);
  const consuming = response.text();
  const rejected = assert.rejects(consuming);
  const firstClose = provider.close();
  assert.equal(provider.close(), firstClose);
  await firstClose;
  await rejected;
  await until(() => provider.requests[0].outcome === 'aborted');
  await assert.rejects(fetch(`${provider.url}/models`));
  assert.throws(() => provider.enqueueResponse({}), /closed/);
});

test('control validation rejects invalid scenarios before serving', async () => {
  await assert.rejects(startLocalProvider({ maxRequests: 0 }), /limits/);
  await assert.rejects(startLocalProvider({ delayMs: -1 }), /delays/);
  const provider = await startLocalProvider();
  try {
    assert.throws(() => provider.enqueueResponse({ chunks: [] }), /chunks/);
    assert.throws(() => provider.failNext(201), /status/);
    assert.throws(() => provider.enqueueResponse({ manual: true }).advance(0), /positive/);
  } finally { await provider.close(); }
});
