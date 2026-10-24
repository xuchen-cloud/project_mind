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
  const providers = configuredProviders(provider);
  // A credential pasted into a profile name must stay out of public catalogs.
  const publicName = value => providers.some(item => value.name.includes(item.apiKey))
    ? (value.id === 'mind-main' ? '默认配置' : `配置 ${value.id.slice('mind-profile-'.length)}`)
    : value.name;
  return [
    { id: 'web-runtime', config: { printUrl: false, openBrowser: false, surfaceContext: true, trustedHosts: [] } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'ui-settings-models', disabled: true },
    { id: 'agent-default-model', config: { provider: 'mind-main', model: provider.modelId } },
    // Unlike the official DeepSeek adapter, generic OpenAI-compatible routes
    // may include reasoning in the output budget of this auxiliary request.
    // Keep rc.2's first-prompt summarizer and short-title target, with enough
    // room for reasoning and ordinary multi-paragraph project questions.
    { id: 'session-title-llm', config: {
      targetWords: 5, targetCjkCharacters: 10,
      maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 60000,
    } },
    { id: 'llm-pi-ai', config: { providers: Object.fromEntries(providers.map(value => [value.id, {
      displayName: publicName(value), api: 'openai-completions', baseURL: value.baseUrl,
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
