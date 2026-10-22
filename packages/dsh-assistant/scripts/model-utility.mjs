// One-shot DSH model calls. No application boot, session, workspace, settings,
// credential discovery, or persistent storage is mounted here.
import { randomBytes } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm/message';
import * as piAiPlugin from '@deepseek-ai/dsh-llm-pi-ai';

export const FRAME_BYTES = 16 * 1024 * 1024;
const INPUT_BYTES = 2 * 1024 * 1024;
const OUTPUT_TOKENS = 4096;
const OUTPUT_CHARS = 24000;
const CONTEXT_RESERVE = 1024;
const ROUTE = 'mind-model-utility';
const KEY_REF = 'MIND_MODEL_UTILITY_KEY';
const SETTINGS_NS = 'llm-pi-ai';
const FALLBACK = { contextWindow: 32768, maxTokens: 4096, source: 'conservative' };
const CODES = new Set(['INVALID_REQUEST', 'PROFILE_UNAVAILABLE', 'TOOL_CALL_UNSUPPORTED',
  'BUDGET_EXCEEDED', 'MODEL_FAILED', 'CANCELLED']);

class UtilityError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new UtilityError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function errorCode(error) {
  return error instanceof UtilityError && CODES.has(error.code) ? error.code : 'MODEL_FAILED';
}

function requestRoute(frame) {
  if (!object(frame) || !['capacity', 'generate', 'probe'].includes(frame.operation)) fail('INVALID_REQUEST');
  const p = frame.profile;
  if (!object(p) || !nonempty(p.providerFamily) || !nonempty(p.defaultModel) ||
      !nonempty(frame.modelId) || !nonempty(p.baseUrl)) fail('INVALID_REQUEST');
  if (p.enabled !== true || p.supportsText !== true) fail('PROFILE_UNAVAILABLE');
  const api = new Map([['openai_compatible', 'openai-completions'],
    ['anthropic_compatible', 'anthropic-messages']]).get(p.providerFamily);
  if (!api) fail('TOOL_CALL_UNSUPPORTED');
  let url;
  try { url = new URL(p.baseUrl); } catch { fail('INVALID_REQUEST'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('INVALID_REQUEST');
  if (frame.operation !== 'capacity' && (!nonempty(frame.apiKey) || /[\r\n\0]/.test(frame.apiKey)))
    fail('PROFILE_UNAVAILABLE');
  return { api, baseURL: url.href.replace(/\/+$/, ''), model: frame.modelId.trim() };
}

function budget(capacity) {
  if (!object(capacity) || !positive(capacity.contextWindow) || !positive(capacity.maxTokens) ||
      !['dsh-catalog', 'conservative'].includes(capacity.source)) fail('INVALID_REQUEST');
  const outputTokens = Math.min(OUTPUT_TOKENS, capacity.maxTokens);
  // One UTF-8 byte per input token is a deliberately conservative upper bound,
  // including non-Latin text. Reserve room for protocol/tool/schema framing.
  const inputBytes = Math.min(INPUT_BYTES, capacity.contextWindow - outputTokens - CONTEXT_RESERVE);
  if (inputBytes <= 0) fail('BUDGET_EXCEEDED');
  return { inputBytes, outputTokens, contextWindow: capacity.contextWindow,
    maxTokens: capacity.maxTokens, source: capacity.source };
}

async function runtime(route, apiKey, capacity) {
  const ctx = new Context();
  // The official plugin builds PiAiAdapter through its validated profile
  // resolver, which is not an exported function in the pinned DSH build.
  new LlmRuntime(ctx);
  ctx.provide('launchEnvironment', { get: () => undefined, getFrom: () => undefined });
  ctx.provide('credentials', {
    resolve: async ref => ref === KEY_REF && apiKey ? { value: apiKey, source: 'one-shot' } : undefined,
    readRecord: async () => undefined,
    listRecords: async () => [],
  });
  try {
    await ctx.plugin(piAiPlugin, { providers: { [ROUTE]: {
      api: route.api, baseURL: route.baseURL, apiKeyEnv: KEY_REF,
      // A custom route never inherits catalog provider auth or user discovery.
      models: [{ id: route.model, input: ['text'], contextWindow: capacity.contextWindow,
        maxTokens: capacity.maxTokens }],
      streamIdleTimeoutMs: 60000, timeoutMs: 60000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } } });
    await ctx.llm.resolveModelInfo(ROUTE, route.model);
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

async function capacities(llm, route, signal) {
  // Only an official endpoint can inherit the bundled provider's catalog.
  // Arbitrary gateways may remap familiar model IDs to smaller capacities.
  const catalog = new Map(route.api === 'openai-completions' ? [
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.deepseek.com/v1', 'deepseek'],
  ] : [
    ['https://api.anthropic.com', 'anthropic'],
    ['https://api.anthropic.com/v1', 'anthropic'],
  ]).get(route.baseURL);
  if (catalog) {
    const models = await llm.discoverModels(SETTINGS_NS, { provider: catalog }, signal);
    const model = models.find(value => value.id === route.model);
    if (model && positive(model.contextWindow) && positive(model.maxTokens))
      return budget({ contextWindow: model.contextWindow, maxTokens: model.maxTokens, source: 'dsh-catalog' });
  }
  return budget(FALLBACK);
}

function checkUsage(usage, limits) {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
    if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) fail('MODEL_FAILED');
  }
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (usage.outputTokens > limits.outputTokens || input + usage.outputTokens > limits.contextWindow ||
      (usage.totalTokens ?? 0) > limits.contextWindow) fail('BUDGET_EXCEEDED');
}

async function collect(llm, options, limits, controller, allowTools = false) {
  const blocks = [];
  let text = '', streamed = 0, reason;
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    for await (const chunk of llm.stream({ ...options, signal: controller.signal, maxTokens: limits.outputTokens })) {
      controller.signal.throwIfAborted();
      if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
          chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
        if (!allowTools) fail('TOOL_CALL_UNSUPPORTED');
      }
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        if ([...text].length > OUTPUT_CHARS) fail('BUDGET_EXCEEDED');
      }
      // Bound reasoning and tool arguments even when a broken provider never
      // sends usage or a terminal event. The text limit is enforced separately.
      if (chunk.type.endsWith('-delta')) {
        streamed += Buffer.byteLength(chunk.text ?? chunk.argumentsDelta ?? '');
        if (streamed > INPUT_BYTES) fail('BUDGET_EXCEEDED');
      }
      if (chunk.type === 'block-end') blocks.push(chunk.block);
      if (chunk.type === 'usage') { usage = chunk.usage; checkUsage(usage, limits); }
      if (chunk.type === 'finish') reason = chunk.reason.kind;
    }
    controller.signal.throwIfAborted();
    if (reason === 'max-tokens') fail('BUDGET_EXCEEDED');
    if (reason === 'aborted') fail('CANCELLED');
    if (!['stop', 'tool-calls'].includes(reason)) fail('MODEL_FAILED');
    text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
    if ([...text].length > OUTPUT_CHARS) fail('BUDGET_EXCEEDED');
    return { text, usage, blocks, reason };
  } catch (error) {
    controller.abort(error);
    throw error;
  }
}

