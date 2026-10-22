// Native boundary: one JSON document through EOF, one JSON response, no logs.
// Keep a read deadline even when the parent never closes stdin. The native
// caller also owns a deadline and must kill the child on timeout/cancellation.
import { FRAME_BYTES, runModelUtility } from './model-utility.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const timer = setTimeout(stop, 60000);
let result;
try {
  let bytes = 0;
  const chunks = [];
  const read = async () => {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > FRAME_BYTES) throw new Error('BUDGET_EXCEEDED');
      chunks.push(chunk);
    }
  };
  let abort;
  try {
    await Promise.race([read(), new Promise((_, reject) => {
      abort = () => reject(new Error('BUDGET_EXCEEDED'));
      controller.signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { controller.signal.removeEventListener('abort', abort); }
  clearTimeout(timer);
  let frame;
  try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('INVALID_REQUEST'); }
  result = await runModelUtility(frame, { signal: controller.signal });
} catch (error) {
  result = { ok: false, error: { code: error.message === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'INVALID_REQUEST' } };
} finally {
  clearTimeout(timer);
}
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
