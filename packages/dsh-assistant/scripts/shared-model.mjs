// The native host owns the General AI profile and sends its unlocked key over
// stdin. It stays in memory: never put it in DSH config, environment or history.
export const SHARED_KEY_REF = 'MIND_MAIN_AI_KEY';
export function readSharedModel(line) {
  let frame;
  try { frame = JSON.parse(line); } catch { throw new Error('Invalid main AI configuration'); }
  const provider = frame?.provider;
  if (frame?.type !== 'configure' || !provider ||
      ['name', 'baseUrl', 'modelId', 'apiKey'].some(key => typeof provider[key] !== 'string' || !provider[key].trim()) ||
      typeof provider.supportsImage !== 'boolean') throw new Error('Invalid main AI configuration');
  let url;
  try { url = new URL(provider.baseUrl); } catch { throw new Error('Invalid main AI endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid main AI endpoint');
  return { ...provider, baseUrl: url.href.replace(/\/+$/, ''), modelId: provider.modelId.trim() };
}

export function sharedModelPatches(provider) {
  return [
    { id: 'web-runtime', config: { printUrl: false, openBrowser: false, surfaceContext: true, trustedHosts: [] } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'ui-settings-models', disabled: true },
    { id: 'agent-default-model', config: { provider: 'mind-main', model: provider.modelId } },
    { id: 'llm-pi-ai', config: { providers: { 'mind-main': {
      displayName: provider.name, api: 'openai-completions', baseURL: provider.baseUrl,
      apiKeyEnv: SHARED_KEY_REF, models: [{ id: provider.modelId,
        input: provider.supportsImage ? ['text', 'image'] : ['text'] }],
    } } } },
  ];
}

// Preserve the official provider's signed browser records and all other refs.
// This single read-only reference is supplied by the main app instead of disk.
export function installSharedCredential(ctx, provider) {
  ctx.inject(['credentials'], child => {
    const credentials = child.credentials;
    const resolve = credentials.resolve;
    const describe = credentials.describe;
    const set = credentials.set;
    const unset = credentials.unset;
    child.effect(() => {
      credentials.resolve = async ref => ref === SHARED_KEY_REF
        ? { value: provider.apiKey, source: 'main-app' } : resolve.call(credentials, ref);
      credentials.describe = async ref => ref === SHARED_KEY_REF
        ? { configured: true, source: 'main-app', writable: false } : describe.call(credentials, ref);
      credentials.set = async (ref, value) => {
        if (ref === SHARED_KEY_REF) throw new Error('Use the main application AI settings');
        return set.call(credentials, ref, value);
      };
      credentials.unset = async ref => {
        if (ref === SHARED_KEY_REF) throw new Error('Use the main application AI settings');
        return unset.call(credentials, ref);
      };
      return () => { credentials.resolve = resolve; credentials.describe = describe;
        credentials.set = set; credentials.unset = unset; };
    });
  });
}

// A restored session remembers its previous model. The main configuration is
// authoritative even for old conversations, so update that selection before
// the official stream sends its opening snapshot.
export function installSharedSelection(ctx, provider) {
  ctx.inject(['sessionController'], child => {
    const controller = child.sessionController;
    const follow = controller.follow;
    child.effect(() => {
      controller.follow = async function* (request, signal) {
        if (request.address.kind === 'session') {
          const sessionId = request.address.sessionId;
          const projection = await controller.projections({ sessionId }, signal);
          const next = projection?.values.modelSelection?.next;
          if (next && (next.provider !== 'mind-main' || next.model !== provider.modelId)) {
            await controller.selectModel({ sessionId, provider: 'mind-main', model: provider.modelId });
          }
        }
        yield* follow.call(controller, request, signal);
      };
      return () => { controller.follow = follow; };
    });
  });
}