async function execute(frame, route, controller) {
  controller.signal.throwIfAborted();
  const selected = frame.operation === 'generate' ? budget(frame.capacity) : budget(FALLBACK);
  if (frame.operation === 'generate' && (!nonempty(frame.prompt))) fail('INVALID_REQUEST');
  if (frame.operation === 'generate' && Buffer.byteLength(frame.prompt) > selected.inputBytes) fail('BUDGET_EXCEEDED');
  const ctx = await runtime(route, frame.apiKey, selected);
  try {
    controller.signal.throwIfAborted();
    if (frame.operation === 'capacity') return await capacities(ctx.llm, route, controller.signal);
    const options = { provider: ROUTE, model: route.model };
    if (frame.operation === 'generate') {
      const result = await collect(ctx.llm, { ...options,
        messages: [{ role: 'user', content: [{ type: 'text', text: frame.prompt }] }],
      }, selected, controller);
      if (result.reason === 'tool-calls') fail('TOOL_CALL_UNSUPPORTED');
      if (!result.text.trim()) fail('MODEL_FAILED');
      return { text: result.text, usage: result.usage };
    }
    const nonce = randomBytes(16).toString('hex');
    const answer = randomBytes(16).toString('hex');
    const toolName = 'verify_model_utility';
    const messages = [{ role: 'user', content: [{ type: 'text', text:
      `Call ${toolName} with nonce ${nonce}. Then reply with exactly the answer field from its result, without formatting.` }] }];
    const first = await collect(ctx.llm, { ...options, messages, tools: [{ name: toolName,
      description: 'Verify tool calling. Return a value to echo as the final answer.',
      parameters: { type: 'object', properties: { nonce: { type: 'string', const: nonce } },
        required: ['nonce'], additionalProperties: false },
    }] }, selected, controller, true);
    const calls = first.blocks.filter(block => block.type === 'tool-call');
    if (first.reason !== 'tool-calls' || calls.length !== 1 || calls[0].name !== toolName || !nonempty(calls[0].id))
      fail('TOOL_CALL_UNSUPPORTED');
    let args;
    try { args = JSON.parse(calls[0].arguments); } catch { fail('TOOL_CALL_UNSUPPORTED'); }
    if (!object(args) || Object.keys(args).length !== 1 || args.nonce !== nonce) fail('TOOL_CALL_UNSUPPORTED');
    messages.push(createAssistantMessage({ content: first.blocks, source: { provider: ROUTE, model: route.model } }),
      createToolResultMessage({ callId: calls[0].id, isError: false,
        content: [{ type: 'text', text: JSON.stringify({ answer }) }] }));
    const second = await collect(ctx.llm, { ...options, messages }, selected, controller);
    if (second.reason !== 'stop' || second.text.trim() !== answer) fail('TOOL_CALL_UNSUPPORTED');
    return { toolCallingVerified: true };
  } finally {
    await ctx.fiber.dispose();
  }
}

/** Public JS seam; the native caller uses model-utility-entry.mjs over pipes. */
export async function runModelUtility(frame, { signal } = {}) {
  const controller = new AbortController();
  let timeout, aborted;
  const forward = () => controller.abort(new UtilityError('CANCELLED'));
  try {
    const route = requestRoute(frame);
    const timeoutMs = frame.timeoutMs ?? 60000;
    if (!positive(timeoutMs) || timeoutMs > 120000) fail('INVALID_REQUEST');
    timeout = setTimeout(() => controller.abort(new UtilityError('BUDGET_EXCEEDED')), timeoutMs);
    if (signal?.aborted) forward();
    else signal?.addEventListener('abort', forward, { once: true });
    const cancelled = new Promise((_, reject) => {
      aborted = () => reject(controller.signal.reason);
      if (controller.signal.aborted) aborted();
      else controller.signal.addEventListener('abort', aborted, { once: true });
    });
    return { ok: true, data: await Promise.race([execute(frame, route, controller), cancelled]) };
  } catch (error) {
    return { ok: false, error: { code: errorCode(error) } };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forward);
    if (aborted) controller.signal.removeEventListener('abort', aborted);
  }
}
