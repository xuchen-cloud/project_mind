/** Internal Rust ↔ Node protocol. This is not the MCP wire protocol. */
export const PROTOCOL_VERSION = "mind-agent-host/v1";
export const MAX_FRAME_BYTES = 1024 * 1024;
const methods = new Set([
  "initialize", "session.open", "run.start", "run.cancel", "session.close", "shutdown", "tool.result",
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
  return value;
}

/** AI-01 replaces unavailable branches with a restricted Pi adapter after its spike. */
export function createProtocolSession() {
  let initialized = false;
  return function handle(frame) {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      return { response: failure(frame.requestId, "RUNTIME_INCOMPATIBLE", "Unsupported Host protocol") };
    }
    const success = (data) => ({ protocolVersion: PROTOCOL_VERSION, requestId: frame.requestId, ok: true, data });
    if (frame.method === "shutdown") return { response: success({ stopped: true }), shutdown: true };
    if (frame.method === "initialize") {
      if (initialized) return { response: failure(frame.requestId, "RUNTIME_INCOMPATIBLE", "Host already initialized") };
      initialized = true;
      return { response: success({ runtimeId: "builtin-pi", runtimeAvailable: false,
        capabilities: { structuredEvents: false, toolBridge: false, resume: false, cancel: false, fileOutput: false, scopeEnforced: false },
        reason: "Pi integration and bundled Node validation are pending AI-01" }) };
    }
    if (!initialized) return { response: failure(frame.requestId, "RUNTIME_INCOMPATIBLE", "Initialize Host first") };
    return { response: failure(frame.requestId, "RUNTIME_UNAVAILABLE", "Pi runtime is not installed in this scaffold") };
  };
}
