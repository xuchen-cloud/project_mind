import { format } from 'node:util';
// SDK diagnostics cannot become protocol responses.
console.log = (...values) => process.stderr.write(format(...values) + '\n');
console.warn = console.log;
console.info = console.log;
const LIMIT = 180 * 1024 * 1024;
const invalid = { requestId: '', ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Expected one bounded Office frame' } };
function write(response) {
  const frame = JSON.stringify(response);
  process.stdout.write((Buffer.byteLength(frame) <= LIMIT ? frame : JSON.stringify({ requestId: response.requestId, ok: false, error: { code: 'BUDGET_EXCEEDED', message: 'Office result exceeds frame capacity' } })) + '\n');
}
async function serveBaseline() {
  // Native keeps stdin open for the whole private lease. Observe EOF directly:
  // a parent SIGKILL must interrupt an in-flight sidecar await, independently
  // of the async iterator advancing to its next frame. Native owns this exact
  // process group; Windows uses its kill-on-close Job Object instead.
  const ownerClosed = () => {
    if (process.platform !== 'win32') {
      try { process.kill(-process.pid, 'SIGKILL'); }
      catch { process.exit(1); }
    } else process.exit(1);
  };
  process.stdin.once('end', ownerClosed);
  process.stdin.once('error', ownerClosed);
  const { createOfficeRecalculationSession } = await import('../office-dist/worker.mjs');
  const session = createOfficeRecalculationSession();
  let parts = [], length = 0;
  try {
    for await (const part of process.stdin) {
      let start = 0;
      while (start < part.length) {
        const end = part.indexOf(10, start);
        const segment = part.subarray(start, end < 0 ? part.length : end);
        length += segment.length;
        if (length > LIMIT) { write(invalid); process.exitCode = 2; return; }
        parts.push(segment);
        if (end < 0) break;
        const line = Buffer.concat(parts, length);
        parts = []; length = 0;
        let request;
        try { request = JSON.parse(line.toString('utf8')); }
        catch { write(invalid); process.exitCode = 2; return; }
        write(await session.handle(request));
        start = end + 1;
      }
    }
    if (length) write(invalid);
  } finally { await session.close(); }
}
try {
  if (process.argv[2] === '--recalc-baseline') await serveBaseline();
  else {
    const parts = []; let length = 0;
    for await (const part of process.stdin) {
      length += part.length;
      if (length > LIMIT) { write(invalid); process.exitCode = 2; break; }
      parts.push(part);
    }
    if (!process.exitCode) {
      const frame = Buffer.concat(parts, length);
      const end = frame.indexOf(10);
      if (end < 0 || end !== frame.length - 1) write(invalid);
      else {
        let request;
        try { request = JSON.parse(frame.subarray(0, end).toString('utf8')); }
        catch { write(invalid); }
        if (request !== undefined) {
          const { handleOfficeRequest } = await import('../office-dist/worker.mjs');
          write(await handleOfficeRequest(request));
        }
      }
    }
  }
} catch { write(invalid); }
