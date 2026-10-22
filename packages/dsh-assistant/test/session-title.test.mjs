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

async function generate(text, thinkingTokens = 0) {
  const messages = [{ seq: 8, text }];
  const calls = [], appended = [];
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

test('title policy keeps upstream language-aware short titles and bounded auxiliary work', () => {
  assert.equal(config.targetWords, upstream.targetWords);
  assert.equal(config.targetCjkCharacters, upstream.targetCjkCharacters);
  assert.equal(config.timeoutMs, upstream.timeoutMs);
  assert.ok(config.maxInputBytes <= 32768);
  assert.ok(config.maxOutputTokens <= 1024);
  assert.deepEqual(sharedModelPatches(provider).find(row => row.id === 'agent-default-model').config,
    { provider: 'mind-main', model: provider.modelId });
});
