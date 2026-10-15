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
try {
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
} catch { write(invalid); }
