/** Internal Rust ↔ Node protocol. This is not the MCP wire protocol. */
export const PROTOCOL_VERSION = "mind-agent-host/v1";
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const methods = new Set([
  "initialize", "session.open", "run.start", "run.cancel", "session.close", "shutdown", "tool.result", "session.messages.read",
  "overview.generate", "overview.cancel",
]);

export function failure(requestId, code, message) {
  return { protocolVersion: PROTOCOL_VERSION, requestId, ok: false,
    error: { code, message, retryable: false } };
}

export function parseFrame(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("Frame too large");
  const value = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128
    || typeof value.method !== "string" || !methods.has(value.method)) {
    throw new Error("Invalid request envelope");
  }
  if (value.data !== undefined && (!value.data || typeof value.data !== 'object' || Array.isArray(value.data))) throw new Error('Invalid request data');
  return value;
}
