// Shared restricted Pi SDK adapter. The probe below only supplies acceptance fixtures.
import { encodeSession, decodeSession } from './session-codec.mjs';
import { installContextPolicy } from './context-policy.mjs';
import { capacityFromRuntime } from './model-capacity.mjs';

import { DEFAULT_SYSTEM_PROMPT, PROBE_TOOLS, validateToolDescriptors } from './tool-descriptors.mjs';

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

function restrictedResources(systemPrompt, createExtensionRuntime, beforeCompact) {
  // ResourceLoader is a public SDK interface. Construct only our owned loaded
  // extension; do not call DefaultResourceLoader, which resolves local packages
  // even when its noExtensions/noSkills switches are set.
  const extensionPath = '<inline:project-mind-paths>';
  const ownedExtension = {
    path: extensionPath, resolvedPath: extensionPath,
    sourceInfo: { path: extensionPath, source: 'inline', scope: 'temporary', origin: 'top-level' },
    handlers: new Map([['session_before_compact', [async (event) => beforeCompact?.(event)]], ['before_agent_start', [(event) => {
      event.systemPromptOptions.cwd = 'workspace:.';
    }]], ['message_end', [(event) => {
      // Provider diagnostics may echo authorization headers. Preserve the SDK
      // failed turn and usage, but keep its diagnostic metadata generic.
      if (event.message.role === 'assistant' && event.message.errorMessage !== undefined) {
        return { message: { ...event.message, errorMessage: event.message.stopReason === 'aborted'
          ? 'Provider request cancelled' : 'Provider request failed' } };
      }
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
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('Resource discovery is disabled'); },
    reload: async () => {},
  };
}

export async function createPiSession({ workspaceRoot, sessionId, baseUrl, modelId, apiKey,
  dispatchTool, checkpoint, tools: descriptors = [], systemPrompt = DEFAULT_SYSTEM_PROMPT,
  maxTokens, contextWindow, onEvent = () => {}, historyPolicy,
  compactionEnabled = true }) {
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager }
    = await import('@earendil-works/pi-coding-agent');
  const providerId = 'project-mind-compatible';
  const credentials = memoryCredentials(providerId, apiKey);
  apiKey = undefined;
  let disposableSession;
  try {
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false });
    const capacity = capacityFromRuntime(runtime, modelId, { maxTokens, contextWindow });
    ({ maxTokens, contextWindow } = capacity);
    runtime.registerProvider(providerId, {
      baseUrl, api: 'openai-completions', authHeader: true,
      models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'],
        contextWindow, maxTokens,
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
    const settings = SettingsManager.inMemory({ compaction: { enabled: compactionEnabled,
      reserveTokens: Math.min(16384, Math.floor(contextWindow / 4)),
      keepRecentTokens: Math.min(20000, Math.floor(contextWindow / 2)) }, cacheWarming: 'off',
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
    const tools = descriptors.map(({ name, method, description, parameters }) => ({
      name, label: method, description, parameters,
      execute: async (toolCallId, params, signal) => {
        const result = await dispatchTool({ method, toolCallId, payload: params, signal });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    }));
    let contextPolicy;
    const { session } = await createAgentSession({ cwd: workspaceRoot,
      agentDir: workspaceRoot, modelRuntime: runtime, model,
      thinkingLevel: 'off', sessionManager: manager, settingsManager: settings,
      resourceLoader: restrictedResources(systemPrompt, createExtensionRuntime,
        (event) => contextPolicy?.beforeCompact(event)), noTools: 'builtin', tools: descriptors.map((tool) => tool.name), customTools: tools });
    disposableSession = session;
    contextPolicy = historyPolicy ? installContextPolicy(session, manager, historyPolicy) : undefined;
    // A restored transcript can declare old tools. Reapply the allowlist explicitly.
    session.setActiveToolsByName(descriptors.map((tool) => tool.name));
    const unsubscribe = session.subscribe(onEvent);
    const snapshot = () => ({ ...encodeSession([manager.getHeader(), ...manager.getEntries()], workspaceRoot), leafId: manager.getLeafId() });
    return {
      activeTools: () => session.getActiveToolNames(),
      checkpoint: snapshot,
      async prompt(text) {
        contextPolicy?.beginRun();
        await session.prompt(text, { expandPromptTemplates: false });
        await session.waitForIdle();
        return snapshot();
      },
      cancel: () => session.abort(),
      async dispose() {
        try { await session.abort(); await session.waitForIdle(); }
        finally {
          try { contextPolicy?.dispose(); unsubscribe(); session.dispose(); }
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

// Legacy AI-01 fixture wrapper: production never supplies these defaults.
export function createPiProbe(options) {
  const tools = validateToolDescriptors(options.tools ?? PROBE_TOOLS, { probe: true });
  const dispatchTool = options.dispatchTool;
  return createPiSession({ ...options, tools, dispatchTool: (call) => dispatchTool({ ...call, payload: call.payload.payload }) });
}
