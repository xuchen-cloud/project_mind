import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const defaultChunks = ['Local test ', 'provider reply.'];

function planResponse({ chunks = defaultChunks, delayMs = 0, initialDelayMs = 0, manual = false, status = 200, toolCalls } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new TypeError('chunks must be a nonempty array of strings');
  }
  for (const value of [delayMs, initialDelayMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('delays must be nonnegative integer milliseconds');
  }
  if (status !== 200 && (!Number.isInteger(status) || status < 400 || status > 599)) {
    throw new TypeError('status must be 200 or an HTTP error status');
  }
  let permits = 0;
  let wake;
  return {
    chunks: [...chunks], delayMs, initialDelayMs, manual, status, toolCalls,
    advance(count = 1) {
      if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('advance count must be positive');
      permits += count;
      wake?.();
    },
    async next(signal) {
      while (manual && permits === 0) {
        signal.throwIfAborted();
        await new Promise((resolve, reject) => {
          const abort = () => { wake = undefined; reject(signal.reason); };
          wake = () => { signal.removeEventListener('abort', abort); wake = undefined; resolve(); };
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (manual) permits -= 1;
      if (delayMs) await delay(delayMs, undefined, { signal });
      signal.throwIfAborted();
    },
  };
}

/**
 * Text-only deterministic provider, using Node built-ins. No real credentials required.
 * url is the /v1 API root; supports POST /chat/completions
 * and GET /models. Requests must ask for streaming.
 *
 * enqueueResponse({chunks, initialDelayMs, delayMs, manual, status}) queues a
 * one-shot response and returns {advance(count)}. A manual response gates each
 * text chunk until advanced; initial protocol events are sent immediately.
 * failNext(status = 400) queues one explicit HTTP failure, then normal replies
 * resume. Use 400 to avoid upstream retry policies consuming later responses.
 *
 * Captures contain structure only: no headers, URL queries, message text, tools,
 * metadata or arbitrary body fields. Use synthetic prompts even with this fixture.
 * UI prompt markers (only the latest user message is inspected):
 *   [local:slow] delays first text 1000ms, then each chunk 250ms.
 *   [local:fail] returns HTTP 400; send a new unmarked prompt to recover.
 * Queued responses take precedence over markers. Older history markers do not fire.
 * Records expose outcome ('streaming', 'completed', 'failed', 'aborted') for waits.
 * close() is idempotent and terminates pending/manual streams and sockets.
 */
export async function startLocalProvider({ chunks = defaultChunks, delayMs = 0, initialDelayMs = 0, maxRequests = 100, maxBodyBytes = 1024 * 1024, onSyntheticRequest } = {}) {
  const defaults = planResponse({ chunks, delayMs, initialDelayMs });
  for (const value of [maxRequests, maxBodyBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('limits must be positive integers');
  }
  const requests = [];
  const queue = [];
  const sockets = new Set();
  let closing;
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const { signal } = controller;
    res.on('close', () => controller.abort());
    let record;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const error = (status, message) => json(status, { type: 'error', error: { type: 'invalid_request_error', code: 'local_provider_error', message } });
    try {
      // Compare the raw path: query values never enter captures.
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/v1/models') {
        json(200, { object: 'list', data: [{ id: 'local-test-model', object: 'model', created: 0, owned_by: 'local-test' }] });
        return;
      }
      if (path !== '/v1/chat/completions') { error(404, 'Unknown fixture endpoint'); return; }
      if (req.method !== 'POST') { error(405, 'POST required'); return; }
      if (requests.length >= maxRequests) { error(429, 'Fixture request budget exceeded'); return; }
      let size = 0;
      const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > maxBodyBytes) { error(413, 'Fixture request body too large'); return; }
        parts.push(part);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { error(400, 'Invalid JSON'); return; }
      if (!body || typeof body.model !== 'string' || !body.model || !Array.isArray(body.messages) ||
          body.messages.some((message) => !message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) || body.stream !== true) {
        error(400, 'model, messages and stream:true required'); return;
      }
      // Enforce budget again after asynchronous input, including concurrent callers.
      if (requests.length >= maxRequests) { error(429, 'Fixture request budget exceeded'); return; }
      record = {
        id: requests.length + 1, method: 'POST', path, model: body.model,
        stream: true, messageCount: body.messages.length,
        roles: body.messages.map((message) => message.role), outcome: 'streaming',
      };
      requests.push(record);
      onSyntheticRequest?.(body);
      const content = body.messages.findLast((message) => message.role === 'user')?.content;
      const prompt = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : '';
      const plan = queue.shift() ?? planResponse(prompt.includes('[local:fail]')
        ? { status: 400 }
        : prompt.includes('[local:slow]') ? { chunks: defaults.chunks, initialDelayMs: 1000, delayMs: 250 } : defaults);
      if (plan.status !== 200) {
        record.outcome = 'failed';
        record.status = plan.status;
        error(plan.status, 'Explicit local provider failure');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      const id = `local-${record.id}`;
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const chat = (delta, finish_reason = null) => ({
        id, object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      send(chat({ role: 'assistant', content: '' }));
      if (plan.initialDelayMs) await delay(plan.initialDelayMs, undefined, { signal });
      for (const text of plan.chunks) {
        await plan.next(signal);
        send(chat({ content: text }));
      }
      if (plan.toolCalls) send(chat({ tool_calls: plan.toolCalls }));
      send(chat({}, plan.toolCalls ? 'tool_calls' : 'stop'));
      if (body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: plan.chunks.length, total_tokens: 1 + plan.chunks.length } });
      res.write('data: [DONE]\n\n');
      record.outcome = 'completed';
      record.status = 200;
      res.end();
    } catch (cause) {
      if (signal.aborted) {
        if (record?.outcome === 'streaming') record.outcome = 'aborted';
      } else {
        if (record) record.outcome = 'failed';
        if (!res.headersSent) error(500, 'Local fixture handler failed');
        else res.destroy(cause);
      }
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const enqueueResponse = (options) => {
    if (closing) throw new Error('Local provider is closed');
    const plan = planResponse(options);
    queue.push(plan);
    return { advance: plan.advance };
  };
  return {
    url, requests,
    enqueueResponse,
    failNext: (status = 400) => enqueueResponse({ status }),
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.close((cause) => cause ? reject(cause) : resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closing;
    },
  };
}
