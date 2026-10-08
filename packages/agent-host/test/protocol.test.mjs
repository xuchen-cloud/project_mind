import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrame, PROTOCOL_VERSION } from "../src/protocol.mjs";
import { createHostProtocol } from '../src/host-protocol.mjs';
const frame = (method, requestId = "r1") => ({ protocolVersion: PROTOCOL_VERSION, requestId, method });

test("production handshake exposes executable read-only runtime and explicit tools", async () => {
  const frames = [];
  const protocol = createHostProtocol({ write: (value) => frames.push(value), workspaceRoot: '/tmp/workspace' });
  await protocol.handle(frame('run.start'));
  assert.equal(frames.at(-1).error.code, 'RUNTIME_INCOMPATIBLE');
  await protocol.handle({ ...frame('initialize'), data: { workspaceRoot: '/tmp/workspace', systemPrompt: 'Scoped manifest', tools: [] } });
  assert.equal(frames.at(-1).data.runtimeAvailable, true);
  assert.equal(frames.at(-1).data.acceptancePending, true);
  assert.equal(frames.at(-1).data.capabilities.fileOutput, false);
  assert.deepEqual(frames.at(-1).data.activeTools, []);
  await protocol.handle(frame('initialize'));
  assert.equal(frames.at(-1).ok, false);
  await protocol.handle(frame('shutdown'));
  assert.equal(frames.at(-1).data.stopped, true);
});

test("rejects unknown methods and protocol mismatches", async () => {
  for (const input of ['null', '[]', JSON.stringify({ ...frame('initialize'), method: 'shell.exec' })]) assert.throws(() => parseFrame(input));
  const frames = [];
  const protocol = createHostProtocol({ write: (value) => frames.push(value) });
  await protocol.handle({ ...frame('initialize'), protocolVersion: 'other' });
  assert.equal(frames.at(-1).error.code, 'RUNTIME_INCOMPATIBLE');
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
