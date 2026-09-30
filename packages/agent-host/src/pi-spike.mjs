// AI-01 probe only. The production protocol continues to report unavailable
// until provider and packaged-runtime acceptance has passed on both platforms.
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager }
  from '@earendil-works/pi-coding-agent';
import { encodeSession, decodeSession } from './session-codec.mjs';

const TOOL_METHODS = { mind_source_read: 'source.read', mind_output_stage: 'output.stage' };

function memoryCredentials(providerId, apiKey) {
  const values = new Map([[providerId, { type: 'api_key', key: apiKey }]]);
  const queues = new Map();
  const modify = async (id, operation) => {
    const previous = queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const value = await operation(structuredClone(values.get(id)));
      if (value === undefined) values.delete(id);
      else values.set(id, structuredClone(value));
      return structuredClone(value);
    });
    queues.set(id, current);
    try { return await current; }
    finally { if (queues.get(id) === current) queues.delete(id); }
  };
  return {
    read: async (id) => structuredClone(values.get(id)),
    list: async () => [...values].map(([id, value]) => ({ providerId: id, type: value.type })),
    modify,
    delete: async (id) => { await modify(id, async () => undefined); },
    clear: () => values.clear(),
  };
}

function restrictedResources() {
  // ResourceLoader is a public SDK interface. Construct only our owned loaded
  // extension; do not call DefaultResourceLoader, which resolves local packages
  // even when its noExtensions/noSkills switches are set.
  const extensionPath = '<inline:project-mind-paths>';
  const ownedExtension = {
    path: extensionPath, resolvedPath: extensionPath,
    sourceInfo: { path: extensionPath, source: 'inline', scope: 'temporary', origin: 'top-level' },
    handlers: new Map([['before_agent_start', [(event) => {
      event.systemPromptOptions.cwd = 'workspace:.';
    }]]]),
    tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(),
    commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  const extensions = { extensions: [ownedExtension], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'You are ProjectMind. Use only the supplied scoped tools. Paths are Workspace-relative references.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Resource discovery is disabled'); },
    reload: async () => {},
  };
}

export async function createPiProbe({ workspaceRoot, sessionId, baseUrl, modelId, apiKey,
  dispatchTool, checkpoint, onEvent = () => {} }) {
  const providerId = 'project-mind-compatible';
  const credentials = memoryCredentials(providerId, apiKey);
  let disposableSession;
  try {
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider(providerId, {
      baseUrl, api: 'openai-completions', authHeader: true,
      models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'],
        contextWindow: 32768, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      credentials.clear();
      throw Object.assign(new Error('Profile model could not be registered'), { code: 'PROFILE_UNAVAILABLE' });
    }
    const entries = checkpoint
      ? decodeSession(checkpoint.jsonl, workspaceRoot, sessionId, checkpoint.checksum) : undefined;
    const manager = SessionManager.inMemory(workspaceRoot, { id: sessionId }, entries);
    if (checkpoint) {
      if (checkpoint.leafId === null) manager.resetLeaf();
      else if (typeof checkpoint.leafId === 'string' && manager.getEntry(checkpoint.leafId)) manager.branch(checkpoint.leafId);
      else throw Object.assign(new Error('Session checkpoint leaf is missing'), { code: 'RUNTIME_INCOMPATIBLE' });
    }
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
    const tools = Object.entries(TOOL_METHODS).map(([name, method]) => ({
      name, label: method, description: `Call ProjectMind ${method} within the Host grant.`,
      parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'], additionalProperties: false },
      execute: async (toolCallId, params, signal) => {
        const result = await dispatchTool({ method, toolCallId, payload: params.payload, signal });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    }));
    const { session } = await createAgentSession({ cwd: workspaceRoot,
      agentDir: workspaceRoot, modelRuntime: runtime, model,
      thinkingLevel: 'off', sessionManager: manager, settingsManager: settings,
      resourceLoader: restrictedResources(), noTools: 'builtin', tools: Object.keys(TOOL_METHODS), customTools: tools });
    disposableSession = session;
    // A restored transcript can declare old tools. Reapply the allowlist explicitly.
    session.setActiveToolsByName(Object.keys(TOOL_METHODS));
    const unsubscribe = session.subscribe(onEvent);
    return {
      activeTools: () => session.getActiveToolNames(),
      async prompt(text) {
        await session.prompt(text);
        await session.waitForIdle();
        return { ...encodeSession([manager.getHeader(), ...manager.getEntries()], workspaceRoot), leafId: manager.getLeafId() };
      },
      cancel: () => session.abort(),
      async dispose() {
        try { await session.abort(); await session.waitForIdle(); }
        finally {
          try { unsubscribe(); session.dispose(); }
          finally { credentials.clear(); }
        }
      },
    };
  } catch (error) {
    try { await disposableSession?.abort(); await disposableSession?.waitForIdle(); }
    finally { try { disposableSession?.dispose(); } finally { credentials.clear(); } }
    throw error;
  }

}
