import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProtocolSession, parseFrame, PROTOCOL_VERSION } from "../src/protocol.mjs";
const frame = (method, requestId = "r1") => ({ protocolVersion: PROTOCOL_VERSION, requestId, method });

test("handshake is honest about unavailable Pi and never completes a fake run", () => {
  const handle = createProtocolSession();
  assert.equal(handle(frame("run.start")).response.error.code, "RUNTIME_INCOMPATIBLE");
  const initialized = handle(frame("initialize")).response;
  assert.equal(initialized.data.runtimeAvailable, false);
  assert.equal(initialized.data.capabilities.scopeEnforced, false);
  assert.equal(handle(frame("run.start")).response.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(handle(frame("initialize")).response.ok, false);
  assert.equal(handle(frame("shutdown")).shutdown, true);
});

test("rejects unknown methods and protocol mismatches", () => {
  for (const input of ["null", "[]", JSON.stringify({ ...frame("initialize"), method: "shell.exec" })]) {
    assert.throws(() => parseFrame(input));
  }
  const handle = createProtocolSession();
  assert.equal(handle({ ...frame("initialize"), protocolVersion: "other" }).response.error.code, "RUNTIME_INCOMPATIBLE");
});

async function exchange(input) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
  child.stdin.end(input);
  return completion;
}

test("stdio emits only valid frames and does not echo malformed secrets", { timeout: 5000 }, async () => {
  const result = await exchange(`secret-value\n${JSON.stringify(frame("initialize", "r2"))}\n${JSON.stringify(frame("shutdown", "r3"))}\n`);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes("secret-value"));
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 3);
  assert.equal(responses[1].requestId, "r2");
  assert.equal(responses[2].data.stopped, true);
});

test("unterminated and oversized frames fail with bounded output", { timeout: 5000 }, async () => {
  for (const input of [JSON.stringify(frame("initialize")), "x".repeat(1024 * 1024 + 1)]) {
    const result = await exchange(input);
    assert.equal(result.code, 2);
    assert.ok(result.stdout.length < 500);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
  }
});
