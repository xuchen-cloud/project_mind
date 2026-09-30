import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiProbe } from '../../src/pi-spike.mjs';

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
