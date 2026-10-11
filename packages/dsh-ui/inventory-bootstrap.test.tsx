import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Context } from '@deepseek-ai/cordis';
import * as inventory from './upstream/client/ui-settings-plugin-inventory/src/client/index';
import { PluginInventorySettingsTab } from './upstream/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab';
import { en } from './upstream/client/ui-settings-plugin-inventory/src/client/locales';

const contexts: Context[] = [];
afterEach(async () => { cleanup(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); });
async function boot(modules?: unknown) {
  const ctx = new Context(); contexts.push(ctx);
  let registration: any;
  ctx.provide('slots', {
    inject: (_name: string, register: () => void) => register(),
    register: (value: unknown) => { registration = value; return () => {}; },
  });
  ctx.provide('locale', {
    register: () => () => {}, bind: () => (key: keyof typeof en) => en[key] ?? key,
    resolveText: (value: string) => value,
  });
  ctx.provide('remote', { pluginInventory: { list: async () => ({ ok: true, value: { entries: [] } }) } });
  ctx.provide('remote.pluginInventory', {});
  if (modules !== undefined) ctx.provide('modules', modules);
  const fiber = ctx.plugin(inventory);
  await fiber.await();
  expect(fiber.state).toBe(2);
  expect(registration).toBeDefined();
  return registration.inject();
}
function show(injected: any) {
  return render(<PluginInventorySettingsTab {...injected}
    t={(key: keyof typeof en) => en[key] ?? key}
    useClientSync={(select: (state: unknown) => unknown) => select(injected.hooks.clientSync.getSnapshot())} />);
}
it('activates without modules and shows inventory without a sync warning or retry', async () => {
  const injected = await boot();
  const state = injected.hooks.clientSync.getSnapshot();
  expect(state).toEqual({ syncing: false, failures: [] });
  expect(injected.hooks.clientSync.getSnapshot()).toBe(state);
  const subscriber = vi.fn(); const unsubscribe = injected.hooks.clientSync.subscribe(subscriber);
  unsubscribe(); expect(subscriber).not.toHaveBeenCalled();
  show(injected);
  await screen.findByText(en.empty);
  expect(screen.queryByText(en.clientSyncRetry)).toBeNull();
  expect(screen.queryByText(en.clientSyncing)).toBeNull();
});
it('retains standalone live module state and actual failure retry', async () => {
  const retry = vi.fn(async () => {});
  const snapshot = { syncing: false, failures: [{ id: 'fixture-package', message: 'load failed' }] };
  const state = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  const injected = await boot({ entries: { state, retry } });
  expect(injected.hooks.clientSync).toBe(state);
  show(injected);
  await screen.findByText(en.clientSyncRetry);
  expect(screen.getByText('fixture-package: load failed')).toBeInTheDocument();
  screen.getByText(en.clientSyncRetry).click();
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
});
