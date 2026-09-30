import { createProtocolSession, failure, MAX_FRAME_BYTES, parseFrame } from "./protocol.mjs";

const handle = createProtocolSession();
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let pending = Buffer.alloc(0);
let stopped = false;
for await (const chunk of process.stdin) {
  pending = Buffer.concat([pending, chunk]);
  let newline;
  while ((newline = pending.indexOf(10)) >= 0) {
    const bytes = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    if (bytes.length > MAX_FRAME_BYTES) {
      write(failure("", "INVALID_ARGUMENT", "Frame exceeds size limit"));
      process.exitCode = 2;
      stopped = true;
      break;
    }
    let frame;
    try { frame = parseFrame(bytes.toString("utf8")); }
    catch {
      // Never reflect malformed input, credentials or model text into diagnostics.
      write(failure("", "INVALID_ARGUMENT", "Malformed Host frame"));
      continue;
    }
    const result = handle(frame);
    write(result.response);
    if (result.shutdown) { stopped = true; break; }
  }
  if (!stopped && pending.length > MAX_FRAME_BYTES) {
    write(failure("", "INVALID_ARGUMENT", "Frame exceeds size limit"));
    process.exitCode = 2;
    stopped = true;
  }
  if (stopped) break;
}
if (!stopped && pending.length) {
  write(failure("", "INVALID_ARGUMENT", "Incomplete Host frame"));
  process.exitCode = 2;
}
