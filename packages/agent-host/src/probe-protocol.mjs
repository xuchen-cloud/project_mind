// Reproducible AI-01 transport probe; never selected by the production entrypoint.
import { randomBytes } from 'node:crypto';
import { createPiProbe } from './pi-spike.mjs';
import { mapCompatibleProfile } from './profile-map.mjs';
import { failure, PROTOCOL_VERSION, MAX_FRAME_BYTES } from './protocol.mjs';

const idPattern = /^[0-9a-f]{32}$/;
export function createProbeProtocol({ write, workspaceRoot, persistCheckpoint, makeSession = createPiProbe }) {
  let initialized = false;
  let sessionId;
  let session;
  let run;
  const pendingTools = new Map();
  const success = (requestId, data) => ({ protocolVersion: PROTOCOL_VERSION, requestId, ok: true, data });
  const event = (active, type, data = {}) => write({ protocolVersion: PROTOCOL_VERSION,
    sessionId, runId: active.id, seq: ++active.seq, type, data });
  function dispatchTool({ method, toolCallId, payload, signal }) {
    const active = run;
    if (!active || active.cancelled || signal?.aborted) return Promise.reject(new Error('Tool request cancelled'));
    if (++active.toolCount > 30) return Promise.reject(new Error('Tool call limit reached'));
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const complete = (value, error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pendingTools.delete(requestId);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => complete(undefined, new Error('Tool request timed out')), 30000);
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
      event(active, 'message.completed', { role: 'assistant', content: value.message.content,
        stopReason: value.message.stopReason });
    }
  }
  async function finish(active, prompt) {
    try {
      const checkpoint = await session.prompt(prompt);
      if (!active.settled) throw new Error('SDK did not settle');
      const persisted = await persistCheckpoint(sessionId, checkpoint);
      if (active.cancelled || active.stopReason === 'aborted') event(active, 'run.cancelled', { checkpoint: persisted });
      else if (active.stopReason === 'stop') event(active, 'run.completed', { checkpoint: persisted });
      else event(active, 'run.failed', { code: 'MODEL_FAILED', checkpoint: persisted });
    } catch {
      event(active, 'run.failed', { code: 'RUNTIME_FAILED' });
    } finally {
      if (run === active) run = undefined;
    }
  }
  return {
    async handle(frame) {
      const { requestId, method, data = {} } = frame;
      const fail = (code, message) => write(failure(requestId, code, message));
      if (frame.protocolVersion !== PROTOCOL_VERSION) { fail('RUNTIME_INCOMPATIBLE', 'Unsupported Host protocol'); return; }
      if (method === 'initialize') {
        if (initialized) { fail('RUNTIME_INCOMPATIBLE', 'Probe already initialized'); return; }
        initialized = true;
        write(success(requestId, { runtimeAvailable: false, probeAvailable: true, acceptancePending: true }));
        return;
      }
      if (!initialized) { fail('RUNTIME_INCOMPATIBLE', 'Initialize probe first'); return; }
      if (method === 'session.open') {
        if (session || !idPattern.test(data.sessionId ?? '')) { fail('INVALID_ARGUMENT', 'Session already open or invalid session ID'); return; }
        try {
          const mapped = mapCompatibleProfile(data.profile, { model: data.modelId, toolCallingVerified: data.toolCallingVerified });
          if (typeof data.apiKey !== 'string' || !data.apiKey) { fail('SECRETS_LOCKED', 'Unlocked credential is required'); return; }
          sessionId = data.sessionId;
          session = await makeSession({ workspaceRoot, sessionId, ...mapped, apiKey: data.apiKey,
            checkpoint: data.checkpoint, dispatchTool, onEvent: sdkEvent });
          write(success(requestId, { sessionId, tools: session.activeTools() }));
        } catch (error) { fail(error.code ?? 'RUNTIME_FAILED', 'Cannot open Pi probe session'); }
        return;
      }
      if (method === 'run.start') {
        if (run) { fail('RUN_BUSY', 'A run is already active'); return; }
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
        await session.cancel();
        write(success(requestId, { cancelling: true }));
        return;
      }
      if (method === 'session.close' || method === 'shutdown') {
        if (run) {
          run.cancelled = true;
          await session.cancel();
          await run?.finished;
        }
        await session?.dispose();
        session = undefined;
        sessionId = undefined;
        write(success(requestId, { stopped: method === 'shutdown' }));
        return;
      }
      fail('INVALID_ARGUMENT', 'Unknown probe method');
    },
    idle: () => run?.finished ?? Promise.resolve(),
  };
}
