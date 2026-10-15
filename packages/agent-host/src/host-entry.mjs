// Shared credential-pipe-only transport for production and the acceptance probe.
import path from 'node:path';
import { createHostProtocol } from './host-protocol.mjs';
import { createSessionStore } from './session-store.mjs';
import { failure, MAX_FRAME_BYTES, PROTOCOL_VERSION, parseFrame } from './protocol.mjs';

export async function runHostEntry({ probe = false } = {}) {
  const write = (frame) => {
    const line = JSON.stringify(frame);
    process.stdout.write(`${Buffer.byteLength(line, 'utf8') <= MAX_FRAME_BYTES ? line
      : JSON.stringify(failure('', 'INVALID_ARGUMENT', 'Host event exceeds frame limit'))}\n`);
  };
  let protocol;
  let store;
  let pending = [];
  let pendingBytes = 0;
  let stopped = false;
  try {
    for await (const chunk of process.stdin) {
      let offset = 0;
      let newline;
      while ((newline = chunk.indexOf(10, offset)) >= 0) {
        const frameBytes = pendingBytes + newline - offset;
        if (frameBytes > MAX_FRAME_BYTES) throw new Error('Oversized frame');
        const bytes = pendingBytes
          ? Buffer.concat([...pending, chunk.subarray(offset, newline)], frameBytes)
          : chunk.subarray(offset, newline);
        pending = [];
        pendingBytes = 0;
        offset = newline + 1;
        let frame;
        try { frame = parseFrame(bytes.toString('utf8')); }
        catch { write(failure('', 'INVALID_ARGUMENT', 'Malformed Host frame')); continue; }
        if (!protocol) {
          if (frame.method === 'shutdown') {
            write(frame.protocolVersion === PROTOCOL_VERSION
              ? { protocolVersion: PROTOCOL_VERSION, requestId: frame.requestId, ok: true, data: { stopped: true } }
              : failure(frame.requestId, 'RUNTIME_INCOMPATIBLE', 'Unsupported Host protocol'));
            stopped = true; break;
          }
          if (frame.method !== 'initialize' || typeof frame.data?.workspaceRoot !== 'string'
            || !path.isAbsolute(frame.data.workspaceRoot)) {
            write(failure(frame.requestId, 'INVALID_ARGUMENT', 'Initialize with a trusted absolute Workspace root')); continue;
          }
          store = await createSessionStore(frame.data.workspaceRoot);
          const loadCheckpoint = Object.assign((id) => store.load(id), { exists: (id) => store.exists(id) });
          protocol = createHostProtocol({ write, workspaceRoot: frame.data.workspaceRoot, probe, loadCheckpoint,
            persistCheckpoint: (id, checkpoint) => store.save(id, checkpoint) });
        }
        try { await protocol.handle(frame); }
        finally { if (frame.data?.apiKey !== undefined) delete frame.data.apiKey; }
        if (frame.method === 'shutdown') { stopped = true; break; }
      }
      if (stopped) break;
      const remainder = chunk.subarray(offset);
      if (pendingBytes + remainder.length > MAX_FRAME_BYTES) throw new Error('Oversized frame');
      if (remainder.length) {
        pending.push(remainder);
        pendingBytes += remainder.length;
      }
    }
    if (!stopped && pendingBytes) throw new Error('Incomplete frame');
  } catch {
    write(failure('', 'INVALID_ARGUMENT', 'Cannot process Host frame'));
    process.exitCode = 2;
  } finally {
    if (!stopped && protocol) await protocol.handle({ protocolVersion: 'mind-agent-host/v1', requestId: 'eof', method: 'shutdown' });
  }

}
