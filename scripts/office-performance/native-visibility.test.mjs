import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('./native-visibility.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { waitForNativeVisibility } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
class VisibilityDocument extends EventTarget {
  visibilityState = 'hidden';
  listeners = new Set();
  addEventListener(name, callback, options) { this.listeners.add(callback); super.addEventListener(name, callback, options); }
  removeEventListener(name, callback, options) { this.listeners.delete(callback); super.removeEventListener(name, callback, options); }
  visible() { this.visibilityState = 'visible'; this.dispatchEvent(new Event('visibilitychange')); }
}
test('already visible starts without subscriptions or synthetic animation frames', async () => {
  const doc = new VisibilityDocument(); doc.visible();
  assert.equal((await waitForNativeVisibility(doc)).initialVisibility, 'visible');
  assert.equal(doc.listeners.size, 0);
});
test('hidden preflight waits for actual visibility and releases the subscription', async () => {
  const doc = new VisibilityDocument(); let completed = false;
  const pending = waitForNativeVisibility(doc).then(result => { completed = true; return result; });
  await Promise.resolve(); assert.equal(completed, false); assert.equal(doc.listeners.size, 1);
  doc.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); assert.equal(completed, false);
  doc.visible(); const result = await pending;
  assert.equal(result.initialVisibility, 'hidden'); assert.equal(result.visibility, 'visible');
  assert.ok(result.waitedMs >= 0); assert.equal(doc.listeners.size, 0);
});
test('visibility changing while subscribing cannot be missed', async () => {
  const doc = new VisibilityDocument();
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (...args) => { doc.visibilityState = 'visible'; add(...args); };
  assert.equal((await waitForNativeVisibility(doc)).visibility, 'visible');
  assert.equal(doc.listeners.size, 0);
});
test('a hidden timeout is a preflight failure with listener cleanup', async () => {
  const doc = new VisibilityDocument();
  await assert.rejects(waitForNativeVisibility(doc, 0), /did not become visible before measurement/);
  assert.equal(doc.listeners.size, 0);
});
