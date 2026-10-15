// The native host owns the General AI profile and sends its unlocked key over
// stdin. It stays in memory: never put it in DSH config, environment or history.
export const SHARED_KEY_REF = 'MIND_MAIN_AI_KEY';
export function readSharedModel(line) {
  let frame;
  try { frame = JSON.parse(line); } catch { throw new Error('Invalid main AI configuration'); }
  if (frame?.type !== 'configure' || !frame.provider ||
      (frame.providers !== undefined && !Array.isArray(frame.providers))) throw new Error('Invalid main AI configuration');
  const normalize = provider => {
    if (!provider || ['name', 'baseUrl', 'modelId', 'apiKey'].some(key => typeof provider[key] !== 'string' || !provider[key].trim()) ||
        typeof provider.supportsImage !== 'boolean') throw new Error('Invalid main AI configuration');
    let url;
    try { url = new URL(provider.baseUrl); } catch { throw new Error('Invalid main AI endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid main AI endpoint');
    return { ...provider, baseUrl: url.href.replace(/\/+$/, ''), modelId: provider.modelId.trim() };
  };
  const provider = normalize(frame.provider);
  const ids = new Set(['mind-main']);
  const providers = (frame.providers ?? []).map(value => {
    if (!/^mind-profile-[1-9][0-9]*$/.test(value?.id) || ids.has(value.id)) throw new Error('Invalid main AI provider identity');
    ids.add(value.id);
    return normalize(value);
  });
  return { ...provider, providers };
}

const configuredProviders = provider => [
  { ...provider, id: 'mind-main', keyRef: SHARED_KEY_REF },
  ...(provider.providers ?? []).map(value => ({ ...value, keyRef: `MIND_PROFILE_${value.id.slice('mind-profile-'.length)}_AI_KEY` })),
];

export function sharedModelPatches(provider) {
  return [
    { id: 'web-runtime', config: { printUrl: false, openBrowser: false, surfaceContext: true, trustedHosts: [] } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'ui-settings-models', disabled: true },
    { id: 'agent-default-model', config: { provider: 'mind-main', model: provider.modelId } },
    { id: 'llm-pi-ai', config: { providers: Object.fromEntries(configuredProviders(provider).map(value => [value.id, {
      displayName: value.name, api: 'openai-completions', baseURL: value.baseUrl,
      apiKeyEnv: value.keyRef, models: [{ id: value.modelId,
        input: value.supportsImage ? ['text', 'image'] : ['text'] }],
    }])) } },
  ];
}

// Preserve the official provider's signed browser records and all other refs.
// These read-only references are supplied by the main app instead of disk.
export function installSharedCredential(ctx, provider) {
  const keys = new Map(configuredProviders(provider).map(value => [value.keyRef, value.apiKey]));
  ctx.inject(['credentials'], child => {
    const credentials = child.credentials;
    const resolve = credentials.resolve;
    const describe = credentials.describe;
    const set = credentials.set;
    const unset = credentials.unset;
    child.effect(() => {
      credentials.resolve = async ref => keys.has(ref)
        ? { value: keys.get(ref), source: 'main-app' } : resolve.call(credentials, ref);
      credentials.describe = async ref => keys.has(ref)
        ? { configured: true, source: 'main-app', writable: false } : describe.call(credentials, ref);
      credentials.set = async (ref, value) => {
        if (keys.has(ref)) throw new Error('Use the main application AI settings');
        return set.call(credentials, ref, value);
      };
      credentials.unset = async ref => {
        if (keys.has(ref)) throw new Error('Use the main application AI settings');
        return unset.call(credentials, ref);
      };
      return () => { credentials.resolve = resolve; credentials.describe = describe;
        credentials.set = set; credentials.unset = unset; };
    });
  });
}
