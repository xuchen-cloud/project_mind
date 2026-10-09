import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiProbe, createPiSession } from '../../src/pi-spike.mjs';
import { PROBE_TOOLS } from '../../src/tool-descriptors.mjs';
import { decodeSession, encodeSession } from '../../src/session-codec.mjs';

async function fixture(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const json = JSON.parse(body);
    requests.push(json);
    handler(json, response, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

function sse(response, delta, finishReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk',
    created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk',
    created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('restricted Pi SDK calls scoped tools, settles, and resumes the SDK history after a Workspace move', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-工作区-'));
  const moved = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-moved-'));
  const provider = await fixture((_request, response, round) => {
    if (round <= 2) sse(response, { role: 'assistant', tool_calls: [{ index: 0,
      id: `call-${round}`, type: 'function', function: { name: round === 1 ? 'mind_source_read' : 'mind_output_stage',
        arguments: JSON.stringify({ payload: round === 1 ? 'allowed-record' : 'saved answer' }) } }] }, 'tool_calls');
    else sse(response, { role: 'assistant', content: 'Saved the scoped answer.' }, 'stop');
  });
  const calls = [];
  const events = [];
  const sessionId = '1'.repeat(32);
  const options = { sessionId, baseUrl: provider.baseUrl, modelId: 'fixture', apiKey: 'fixture-secret',
    dispatchTool: async (call) => { calls.push(call.method); return { ref: 'record:1', text: call.payload }; } };
  let probe;
  try {
    // Default discovery would import these user/project files; the custom loader must ignore them.
    await mkdir(path.join(root, '.pi'), { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), 'DO NOT DISCOVER THIS PRIVATE FILE');
    await writeFile(path.join(root, '.pi', 'settings.json'), '{"defaultTools":["bash","write"]}');
    probe = await createPiProbe({ ...options, workspaceRoot: root, onEvent: (event) => events.push(event.type) });
    assert.deepEqual(probe.activeTools().sort(), ['mind_output_stage', 'mind_source_read']);
    const checkpoint = await probe.prompt('Read the source and stage an answer.');
    assert.deepEqual(calls, ['source.read', 'output.stage']);
    assert.ok(events.includes('tool_execution_end'));
    assert.equal(events.at(-1), 'agent_settled');
    assert.ok(checkpoint.jsonl.includes('Saved the scoped answer.'));
    assert.ok(!checkpoint.jsonl.includes(root));
    assert.ok(!checkpoint.jsonl.includes('fixture-secret'));
    for (const request of provider.requests) {
      assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ['mind_output_stage', 'mind_source_read']);
      assert.ok(!JSON.stringify(request).includes(root));
      assert.ok(!JSON.stringify(request).includes('DO NOT DISCOVER'));
    }
    assert.equal(await readFile(path.join(root, '.pi', 'settings.json'), 'utf8'), '{"defaultTools":["bash","write"]}');
    await probe.dispose();
    probe = await createPiProbe({ ...options, workspaceRoot: moved, checkpoint });
    await probe.prompt('Continue from the saved answer.');
    const resumedRequest = provider.requests.at(-1);
    assert.ok(JSON.stringify(resumedRequest.messages).includes('Saved the scoped answer.'));
    assert.ok(JSON.stringify(resumedRequest.messages).includes('saved answer'));
    assert.ok(!JSON.stringify(resumedRequest.messages).includes(moved));
  } finally {
    await probe?.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test('Pi abort waits for settlement and retains the cancelled prompt', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-cancel-'));
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const provider = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    started();
  });
  const events = [];
  const probe = await createPiProbe({ workspaceRoot: root, sessionId: '2'.repeat(32),
    baseUrl: provider.baseUrl, modelId: 'fixture', apiKey: 'fixture-secret',
    dispatchTool: async () => { throw new Error('No tool should execute'); }, onEvent: (event) => events.push(event.type) });
  try {
    const running = probe.prompt('Cancelled prompt stays in history.');
    await requestStarted;
    await probe.cancel();
    const checkpoint = await running;
    assert.equal(events.at(-1), 'agent_settled');
    assert.ok(checkpoint.jsonl.includes('Cancelled prompt stays in history.'));
    assert.ok(checkpoint.jsonl.includes('aborted'));
  } finally {
    await probe.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider context checks each round and leaves the original checkpoint intact', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-context-'));
  const provider = await fixture((_request, response, round) => {
    if (round === 1 || round === 3) sse(response, { role: 'assistant',
      content: round === 1 ? 'OLD PUBLIC TEXT' : undefined, tool_calls: [{ index: 0,
      id: round === 1 ? 'call-old' : 'call-current', type: 'function', function: { name: 'mind_source_read',
        arguments: JSON.stringify({ payload: round === 1 ? 'old-tool' : 'current-tool' }) } }] }, 'tool_calls');
    else sse(response, { role: 'assistant', content: round === 2 ? 'OLD PRIVATE ANSWER' : 'Current answer' }, 'stop');
  });
  const sessionId = '3'.repeat(32);
  const options = { workspaceRoot: root, sessionId, baseUrl: provider.baseUrl,
    modelId: 'fixture', apiKey: 'fixture-secret', tools: [PROBE_TOOLS[0]],
    dispatchTool: async (call) => ({ text: call.toolCallId === 'call-old'
      ? 'OLD PRIVATE TOOL RESULT' : 'CURRENT TOOL RESULT' }) };
  let session;
  try {
    session = await createPiSession(options);
    const saved = await session.prompt('Historical authorized user text');
    await session.dispose();
    session = undefined;
    const entries = decodeSession(saved.jsonl, root, sessionId, saved.checksum);
    const userId = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user').id;
    const oldCallId = entries.find((entry) => entry.type === 'message' && entry.message.role === 'assistant'
      && entry.message.content.some((part) => part.type === 'toolCall')).id;
    const oldResultId = entries.find((entry) => entry.type === 'message' && entry.message.role === 'toolResult').id;
    const summaryId = 'synthetic-branch-summary';
    entries.push({ type: 'branch_summary', id: summaryId, parentId: saved.leafId,
      timestamp: new Date().toISOString(), fromId: userId, summary: 'SYNTHETIC PRIVATE SUMMARY' });
    const checkpoint = { ...encodeSession(entries, root), leafId: summaryId };
    const checks = [];
    session = await createPiSession({ ...options, checkpoint, historyPolicy: async (call) => {
      checks.push(call);
      return { allowedEntryIds: checks.length === 1 ? [userId, oldCallId] : [userId, oldResultId] };
    } });
    const result = await session.prompt('Fresh prompt');
    assert.equal(checks.length, 2);
    assert.deepEqual(checks.map((call) => call.method), ['session.context.check', 'session.context.check']);
    assert.deepEqual(checks.map((call) => call.toolCallId), ['context-check-1', 'context-check-2']);
    const expectedCandidates = entries.filter((entry) => entry.type === 'message').map((entry) => entry.id);
    for (const check of checks) {
      assert.deepEqual(check.payload.entryIds, expectedCandidates);
      assert.ok(!check.payload.entryIds.includes(summaryId));
    }
    for (const request of provider.requests.slice(2)) {
      const context = JSON.stringify(request.messages);
      assert.ok(context.includes('Historical authorized user text'));
      assert.ok(context.includes('Fresh prompt'));
      assert.ok(!context.includes('OLD PRIVATE ANSWER'));
      assert.ok(!context.includes('OLD PRIVATE TOOL RESULT'));
      assert.ok(!context.includes('call-old'));
      assert.ok(!context.includes('SYNTHETIC PRIVATE SUMMARY'));
    }
    assert.ok(JSON.stringify(provider.requests[2].messages).includes('OLD PUBLIC TEXT'));
    assert.ok(JSON.stringify(provider.requests[3].messages).includes('CURRENT TOOL RESULT'));
    assert.equal(result.jsonl.slice(0, checkpoint.jsonl.length), checkpoint.jsonl);
  } finally {
    await session?.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed context check blocks the provider request', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-context-fail-'));
  const provider = await fixture((_request, response) => sse(response, { role: 'assistant', content: 'old' }, 'stop'));
  const options = { workspaceRoot: root, sessionId: '4'.repeat(32), baseUrl: provider.baseUrl,
    modelId: 'fixture', apiKey: 'fixture-secret', dispatchTool: async () => ({}) };
  let session;
  try {
    session = await createPiSession(options);
    const checkpoint = await session.prompt('Old user');
    await session.dispose();
    session = await createPiSession({ ...options, checkpoint, historyPolicy: async () => {
      throw new Error('Native denied history');
    } });
    await session.prompt('New user');
    assert.equal(provider.requests.length, 1);
  } finally {
    await session?.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('compacted history check lists only messages still loaded for context', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mind-pi-compacted-'));
  const provider = await fixture((_request, response) => sse(response, { role: 'assistant', content: 'Old retained answer' }, 'stop'));
  const options = { workspaceRoot: root, sessionId: '5'.repeat(32), baseUrl: provider.baseUrl,
    modelId: 'fixture', apiKey: 'fixture-secret', dispatchTool: async () => ({}) };
  let session;
  try {
    session = await createPiSession(options);
    const saved = await session.prompt('Old compacted user');
    await session.dispose();
    session = undefined;
    const entries = decodeSession(saved.jsonl, root, options.sessionId, saved.checksum);
    const retainedId = entries.find((entry) => entry.type === 'message' && entry.message.role === 'assistant').id;
    const compactionId = 'synthetic-compaction';
    entries.push({ type: 'compaction', id: compactionId, parentId: saved.leafId,
      timestamp: new Date().toISOString(), summary: 'SYNTHETIC COMPACTION SUMMARY',
      firstKeptEntryId: retainedId, tokensBefore: 100 });
    const checkpoint = { ...encodeSession(entries, root), leafId: compactionId };
    const checks = [];
    session = await createPiSession({ ...options, checkpoint, historyPolicy: async (call) => {
      checks.push(call);
      return { allowedEntryIds: [retainedId] };
    } });
    const result = await session.prompt('New prompt');
    assert.deepEqual(checks.map((call) => call.payload.entryIds), [[retainedId]], result.jsonl.slice(checkpoint.jsonl.length));
    assert.equal(provider.requests.length, 2, result.jsonl.slice(checkpoint.jsonl.length));
    const context = JSON.stringify(provider.requests[1].messages);
    assert.ok(context.includes('Old retained answer'));
    assert.ok(context.includes('New prompt'));
    assert.ok(!context.includes('Old compacted user'));
    assert.ok(!context.includes('SYNTHETIC COMPACTION SUMMARY'));
  } finally {
    await session?.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
