// Shared production/probe lifecycle. Rust remains the scoped business authority.
import { randomBytes } from 'node:crypto';
import { createPiSession } from './pi-spike.mjs';
import { projectCheckpoint, aggregateUsage } from './message-projection.mjs';
import { DEFAULT_SYSTEM_PROMPT, PROBE_TOOLS, validateToolDescriptors } from './tool-descriptors.mjs';
import { mapCompatibleProfile } from './profile-map.mjs';
import { failure, PROTOCOL_VERSION, MAX_FRAME_BYTES } from './protocol.mjs';
import { createOverviewGeneration } from './overview-generation.mjs';
import { readSessionHistory } from './session-history.mjs';
import { scanSessionHistory } from './session-history-scan.mjs';

const idPattern = /^[0-9a-f]{32}$/;
export function createHostProtocol({ write, workspaceRoot, persistCheckpoint, loadCheckpoint, makeSession = createPiSession, probe = false }) {
  let initialized = false;
  let sessionId;
  let tools = [];
  let systemPrompt;
  let committed;
  let messages = [];
  let session;
  let run;
  const overview = createOverviewGeneration({ workspaceRoot, makeSession });
  const pendingTools = new Map();
  const success = (requestId, data) => ({ protocolVersion: PROTOCOL_VERSION, requestId, ok: true, data });
  const event = (active, type, data = {}) => write({ protocolVersion: PROTOCOL_VERSION,
    sessionId, runId: active.id, seq: ++active.seq, type, data });
  function dispatchTool({ method, toolCallId, payload, signal }) {
    const active = run;
    if (!active || active.cancelled || signal?.aborted) return Promise.reject(new Error('Tool request cancelled'));
    if (!tools.some((tool) => tool.method === method)) return Promise.reject(new Error('Tool method is not active'));
    if (++active.toolCount > 30) {
      active.failureCode = 'BUDGET_EXCEEDED';
      void session.cancel().catch(() => {});
      return Promise.reject(new Error('Tool call limit reached'));
    }
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const complete = (value, error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pendingTools.delete(requestId);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        active.failureCode = 'BUDGET_EXCEEDED';
        complete(undefined, new Error('Tool request timed out'));
        void session.cancel().catch(() => {});
      }, 30000);
      const abort = () => complete(undefined, new Error('Tool request cancelled'));
      pendingTools.set(requestId, { active, complete });
      signal?.addEventListener('abort', abort, { once: true });
      write({ protocolVersion: PROTOCOL_VERSION, requestId, method: 'tool.call',
        sessionId, runId: active.id, data: { method, toolCallId, payload } });
    });
  }
  function sdkEvent(value) {
    const active = run;
    if (!active) return;
    if (value.type === 'agent_settled') active.settled = true;
    if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta') {
      event(active, 'text.delta', { text: value.assistantMessageEvent.delta });
    } else if (value.type === 'tool_execution_start') {
      event(active, 'tool.started', { toolCallId: value.toolCallId, tool: value.toolName });
    } else if (value.type === 'tool_execution_end') {
      event(active, 'tool.completed', { toolCallId: value.toolCallId, isError: value.isError });
    } else if (value.type === 'message_end' && value.message.role === 'assistant') {
      active.stopReason = value.message.stopReason;
      // Error messages can include credentials or server details; the checkpoint
      // retains SDK history but the transport uses a generic error description.
      // Stable IDs become available only after the SDK appends message_end.
      if (probe && !session?.checkpoint) event(active, 'message.completed', { role: 'assistant', content: value.message.content, stopReason: value.message.stopReason });
    }
  }
  async function finish(active, prompt) {
    let checkpoint;
    let runtimeFailed = false;
    try {
      try { checkpoint = await session.prompt(prompt); }
      catch { runtimeFailed = true; checkpoint = session.checkpoint?.(); }
      if (!checkpoint) throw new Error('SDK checkpoint unavailable');
      const projection = probe && !session.checkpoint ? [] : projectCheckpoint(checkpoint, workspaceRoot, sessionId);
      const previous = new Set(messages.map((message) => message.runtimeEntryId));
      const added = projection.filter((message) => !previous.has(message.runtimeEntryId));
      active.usage = aggregateUsage(added);
      for (const message of added) event(active, 'message.completed', message);
      const persisted = await persistCheckpoint(sessionId, checkpoint);
      committed = persisted;
      messages = projection;
      const data = { checkpoint: persisted, messageCount: messages.length, usage: active.usage };
      if (active.failureCode) event(active, 'run.failed', { ...data, code: active.failureCode });
      else if (!active.settled || runtimeFailed) event(active, 'run.failed', { ...data, code: 'RUNTIME_FAILED' });
      else if (active.cancelled || active.stopReason === 'aborted') event(active, 'run.cancelled', data);
      else if (active.stopReason === 'stop') event(active, 'run.completed', data);
      else event(active, 'run.failed', { ...data, code: 'MODEL_FAILED' });
    } catch {
      event(active, 'run.failed', { code: 'RUNTIME_FAILED', usage: active.usage ?? aggregateUsage([]) });
    } finally {
      for (const tool of pendingTools.values()) if (tool.active === active) tool.complete(undefined, new Error('Run ended'));
      if (run === active) run = undefined;
    }
  }
  return {
    async handle(frame) {
      const { requestId, method, data = {} } = frame;
      const fail = (code, message) => write(failure(requestId, code, message));
      if (frame.protocolVersion !== PROTOCOL_VERSION) { fail('RUNTIME_INCOMPATIBLE', 'Unsupported Host protocol'); return; }
      if (method === 'initialize') {
        if (initialized) { fail('RUNTIME_INCOMPATIBLE', 'Host already initialized'); return; }
        try {
          if (!probe && data.workspaceRoot !== workspaceRoot) throw new Error('Workspace binding mismatch');
          tools = validateToolDescriptors(data.tools ?? (probe ? PROBE_TOOLS : []), { probe });
          systemPrompt = data.systemPrompt ?? (probe ? DEFAULT_SYSTEM_PROMPT : undefined);
          if (typeof systemPrompt !== 'string' || !systemPrompt.trim() || Buffer.byteLength(systemPrompt) > 65536) throw new Error('Invalid system prompt');
        } catch { fail('INVALID_ARGUMENT', 'Initialize requires bounded scoped tools and a system prompt'); return; }
        initialized = true;
        write(success(requestId, { runtimeId: 'builtin-pi', runtimeAvailable: !probe, probeAvailable: probe, acceptancePending: true,
          activeTools: tools.map((tool) => tool.name),
          capabilities: { structuredEvents: true, toolBridge: true, resume: true, cancel: true, fileOutput: false, scopeEnforced: true } }));
        return;
      }
      if (!initialized) { fail('RUNTIME_INCOMPATIBLE', 'Initialize Host first'); return; }
      if (method === 'session.history.read') {
        try {
          if (!loadCheckpoint) throw Object.assign(new Error('Checkpoint loader unavailable'), { code: 'RUNTIME_INCOMPATIBLE' });
          write(success(requestId, await readSessionHistory(data, { loadCheckpoint, workspaceRoot })));
        } catch (error) { fail(error.code ?? 'RUNTIME_FAILED', 'Cannot read session history'); }
        return;
      }
      if (method === 'session.history.scan') {
        try {
          if (!loadCheckpoint) throw Object.assign(new Error('Checkpoint loader unavailable'), { code: 'RUNTIME_INCOMPATIBLE' });
          write(success(requestId, await scanSessionHistory(data, { loadCheckpoint, workspaceRoot })));
        } catch (error) { fail(error.code ?? 'RUNTIME_FAILED', 'Cannot scan session history'); }
        return;
      }
      if (method === 'overview.generate') {
        if (probe || session || run || overview.busy()) { fail('RUN_BUSY', 'Host model call is busy'); return; }
        try {
          const finished = overview.start(data);
          void finished.then((result) => write(success(requestId, result)), (error) => fail(error.code ?? 'RUNTIME_FAILED', 'Overview generation did not complete'));
        } catch (error) { fail(error.code ?? 'RUNTIME_FAILED', 'Cannot start overview generation'); }
        return;
      }
      if (method === 'overview.cancel') {
        try { write(success(requestId, overview.cancel(data.batchId))); }
        catch { fail('INVALID_ARGUMENT', 'No matching overview generation'); }
        return;
      }
      if (method === 'session.open') {
        if (overview.busy()) { fail('RUN_BUSY', 'Host model call is busy'); return; }
        if (session || !idPattern.test(data.sessionId ?? '')) { fail('INVALID_ARGUMENT', 'Session already open or invalid session ID'); return; }
        try {
          const mapped = mapCompatibleProfile(data.profile, { model: data.modelId, toolCallingVerified: data.toolCallingVerified });
          if (typeof data.apiKey !== 'string' || !data.apiKey) { fail('SECRETS_LOCKED', 'Unlocked credential is required'); return; }
          const restored = data.resume === true;
          if (!probe && data.checkpoint !== undefined) throw Object.assign(new Error('Use resume for stored history'), { code: 'INVALID_ARGUMENT' });
          const checkpoint = restored ? await loadCheckpoint(data.sessionId) : (probe ? data.checkpoint : undefined);
          // Never let a caller replace stored history by opening the same ID as new.
          if (!restored && loadCheckpoint?.exists && await loadCheckpoint.exists(data.sessionId)) throw Object.assign(new Error('Resume required'), { code: 'RUNTIME_INCOMPATIBLE' });
          sessionId = data.sessionId;
          session = await makeSession({ workspaceRoot, sessionId, ...mapped, apiKey: data.apiKey,
            checkpoint, tools, systemPrompt, dispatchTool, onEvent: sdkEvent });
          messages = checkpoint ? projectCheckpoint(checkpoint, workspaceRoot, sessionId) : [];
          committed = checkpoint ? { ...checkpoint, jsonl: undefined } : undefined;
          write(success(requestId, { sessionId, tools: session.activeTools(), activeTools: session.activeTools(),
            restored, checkpoint: committed ?? null, messageCount: messages.length }));
        } catch (error) { await session?.dispose(); session = undefined; sessionId = undefined; fail(error.code ?? 'RUNTIME_FAILED', 'Cannot open restricted Pi session'); }
        return;
      }
      if (method === 'session.messages.read') {
        const offset = data.offset ?? 0;
        const limit = data.limit ?? 50;
        if (!session || data.sessionId !== sessionId || !committed || data.checksum !== committed.checksum) { fail('RUNTIME_INCOMPATIBLE', 'Projection requires the committed checkpoint binding'); return; }
        if (!Number.isInteger(offset) || offset < 0 || offset > messages.length || !Number.isInteger(limit) || limit < 1 || limit > 100) { fail('INVALID_ARGUMENT', 'Invalid projection page'); return; }
        const page = [];
        for (const message of messages.slice(offset, offset + limit)) {
          if (Buffer.byteLength(JSON.stringify([...page, message])) > MAX_FRAME_BYTES - 2048) break;
          page.push(message);
        }
        if (!page.length && offset < messages.length) { fail('RUNTIME_INCOMPATIBLE', 'Message projection exceeds frame limit; history preserved'); return; }
        write(success(requestId, { sessionId, checksum: committed.checksum, offset, messages: page,
          nextOffset: offset + page.length < messages.length ? offset + page.length : null, total: messages.length }));
        return;
      }
      if (method === 'run.start') {
        if (run || overview.busy()) { fail('RUN_BUSY', 'A run is already active'); return; }
        if (!session || data.sessionId !== sessionId || !idPattern.test(data.runId ?? '')
          || typeof data.prompt !== 'string' || !data.prompt.trim()) { fail('INVALID_ARGUMENT', 'Invalid run binding or prompt'); return; }
        const active = { id: data.runId, seq: 0, settled: false, cancelled: false, toolCount: 0 };
        run = active;
        write(success(requestId, { accepted: true, runId: active.id }));
        event(active, 'run.started');
        active.finished = finish(active, data.prompt);
        return;
      }
      if (method === 'tool.result') {
        const tool = pendingTools.get(requestId);
        if (!tool || data.runId !== tool.active.id || data.sessionId !== sessionId) {
          fail('SCOPE_DENIED', 'Tool response does not match an active request'); return;
        }
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_FRAME_BYTES) { fail('INVALID_ARGUMENT', 'Tool response exceeds size limit'); return; }
        tool.complete(data.result, data.error ? new Error('Host rejected scoped tool request') : undefined);
        return;
      }
      if (method === 'run.cancel') {
        if (!run || data.runId !== run.id || data.sessionId !== sessionId) { fail('INVALID_ARGUMENT', 'No matching active run'); return; }
        run.cancelled = true;
        for (const tool of pendingTools.values()) tool.complete(undefined, new Error('Tool request cancelled'));
        write(success(requestId, { cancelling: true }));
        void session.cancel().catch(() => {});
        return;
      }
      if (method === 'session.close' || method === 'shutdown') {
        if (method === 'session.close' && data.sessionId !== sessionId) { fail('SCOPE_DENIED', 'Session close binding does not match'); return; }
        if (run) {
          run.cancelled = true;
          const active = run;
          for (const tool of pendingTools.values()) tool.complete(undefined, new Error('Tool request cancelled'));
          await session.cancel();
          await active.finished;
        }
        if (method === 'shutdown') await overview.shutdown();
        await session?.dispose();
        session = undefined;
        sessionId = undefined;
        committed = undefined;
        messages = [];
        write(success(requestId, { stopped: method === 'shutdown' }));
        return;
      }
      fail('INVALID_ARGUMENT', 'Unknown Host method');
    },
    idle: () => run?.finished ?? overview.idle(),
  };
}
