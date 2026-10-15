import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCompatibleProfile } from '../../src/profile-map.mjs';

const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
  baseUrl: 'https://compatible.example/v1/', defaultModel: 'default-model', apiKeyLast4: '1234' };

test('mapping works without a probe and never forwards Profile credentials', () => {
  assert.deepEqual(mapCompatibleProfile(profile), { baseUrl: 'https://compatible.example/v1', modelId: 'default-model', api: 'openai-completions' });
  assert.deepEqual(mapCompatibleProfile(profile, { model: 'override-model' }),
    { baseUrl: 'https://compatible.example/v1', modelId: 'override-model', api: 'openai-completions' });
  assert.throws(() => mapCompatibleProfile({ ...profile, providerFamily: 'anthropic_compatible' }),
    { code: 'RUNTIME_INCOMPATIBLE' });
  assert.throws(() => mapCompatibleProfile({ ...profile, enabled: false }), { code: 'PROFILE_UNAVAILABLE' });
  assert.throws(() => mapCompatibleProfile({ ...profile, baseUrl: 'https://secret:password@example.com' }),
    { code: 'INVALID_ARGUMENT' });
});
