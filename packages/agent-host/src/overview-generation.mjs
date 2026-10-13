import { randomBytes } from 'node:crypto';
import { createPiSession } from './pi-spike.mjs';
import { aggregateUsage } from './message-projection.mjs';
import { mapCompatibleProfile } from './profile-map.mjs';
import { OVERVIEW_SYSTEM_PROMPT, overviewInputBudget } from './model-capacity.mjs';
import { MAX_OVERVIEW_INPUT_BYTES } from './protocol.mjs';

const idPattern = /^[0-9a-f]{32}$/;
const systemPrompt = OVERVIEW_SYSTEM_PROMPT;
const error = (code) => Object.assign(new Error(code), { code });
const characterCount = (value) => [...value].length;

/** A single short-lived, in-memory model call. Native Rust owns publication. */
export function createOverviewGeneration({ workspaceRoot, makeSession = createPiSession }) {
  let active;
  function start(data) {
    if (active) throw error('RUN_BUSY');
    if (!idPattern.test(data.batchId ?? '') || typeof data.prompt !== 'string'
      || !data.prompt.trim() || Buffer.byteLength(data.prompt, 'utf8') > MAX_OVERVIEW_INPUT_BYTES) throw error('INVALID_ARGUMENT');
    if (typeof data.apiKey !== 'string' || !data.apiKey) throw error('SECRETS_LOCKED');
    const mapped = mapCompatibleProfile(data.profile, { model: data.modelId });
    const budget = overviewInputBudget(data.capacity);
    if (Buffer.byteLength(data.prompt, 'utf8') > budget.inputBytes) throw error('BUDGET_EXCEEDED');
    const job = { batchId: data.batchId, cancelled: false, session: null, settled: false,
      assistant: null, outputCharacters: 0, failureCode: null, finished: null };
    active = job;
    let credential = data.apiKey;
    delete data.apiKey;
    job.finished = (async () => {
      try {
        const onEvent = (value) => {
          if (value.type === 'agent_settled') job.settled = true;
          if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta') {
            job.outputCharacters += characterCount(value.assistantMessageEvent.delta ?? '');
            if (job.outputCharacters > 24000) {
              job.failureCode = 'BUDGET_EXCEEDED';
              void job.session?.cancel().catch(() => {});
            }
          }
          if (value.type === 'message_end' && value.message?.role === 'assistant') job.assistant = value.message;
        };
        job.session = await makeSession({ workspaceRoot, sessionId: randomBytes(16).toString('hex'),
          ...mapped, contextWindow: data.capacity.contextWindow, maxTokens: budget.outputTokens,
          apiKey: credential, tools: [], systemPrompt, compactionEnabled: false,
          dispatchTool: () => Promise.reject(error('SCOPE_DENIED')), onEvent });
        credential = undefined;
        if (job.session.activeTools().length) throw error('RUNTIME_INCOMPATIBLE');
        if (job.cancelled) throw error('RUN_CANCELLED');
        await job.session.prompt(data.prompt);
        if (job.cancelled) throw error('RUN_CANCELLED');
        if (job.failureCode) throw error(job.failureCode);
        if (!job.settled || job.assistant?.stopReason !== 'stop') throw error('MODEL_FAILED');
        if (!Array.isArray(job.assistant.content) || !job.assistant.content.length
          || job.assistant.content.some((part) => part.type !== 'text' || typeof part.text !== 'string')) throw error('MODEL_FAILED');
        const text = job.assistant.content.map((part) => part.text).join('');
        if (!text.trim()) throw error('MODEL_FAILED');
        if (characterCount(text) > 24000) throw error('BUDGET_EXCEEDED');
        return { text, usage: aggregateUsage([{ role: 'assistant', usage: job.assistant.usage }]) };
      } catch (cause) {
        if (job.cancelled) throw error('RUN_CANCELLED');
        if (job.failureCode) throw error(job.failureCode);
        throw error(['INVALID_ARGUMENT', 'PROFILE_UNAVAILABLE', 'TOOL_CALL_UNSUPPORTED', 'RUNTIME_INCOMPATIBLE', 'BUDGET_EXCEEDED', 'MODEL_FAILED'].includes(cause?.code)
          ? cause.code : 'RUNTIME_FAILED');
      } finally {
        credential = undefined;
        try { await job.session?.dispose(); }
        finally { job.session = null; job.assistant = null; if (active === job) active = undefined; }
      }
    })();
    return job.finished;
  }
  function cancel(batchId) {
    if (!active || active.batchId !== batchId) throw error('INVALID_ARGUMENT');
    active.cancelled = true;
    void active.session?.cancel().catch(() => {});
    return { cancelling: true, batchId };
  }
  async function shutdown() {
    if (!active) return;
    const job = active;
    cancel(job.batchId);
    try { await job.finished; } catch { /* The original generate request gets its terminal failure. */ }
  }
  return { start, cancel, shutdown, busy: () => !!active, idle: () => active?.finished ?? Promise.resolve() };
}
