// One bounded snapshot per process; source ownership and hash checks stay in
// the native service. No path, URL, credential or tool reaches this worker.
import { format } from 'node:util';

// Parser diagnostics must never appear as extra protocol frames.
console.log = (...values) => process.stderr.write(format(...values) + '\n');
console.warn = console.log;
console.info = console.log;
const INPUT_LIMIT = 70 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const invalid = { requestId: '', ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Expected one bounded extraction frame' } };
const write = (response) => {
  const json = JSON.stringify(response);
  process.stdout.write((Buffer.byteLength(json) <= OUTPUT_LIMIT ? json : JSON.stringify({ requestId: response.requestId, ok: false, error: { code: 'EXTRACTION_FAILED', message: 'Source result exceeds capacity' } })) + '\n');
};
const deadline = setTimeout(() => { write({ requestId: '', ok: false, error: { code: 'EXTRACTION_FAILED', message: 'Source extraction timed out' } }); process.exit(124); }, 60000);
try {
  const parts = []; let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > INPUT_LIMIT) { write(invalid); process.exitCode = 2; break; }
    parts.push(part);
  }
  if (!process.exitCode) {
    const bytes = Buffer.concat(parts, size);
    const line = bytes.indexOf(10);
    if (line !== bytes.length - 1 || line < 0) write(invalid);
    else {
      let request;
      try { request = JSON.parse(bytes.subarray(0, line).toString('utf8')); }
      catch { write(invalid); }
      if (request !== undefined) {
        const { handleSourceExtractionRequest } = await import('../source-dist/source-extraction-worker.mjs');
        write(await handleSourceExtractionRequest(request));
      }
    }
  }
} catch { write(invalid); }
finally { clearTimeout(deadline); }
