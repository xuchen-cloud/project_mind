import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createSourceBridge } from '../scripts/source-bridge.mjs';

test('source stdio correlates out-of-order responses and revokes pending reads on parent close', async () => {
  const stdin = new PassThrough();
  const input = createInterface({ input: stdin });
  const frames = [];
  const bridge = createSourceBridge(input, line => frames.push(JSON.parse(line.slice('MIND_DSH_SOURCE '.length))));
  const first = bridge.request({ operation: 'prepare', sessionId: 'a', path: 'old.md' });
  const second = bridge.request({ operation: 'prepare', sessionId: 'b', path: 'new.md' });
  stdin.write(JSON.stringify({ type: 'mind-source-response', id: frames[1].id, result: { ok: true, value: { projection: 'B' } } }) + '\n');
  stdin.write(JSON.stringify({ type: 'mind-source-response', id: frames[0].id, result: { ok: true, value: { projection: 'A' } } }) + '\n');
  assert.equal((await first).projection, 'A');
  assert.equal((await second).projection, 'B');
  const pending = bridge.request({ operation: 'prepare', sessionId: 'a', path: 'pending.md' });
  input.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(bridge.request({ operation: 'prepare' }), /closed/);
});
