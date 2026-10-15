import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createSourceBridge, sourceTitleText } from '../scripts/source-bridge.mjs';

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

test('title input preserves ordinary paths and malformed source literals without interpreting them', () => {
  const ordinary = '@ordinary/path unchanged title';
  assert.equal(sourceTitleText(ordinary), ordinary);
  const metadata = JSON.stringify({ sourceRef: { title: 'sample.txt', fileVersion: 1 }, content: 'literal user text' });
  const literals = [
    `@mind-source/A/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
    `@mind-source/${Buffer.from('{"title":').toString('base64url')}/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
    '<mind-file-source>{invalid JSON}</mind-file-source>',
    '<mind-file-source>{"sourceRef":null}</mind-file-source>',
    ...[{ title: 42, fileVersion: 1 }, { fileVersion: 1 }, { title: 'sample.txt', fileVersion: 0 }, { title: 'sample.txt', fileVersion: '1' }].map(sourceRef => `<mind-file-source>${JSON.stringify({ sourceRef })}</mind-file-source>`),
    `@mind-source/${Buffer.from(JSON.stringify({ title: 'other.txt', fileVersion: 1 })).toString('base64url')}/sample.txt\n<mind-file-source>${metadata}</mind-file-source>`,
  ];
  for (const literal of literals) assert.equal(sourceTitleText(`prompt${literal}`), `prompt${literal}`);
});
