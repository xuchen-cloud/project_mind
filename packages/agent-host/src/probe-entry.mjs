// Explicit AI-01 executable sample. `npm start` uses the unavailable production
// scaffold; this entry cannot enable an application capability.
import path from 'node:path';
import { createProbeProtocol } from './probe-protocol.mjs';
import { createSessionStore } from './session-store.mjs';
import { failure, MAX_FRAME_BYTES, parseFrame } from './protocol.mjs';

const write = (frame) => {
  const line = JSON.stringify(frame);
  process.stdout.write(`${Buffer.byteLength(line, 'utf8') <= MAX_FRAME_BYTES ? line
    : JSON.stringify(failure('', 'INVALID_ARGUMENT', 'Probe event exceeds frame limit'))}\n`);
};
let protocol;
let store;
let pending = Buffer.alloc(0);
let stopped = false;
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (bytes.length > MAX_FRAME_BYTES) throw new Error('Oversized frame');
      let frame;
      try { frame = parseFrame(bytes.toString('utf8')); }
      catch { write(failure('', 'INVALID_ARGUMENT', 'Malformed probe frame')); continue; }
      if (!protocol) {
        if (frame.method !== 'initialize' || typeof frame.data?.workspaceRoot !== 'string'
          || !path.isAbsolute(frame.data.workspaceRoot)) {
          write(failure(frame.requestId, 'INVALID_ARGUMENT', 'Initialize with a trusted absolute Workspace root')); continue;
        }
        store = await createSessionStore(frame.data.workspaceRoot);
        protocol = createProbeProtocol({ write, workspaceRoot: frame.data.workspaceRoot,
          persistCheckpoint: (id, checkpoint) => store.save(id, checkpoint) });
      }
      if (frame.method === 'session.open' && frame.data?.resume === true) {
        try { frame.data.checkpoint = await store.load(frame.data.sessionId); }
        catch { write(failure(frame.requestId, 'RUNTIME_INCOMPATIBLE', 'Cannot resume damaged or missing history')); continue; }
      }
      await protocol.handle(frame);
      if (frame.data?.apiKey !== undefined) delete frame.data.apiKey;
      if (frame.method === 'shutdown') { stopped = true; break; }
    }
    if (!stopped && pending.length > MAX_FRAME_BYTES) throw new Error('Oversized frame');
    if (stopped) break;
  }
  if (!stopped && pending.length) throw new Error('Incomplete frame');
} catch {
  write(failure('', 'INVALID_ARGUMENT', 'Cannot process probe frame'));
  process.exitCode = 2;
} finally {
  if (!stopped && protocol) await protocol.handle({ protocolVersion: 'mind-agent-host/v1', requestId: 'eof', method: 'shutdown' });
}
