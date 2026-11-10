import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertReport, requiredAssertions } from './contract.mjs';

const complete = () => ({ kind: 'file-flows-native', status: 'passed', windowLabel: 'main', visibility: 'visible',
  runtimeErrors: [], assertions: requiredAssertions.map(name => ({ name, passed: true })) });
test('collector fails closed on partial, hidden, runtime-error, and failed evidence', () => {
  assert.doesNotThrow(() => assertReport(complete()));
  for (const change of [report => { report.assertions.pop(); }, report => { report.assertions[0].passed = false; },
    report => { report.status = 'failed'; }, report => { report.visibility = 'hidden'; },
    report => { report.runtimeErrors.push('unhandled failure'); }, report => { delete report.runtimeErrors; },
    report => { report.assertions.push({ name: 'extra-failure', passed: false }); }, report => { report.windowLabel = 'untrusted'; }]) {
    const report = complete(); change(report); assert.throws(() => assertReport(report));
  }
  assert.throws(() => assertReport(undefined));
});
test('flow page is imported only behind the existing compile-time opt-in', async () => {
  const entry = await readFile(new URL('../office-selection/entry.ts', import.meta.url), 'utf8');
  assert.match(entry, /if\(import\.meta\.env\.OFFICE_PERFORMANCE && config\?\.page==='file-flows'\)void import\('\.\.\/file-flows\/native-page'\)/);
});
