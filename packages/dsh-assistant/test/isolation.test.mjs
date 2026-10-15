import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantDataPath, assistantEnvironment } from '../scripts/isolation.mjs';

test('Node harness home ignores ambient DSH data and uses independent directory', () => {
  const env = assistantEnvironment({ DSH_HOME: '/main-data', PROJECT_MIND_DSH_USER_DATA: '/assistant-data', ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: 'test' });
  assert.equal(env.DSH_HOME, '/assistant-data');
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, 'test');
});
test('relative explicit data paths fail', () => assert.throws(() => assistantDataPath({ PROJECT_MIND_DSH_USER_DATA: 'relative' }), /absolute/));
test('platform defaults use project-mind-dsh', () => {
  assert.equal(assistantDataPath({}, 'darwin', '/home/me'), '/home/me/Library/Application Support/project-mind-dsh');
  assert.equal(assistantDataPath({}, 'linux', '/home/me'), '/home/me/.local/share/project-mind-dsh');
});
