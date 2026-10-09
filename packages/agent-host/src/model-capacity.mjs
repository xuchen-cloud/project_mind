// The bundled SDK catalog is static here: no model file, refresh, or network lookup.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { MAX_OVERVIEW_INPUT_BYTES } from './protocol.mjs';

const FALLBACK = Object.freeze({ contextWindow: 32768, maxTokens: 4096, source: 'fallback' });
export const OVERVIEW_SYSTEM_PROMPT = 'Return exactly one complete JSON value for the requested overview. Use only the supplied prompt. Do not call tools or add prose outside the JSON.';

export function capacityFromModels(models, modelId, limits = {}) {
  const matches = models.filter((model) => model.id === modelId);
  const consistent = matches.length && matches.every((model) => Number.isInteger(model.contextWindow)
    && model.contextWindow > 0 && Number.isInteger(model.maxTokens) && model.maxTokens > 0
    && model.contextWindow === matches[0].contextWindow && model.maxTokens === matches[0].maxTokens);
  const base = consistent ? { contextWindow: matches[0].contextWindow, maxTokens: matches[0].maxTokens,
    source: 'sdk_catalog' } : FALLBACK;
  return { contextWindow: limits.contextWindow ?? base.contextWindow,
    maxTokens: limits.maxTokens ?? base.maxTokens,
    source: limits.contextWindow !== undefined || limits.maxTokens !== undefined ? 'explicit' : base.source };
}

export function capacityFromRuntime(runtime, modelId, limits = {}) {
  return capacityFromModels(runtime.getModels(), modelId, limits);
}

export async function resolveModelCapacity(modelId, limits = {}) {
  const runtime = await ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [],
    modify: async (_id, operation) => operation(undefined), delete: async () => {} }, modelsPath: null, refreshOnCreate: false,
    allowModelNetwork: false });
  return capacityFromRuntime(runtime, modelId, limits);
}

export function overviewInputBudget(capacity) {
  const outputTokens = Math.min(4096, capacity.maxTokens, Math.floor(capacity.contextWindow / 4));
  const inputBytes = Math.min(MAX_OVERVIEW_INPUT_BYTES, capacity.contextWindow - outputTokens
    - Buffer.byteLength(OVERVIEW_SYSTEM_PROMPT, 'utf8') - 2048);
  if (outputTokens < 1 || inputBytes < 1) throw Object.assign(new Error('Model context is too small'), { code: 'BUDGET_EXCEEDED' });
  return { inputBytes, outputTokens, source: capacity.source };
}
