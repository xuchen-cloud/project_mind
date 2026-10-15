import { handleRecordDocumentRequest } from '../dist/record-document-worker.mjs';

// No tools, model, resource discovery, file paths or database handles are passed
// to this utility worker. Only bounded document data crosses the pipe.
const LIMIT = 4 * 1024 * 1024;
const write = (value) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, 'utf8') > 12 * 1024 * 1024) {
    process.stdout.write(`${JSON.stringify({ requestId: value.requestId, ok: false, error: { code: 'INVALID_PATCH', message: 'Document projection exceeds frame limit' } })}\n`);
  } else process.stdout.write(`${line}\n`);
};
let pending = Buffer.alloc(0);
try {
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (bytes.length > LIMIT) throw new Error('Frame limit');
      let request;
      try { request = JSON.parse(bytes.toString('utf8')); }
      catch { write({ requestId: '', ok: false, error: { code: 'INVALID_PATCH', message: 'Malformed document frame' } }); continue; }
      write(await handleRecordDocumentRequest(request));
    }
    if (pending.length > LIMIT) throw new Error('Frame limit');
  }
  if (pending.length) throw new Error('Incomplete frame');
} catch {
  write({ requestId: '', ok: false, error: { code: 'INVALID_PATCH', message: 'Incomplete or oversized document frame' } });
  process.exitCode = 2;
}
