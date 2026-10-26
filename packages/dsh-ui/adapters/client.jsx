import React from 'react';
import { Context } from '@deepseek-ai/cordis';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as typert from '@deepseek-ai/dsh-typert-registry/client';
import * as gateway from '@deepseek-ai/dsh-api-gateway/client';
import * as remotes from '@deepseek-ai/dsh-api-remotes/client';
import * as settings from '@deepseek-ai/dsh-client-ui-settings/client';
import * as locale from '@deepseek-ai/dsh-client-locale/client';
import * as resources from '@deepseek-ai/dsh-client-resources/client';
import * as shortcuts from '@deepseek-ai/dsh-client-shortcuts/client';
import * as sessions from '@deepseek-ai/dsh-api-session-controller/client';
import * as workspaces from '@deepseek-ai/dsh-api-workspace-controller/client';
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client';
import * as conversation from '@deepseek-ai/dsh-client-ui-conversation/client';
import * as chat from '@deepseek-ai/dsh-client-ui-chat/client';
import * as trajectory from '@deepseek-ai/dsh-client-ui-trajectory/client';
import * as tools from '@deepseek-ai/dsh-client-ui-tool/client';
import * as approval from '@deepseek-ai/dsh-client-ui-approval/client';
import * as attachments from '@deepseek-ai/dsh-client-ui-attachment/client';
import * as inputTrigger from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import * as commands from '@deepseek-ai/dsh-client-ui-commands/client';
import * as references from '@deepseek-ai/dsh-client-ui-reference/client';
import * as permissions from '@deepseek-ai/dsh-client-ui-permission-presets/client';
import * as questions from '@deepseek-ai/dsh-client-ui-user-questions/client';
import * as plugins from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import * as settingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client';
import * as settingsInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client';
import * as settingsAgent from '@deepseek-ai/dsh-client-ui-settings-agent-loop/client';
import * as settingsSubagent from '@deepseek-ai/dsh-client-ui-settings-subagent/client';
import * as settingsShell from '@deepseek-ai/dsh-client-ui-settings-shell/client';
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar';
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path';
import { SlotRegistry } from '../upstream/client/ui-renderer/src/client/registry.ts';
import { createSlotRenderer } from '../upstream/client/ui-renderer/src/client/scoped-slots.tsx';
import { FileUploadRuntime } from '../upstream/client/file-upload/src/client/runtime.ts';
import { GeneralSection } from '../upstream/client/ui-settings-general/src/client/GeneralSection.tsx';
import { zh, en } from '../upstream/client/ui-settings-general/src/client/locales.ts';
import { ModelPicker } from './model-picker.jsx';
import { createTauriTransport } from './transport.mjs';
import { adaptFileReferences, adaptFileMessageRenderer, fileReferenceToken, fixedFileFromPath, resolveFileReference } from './file-references.mjs';

const MAX_IDLE_SESSIONS = 4;
const SESSION_IDLE_TTL_MS = 5 * 60_000;
const PASSIVE_STREAMS = new Set(['$events', 'session/control', 'workspace/follow', 'session/follow']);

function requestSession(payload) {
  const args = payload?.args;
  return args?.agentId ?? args?.sessionId ?? args?.request?.address?.sessionId ?? null;
}

function HostFrame({ mode, reference, renderSlot, SessionProvider }) {
  return <div className="dsh-ui-frame">
    {mode === 'settings'
      ? <div className="dsh-ui-settings">{renderSlot('settings.section', {})}</div>
      : mode === 'plugins' ? renderSlot('main', {}, { entryKey: 'plugins' })
        : <SessionProvider session={reference}>{renderSlot('main', {}, { entryKey: 'conversation' })}</SessionProvider>}
    {renderSlot('shell.overlay', {})}
  </div>;
}

/** One DSH service graph per scope, shared by chat and settings.
 * @param {number | null} projectId
 */
