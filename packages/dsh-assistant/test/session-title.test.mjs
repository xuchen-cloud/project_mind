import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { generateSessionTitleWithLlm, resolveSessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm';
import { sharedModelPatches } from '../scripts/shared-model.mjs';

const provider = { name: 'Synthetic main', modelId: 'synthetic-model', baseUrl: 'https://example.test/v1', supportsImage: false };
const base = loadOverlayPatches('title-test', fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', import.meta.url)));
const upstream = base.flatMap(patch => patch.insert ?? []).find(row => row.id === 'session-title-llm').config;
const config = resolveSessionTitleLlmConfig(sharedModelPatches(provider).find(row => row.id === 'session-title-llm')?.config ?? upstream);

async function generate(text, thinkingTokens = 0, { calls = [], appended = [] } = {}) {
  const messages = [{ seq: 8, text }];
  const ctx = { llm: { async *stream(options) {
    calls.push(options);
    if (thinkingTokens) yield { type: 'reasoning-delta', index: 0, text: 'Synthetic private reasoning' };
    if (options.maxTokens <= thinkingTokens) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
      return;
    }
    yield { type: 'text-delta', index: 1, text: '项目会话联动验收' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const request = {
    session: { id: 'synthetic-session', append(type, data) { appended.push({ type, data }); } },
    messages, route: { provider: 'mind-main', model: provider.modelId }, signal: new AbortController().signal,
  };
  const result = await generateSessionTitleWithLlm(ctx, config, request, messages, 'session-title-first-prompt-llm');
  return { result, calls, appended, messages };
}

test('first-prompt title can finish after a reasoning response instead of retaining its clipped fallback', async () => {
  // A short reasoning response alone exceeds rc.2's 64-token output cap.
  const text = '请先帮我检查项目中的会话、记录和待办是否能正确联动，然后整理验收结论。';
  const { result, calls, messages } = await generate(text, 96);
  assert.equal(result.title, '项目会话联动验收');
  assert.ok(!text.startsWith(result.title));
  assert.deepEqual(result.messageSeqs, [8]);
  assert.deepEqual(result.model, { provider: 'mind-main', model: provider.modelId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'session-title');
  assert.equal(calls[0].maxTokens, 1024);
  assert.ok(calls[0].system.includes('Use the language of the messages.'));
  assert.ok(calls[0].system.includes('5 words in non-CJK languages or 10 CJK characters'));
  assert.deepEqual(messages, [{ seq: 8, text }], 'title generation does not rewrite the original prompt');
});

test('a multi-paragraph Chinese first question is summarized rather than rejected at 4096 bytes', async () => {
  const text = '请检查项目会话联动。\n' + '验收包含待办状态、记录修订、文件版本和今日计划。\n'.repeat(90);
  assert.ok(Buffer.byteLength(text) > 4096);
  const { result, calls, appended } = await generate(text);
  assert.equal(result.title, '项目会话联动验收');
  const framed = calls[0].messages[0].content[0].text;
  assert.deepEqual(JSON.parse(framed.slice(framed.indexOf('\n') + 1)), [{ seq: 8, text }]);
  assert.equal(appended[0].type, 'session/title-llm-request');
});

test('the framed UTF-8 input fits at the byte limit and rejects overflow without dispatch or clipping', async () => {
  const sample = '项目\n"\\';
  const { calls: sampleCalls } = await generate(sample);
  const sampleBytes = Buffer.byteLength(sampleCalls[0].messages[0].content[0].text);
  const text = sample + 'a'.repeat(config.maxInputBytes - sampleBytes);
  const { calls } = await generate(text);
  const framed = calls[0].messages[0].content[0].text;
  assert.equal(Buffer.byteLength(framed), 32768);
  assert.deepEqual(JSON.parse(framed.slice(framed.indexOf('\n') + 1)), [{ seq: 8, text }]);
  const rejectedCalls = [], appended = [];
  await assert.rejects(generate(text + 'a', 0, { calls: rejectedCalls, appended }), /exceeding maxInputBytes 32768/);
  assert.equal(rejectedCalls.length, 0);
  assert.equal(appended.length, 0);
});

test('reasoning that exhausts the bounded output budget is rejected without treating it as a title', async () => {
  const calls = [], appended = [];
  await assert.rejects(generate('请检查项目会话。', 1024, { calls, appended }), /title output reached maxOutputTokens/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, 1024);
  assert.deepEqual(appended.map(event => event.type), ['session/title-llm-request']);
});

test('title policy keeps upstream language-aware short titles and bounded auxiliary work', () => {
  assert.equal(config.targetWords, upstream.targetWords);
  assert.equal(config.targetCjkCharacters, upstream.targetCjkCharacters);
  assert.equal(config.timeoutMs, upstream.timeoutMs);
  assert.equal(config.maxInputBytes, 32768);
  assert.equal(config.maxOutputTokens, 1024);
  assert.deepEqual(sharedModelPatches(provider).find(row => row.id === 'agent-default-model').config,
    { provider: 'mind-main', model: provider.modelId });
});
