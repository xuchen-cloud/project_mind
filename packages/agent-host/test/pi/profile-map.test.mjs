import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCompatibleProfile } from '../../src/profile-map.mjs';

const profile = { providerFamily: 'openai_compatible', enabled: true, supportsText: true,
  baseUrl: 'https://compatible.example/v1/', defaultModel: 'default-model', apiKeyLast4: '1234' };

test('mapping requires verified tool support and never forwards Profile credentials', () => {
  assert.throws(() => mapCompatibleProfile(profile), { code: 'TOOL_CALL_UNSUPPORTED' });
  assert.deepEqual(mapCompatibleProfile(profile, { toolCallingVerified: true, model: 'override-model' }),
    { baseUrl: 'https://compatible.example/v1', modelId: 'override-model', api: 'openai-completions' });
  assert.throws(() => mapCompatibleProfile({ ...profile, providerFamily: 'anthropic_compatible' }, { toolCallingVerified: true }),
    { code: 'RUNTIME_INCOMPATIBLE' });
  assert.throws(() => mapCompatibleProfile({ ...profile, enabled: false }, { toolCallingVerified: true }), { code: 'PROFILE_UNAVAILABLE' });
  assert.throws(() => mapCompatibleProfile({ ...profile, baseUrl: 'https://secret:password@example.com' }, { toolCallingVerified: true }),
    { code: 'INVALID_ARGUMENT' });
});