export async function createDshClient(projectId) {
  const ctx = new Context();
  // React 19 dev render timing inspects objects passed through slot props.
  // Context children inherit this ordinary marker instead of resolving it as a service.
  Object.defineProperty(ctx, "$$typeof", { value: undefined });
  const transport = createTauriTransport(projectId);
  const listeners = new Set();
  let disposed = false;
  const lifetime = new AbortController();
  const residentSessions = new Map();
  const selecting = new Map();
  const operations = new Map();
  const streaming = new Map();
  let sessionClock = 0;
  let residentTimer;
  let activityChanged = () => {};
  const beginOperation = id => {
    operations.set(id, (operations.get(id) ?? 0) + 1);
    activityChanged();
    return () => {
      const remaining = operations.get(id) - 1;
      if (remaining === 0) operations.delete(id); else operations.set(id, remaining);
      activityChanged();
    };
  };
  const rpc = {
    ...transport.rpc,
    async call(channel, endpoint, payload, signal) {
      const finish = beginOperation(requestSession(payload));
      try { return await transport.rpc.call(channel, endpoint, payload, signal); }
      finally { finish(); }
    },
    async *open(channel, endpoint, payload, signal, uplink) {
      const id = requestSession(payload);
      const token = {};
      const finish = PASSIVE_STREAMS.has(endpoint) ? () => {} : beginOperation(id);
      try {
        for await (const frame of transport.rpc.open(channel, endpoint, payload, signal, uplink)) {
          if (endpoint === 'session/follow') {
            if (frame.type === 'snapshot') {
              if (frame.assistantStream?.activeAttempt) streaming.set(id, token); else if (streaming.get(id) === token) streaming.delete(id);
            } else if (frame.type === 'assistant-stream' && frame.frame.type === 'start') streaming.set(id, token);
            activityChanged();
          }
          yield frame;
          if (endpoint === 'session/follow' && frame.type === 'assistant-stream' && frame.frame.type === 'end') {
            if (streaming.get(id) === token) streaming.delete(id);
            activityChanged();
          }
        }
      } finally { if (endpoint === 'session/follow' && streaming.get(id) === token) streaming.delete(id); finish(); activityChanged(); }
    },
  };
  const fetch = async (...args) => {
    const finish = beginOperation(null);
    try { return await transport.fetch(...args); } finally { finish(); }
  };
  const notify = (type, value) => { for (const listener of listeners) listener(type, value); };
  try {
    const fibers = [];
    const install = (plugin, config) => { const fiber = ctx.plugin(plugin.default ?? plugin, config); fibers.push(fiber); return fiber; };
    const slots = new SlotRegistry(ctx);
    // These upstream views share the existing clickable file mention renderer.
    // Keep this hook for delayed slot injections as declarations change.
    const register = slots.register;
    slots.register = function(options, Component) {
      const view = projectId !== null && options.name === 'conversation.chat.node' && (options.key === 'user' || options.key === 'steering')
        ? adaptFileMessageRenderer(Component) : Component;
      return register.call(this, options, view);
    };
    ctx.effect(() => () => { slots.register = register; });
    slots.install(createSlotRenderer());
    ctx.effect(() => slots.onEntryError((key, _entry, error) => {
      notify('error', `${key}：${error instanceof Error ? error.message : String(error)}`);
    }));
    const panelInfo = createSnapshotStore({ activePanelId: null });
    let navigation = new AbortController();
    ctx.provide('layout', {
      panelInfo,
      selectPanel: activePanelId => panelInfo.set({ activePanelId }),
      beginNavigation() { navigation.abort(); navigation = new AbortController(); return navigation.signal; },
    });
    ctx.provide('sidebarRight', {
      openResource(address, options) {
        const file = parseFileAddress(address);
        if (file === undefined) throw new Error('无法识别项目文件引用');
        // A scoped address must originate in this project's client catalog.
        if (file.scope === 'session' && ctx.sessions.list.getSnapshot().byId[file.sessionId] === undefined)
          throw new Error('文件引用不属于当前项目会话');
        const fixed = fixedFileFromPath(file.path);
        if (fixed) {
          notify('file', { ...fixed, line: options?.params?.line, sessionId: file.scope === 'session' ? file.sessionId : undefined });
          return;
        }
        notify('file', { path: file.path, line: options?.params?.line, sessionId: file.scope === 'session' ? file.sessionId : undefined });
      },
      openTab(_kind, options) { notify('external', options?.params?.url); },
    });
    slots.register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'session-maybe' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
    } }, HostFrame);
    installConnection(ctx, { transport: { rpc, ownsHost: true } });
    // Await each provider before dependents: a pending Cordis fiber's await()
    // only waits current work, not a future activation by another plugin.
    await install(typert).await();
    await install(gateway).await();
    await install(remotes).await();
    await install(settings).await();
    await install(locale).await();
    await install(resources).await();
    await install(shortcuts).await();
    await install({ inject: ['remote'], apply: scope => { new FileUploadRuntime(scope, { fetch }); } }).await();
    await install(sessions).await();
    await install(workspaces).await();
    await install(uiSession).await();
    await install({ inject: ['sessions', 'workspaces', 'locale'], apply(scope) {
      scope.slots.provideRoot({ hooks: { workspaces: scope.workspaces.list } });
      scope.effect(() => scope.locale.register('settings', { zh, en }));
      scope.slots.register({ name: 'settings.section', id: 'general', order: 0, locale: 'settings',
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } } }, GeneralSection);
      scope.provide('uiWorkspace', {
        openSession(target) { notify('session', target); },
        async openWorkspace(workspaceId, beforeOpen) {
          const id = await scope.sessions.create({ workspaceId });
          beforeOpen?.(id);
          scope.uiWorkspace.openSession(id);
        },
        startSession(workspaceId) {
          void scope.uiWorkspace.openWorkspace(workspaceId).catch(error => notify('error', error.message));
        },
      });
    } }).await();
    await install(conversation, { alwaysShowTrajectory: true }).await();
    slots.register({ name: 'conversation.input.model', inject: sessionId => ({
      async loadCatalog() {
        const result = await ctx.remote.session.modelCatalog();
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
      selectModel: selection => ctx.remote.session.selectModel(selection),
      openModelSettings: () => notify('modelSettings', sessionId),
    }) }, ModelPicker);
    for (const plugin of [chat, trajectory, tools, approval, attachments, inputTrigger, commands]) await install(plugin).await();
    // Adapt the existing @ source at its registration boundary: candidates,
    // explicit chips and the original composer keep one serializer contract.
    const registerSource = ctx.inputTriggers.registerSource;
    ctx.inputTriggers.registerSource = function(source) {
      return registerSource.call(this, projectId !== null && source.name === 'reference'
        ? adaptFileReferences(source, fetch, data => notify('file', data)) : source);
    };
    try { await install(references).await(); }
    finally { ctx.inputTriggers.registerSource = registerSource; }
    for (const plugin of [permissions,
      questions, plugins, settingsPlugins, settingsInventory, settingsAgent, settingsSubagent, settingsShell]) await install(plugin).await();
    await Promise.all(fibers.map(fiber => fiber.await()));
    // Missing inject services otherwise leave a silent, permanently blank component tree.
    for (const fiber of fibers) if (fiber.state === 0) {
      throw new Error(`助手组件依赖未就绪：${Object.keys(fiber.inject).filter(name => ctx.get(name) === undefined).join('、')}`);
    }
    const sessionProtected = id => {
      if (selecting.has(id) || operations.has(id) || streaming.has(id)) return true;
      const binding = ctx.sessions.binding(id);
      if (!binding) return false;
      const retained = ctx.sessions.retainInfo(id).getSnapshot();
      if (Object.entries(retained.retainedBy).some(([source, count]) => source !== 'projectContent' && count > 0)) return true;
      const resident = residentSessions.get(id);
      const events = binding.eventSource.getSnapshot();
      if (resident && resident.eventRevision !== events.revision) {
        resident.eventRevision = events.revision;
        resident.hasTransient = events.entries.some(entry => entry.type === 'transient');
      }
      if (resident?.hasTransient) return true;
      const snapshot = binding.session.getSnapshot();
      if (snapshot.running || snapshot.awaitingFirstTurn || snapshot.pendingSubmissions.length > 0
        || snapshot.openState === 'loading' || snapshot.loadingOlder) return true;
      if (ctx.uiSession.sessionStatus.getSnapshot().get(id)?.pendingInteraction !== undefined) return true;
      const input = ctx.conversation.input.for(binding.ctx).state.getSnapshot();
      if (input.phase !== 'plain' || input.attachmentIds.length > 0 || input.occurrences.length > 0 || input.queue.length > 0) return true;
      if (input.draft !== '') {
        // Text is evictable only after the upstream store has actually persisted
        // the exact draft. Quota/storage failures must keep the live shell.
        try {
          if (JSON.parse(localStorage.getItem(`dsh.conversation.${id}`) ?? 'null')?.draft !== input.draft) return true;
        } catch { return true; }
      }
      return false;
    };
    const dropResident = (id, entry) => {
      residentSessions.delete(id);
      for (const unsubscribe of entry.unsubscribes) unsubscribe();
      entry.reference.release();
    };
    const trimResidents = () => {
      clearTimeout(residentTimer);
      residentTimer = undefined;
      if (disposed) return;
      const now = Date.now();
      const idle = [];
      for (const [id, entry] of residentSessions) {
        if (sessionProtected(id)) { entry.idleSince = null; continue; }
        entry.idleSince ??= now;
        idle.push([id, entry]);
      }
      idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const remaining = [];
      for (const [id, entry] of idle) {
        if (now - entry.idleSince >= SESSION_IDLE_TTL_MS) dropResident(id, entry);
        else remaining.push([id, entry]);
      }
      while (remaining.length > MAX_IDLE_SESSIONS) {
        const [id, entry] = remaining.shift();
        dropResident(id, entry);
      }
      notify('residency');
      if (remaining.length > 0) residentTimer = setTimeout(trimResidents, Math.max(1,
        Math.min(...remaining.map(([, entry]) => entry.idleSince + SESSION_IDLE_TTL_MS - now))));
    };
    activityChanged = () => {
      if (disposed) return;
      clearTimeout(residentTimer);
      // Settle the current Remote/store publication before deciding to unload.
      residentTimer = setTimeout(trimResidents, 0);
    };
    const retainResident = id => {
      let entry = residentSessions.get(id);
      if (!entry) {
        const reference = ctx.sessions.retain(id, { source: 'projectContent' });
        const binding = reference.binding;
        const input = ctx.conversation.input.for(binding.ctx);
        entry = { reference, lastUsed: ++sessionClock, idleSince: null, unsubscribes: [
          binding.session.subscribe(activityChanged), binding.eventSource.subscribe(activityChanged),
          input.state.subscribe(activityChanged), ctx.sessions.retainInfo(id).subscribe(activityChanged),
        ] };
        residentSessions.set(id, entry);
      }
      entry.lastUsed = ++sessionClock;
      entry.idleSince = null;
      return entry;
    };
    const unsubscribeResidency = ctx.uiSession.sessionStatus.subscribe(activityChanged);
    const currentSessionRuns = () => Object.fromEntries(Object.entries(ctx.sessions.list.getSnapshot().byId).map(([id, item]) => [id, item.running]));
    const currentSessionTitles = () => {
      const { ids, byId } = ctx.sessions.list.getSnapshot();
      return Object.fromEntries(ids.map(id => [id, byId[id].title?.trim() ? byId[id].title : '新会话']));
    };
    const currentBusy = () => Object.values(ctx.sessions.list.getSnapshot().byId).some(item => item.running);
    const currentCatalog = () => {
      const { ids, byId } = ctx.sessions.list.getSnapshot();
      const { pinnedSessionIds, archivedSessionIds } = ctx.workspaces.list.getSnapshot();
      // Only Host-list members belong to the native sidebar catalog. Retained
      // subagent fallbacks and runtime/ownership state must not trigger reloads.
      return JSON.stringify([ids.map(id => [id, byId[id].title, byId[id].displayTitle, byId[id].updatedAt]),
        pinnedSessionIds, archivedSessionIds]);
    };
    let catalog = currentCatalog();
    let sessionTitles = JSON.stringify(currentSessionTitles());
    let listPending = false;
    let runtimePending = false;
    const scheduleListChange = () => {
      if (disposed || listPending) return;
      listPending = true;
      queueMicrotask(() => {
        listPending = false;
        if (!disposed) {
          const nextCatalog = currentCatalog();
          if (nextCatalog !== catalog) {
            catalog = nextCatalog;
            notify('sessionsChanged');
            const titles = currentSessionTitles();
            const nextTitles = JSON.stringify(titles);
            if (nextTitles !== sessionTitles) {
              sessionTitles = nextTitles;
              notify('sessionTitles', titles);
            }
          }
          if (runtimePending) {
            runtimePending = false;
            notify('busy', currentBusy());
            notify('sessionRuns', currentSessionRuns());
          }
        }
      });
    };
    const unsubscribeList = ctx.sessions.list.subscribe(() => {
      runtimePending = true;
      scheduleListChange();
      activityChanged();
    });
    const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(scheduleListChange);
    const unsubscribeStatus = ctx.remote.$on('api-session/status', (_id, running) => {
      if (!running) notify('filesChanged');
    });
    return {
      ctx,
      isIdle() {
        return selecting.size === 0 && operations.size === 0 && streaming.size === 0 && !currentBusy()
          && ![...ctx.uiSession.sessionStatus.getSnapshot().values()].some(status => status.pendingInteraction !== undefined)
          && !Object.values(ctx.sessions.list.getSnapshot().byId).some(row =>
            Object.entries(row.retainedBy).some(([source, count]) => source !== 'projectContent' && count > 0))
          && [...residentSessions.keys()].every(id => !sessionProtected(id));
      },
      async select(id, signal) {
        if (disposed) throw new Error('助手客户端已关闭');
        if (typeof id !== 'string' || id.length === 0) throw new Error('会话页面必须指定 Session ID');
        selecting.set(id, (selecting.get(id) ?? 0) + 1);
        try {
          const opening = AbortSignal.any([lifetime.signal, signal ?? new AbortController().signal, AbortSignal.timeout(15000)]);
          // The native catalog is authoritative, but the original client receives
          // it asynchronously through session/control before a retain is legal.
          await new Promise((resolve, reject) => {
            let unsubscribe;
            const cleanup = () => { unsubscribe?.(); opening.removeEventListener('abort', abort); };
            const abort = () => { cleanup(); reject(opening.reason); };
            const check = () => {
              if (ctx.sessions.list.getSnapshot().byId[id] === undefined) return;
              cleanup(); resolve();
            };
            unsubscribe = ctx.sessions.list.subscribe(check);
            opening.addEventListener('abort', abort, { once: true });
            if (opening.aborted) abort(); else check();
          });
          opening.throwIfAborted();
          const selected = ctx.sessions.retain(id, { source: 'mainView', signal: opening });
          try {
            await selected.ready;
            opening.throwIfAborted();
            const entry = retainResident(id);
            const release = selected.release.bind(selected);
            let released = false;
            selected.release = () => {
              if (released) return;
              released = true;
              release();
              entry.lastUsed = ++sessionClock;
              activityChanged();
            };
            return selected;
          } catch (error) {
            selected.release();
            throw error;
          }
        } finally {
          const remaining = selecting.get(id) - 1;
          if (remaining === 0) selecting.delete(id); else selecting.set(id, remaining);
          activityChanged();
        }
      },
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        listener('busy', currentBusy());
        listener('sessionRuns', currentSessionRuns());
        listener('sessionTitles', currentSessionTitles());
        return () => listeners.delete(listener);
      },
      async insertFile(sessionId, path, sourceRef, selection) {
        const finish = beginOperation(sessionId);
        try {
          if (ctx.sessions.binding(sessionId) === undefined) throw new Error('请先选择项目会话');
          const scope = ctx.sessions.scope(sessionId);
          const input = scope === undefined ? undefined : ctx.conversation.input.for(scope);
          if (input === undefined) throw new Error('助手输入框尚未就绪');
          const mention = formatFileMention({ path, kind: 'file' }, false);
          if (mention === undefined) throw new Error('此文件路径不能作为助手引用');
          const state = input.state.getSnapshot();
          const end = state.draft.length;
          if (!selection) sourceRef ??= await resolveFileReference(fetch, sessionId, path, lifetime.signal);
          lifetime.signal.throwIfAborted();
          if (ctx.sessions.binding(sessionId) === undefined) throw new Error('目标会话已关闭');
          if (!input.insertReference({ source: 'reference', ref: fileReferenceToken(sessionId, path, sourceRef, selection), label: selection ? `${path} · 选区` : path, appearance: 'file', clipboardText: mention },
            { start: end, end, draftRev: state.draftRev })) throw new Error('输入框正在提交，请稍后引用文件');
          input.focus();
        } finally { finish(); }
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        clearTimeout(residentTimer);
        unsubscribeResidency();
        for (const [id, entry] of residentSessions) dropResident(id, entry);
        unsubscribeList();
        unsubscribeWorkspaces();
        unsubscribeStatus();
        notify('sessionRuns', {});
        notify('sessionTitles', {});
        listeners.clear();
        await ctx.fiber.dispose();
        await transport.close();
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    await transport.close();
    throw error;
  }
}
