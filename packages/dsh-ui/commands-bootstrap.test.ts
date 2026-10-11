import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import * as commands from './upstream/client/ui-commands/src/client/index';

it('activates the original command service, slash source and overlay without ModuleLoader', async () => {
  const ctx = new Context();
  const disposeSource = vi.fn(); const registerSource = vi.fn(() => disposeSource);
  const registerSlot = vi.fn(() => () => {});
  ctx.provide('inputTriggers', { registerSource });
  ctx.provide('sessions', {});
  ctx.provide('remote', { commands: {}, $on: vi.fn(() => () => {}) });
  ctx.provide('remote.commands', {});
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key });
  ctx.provide('slots', { inject: (_name: string, register: () => void) => register(), register: registerSlot });
  try {
    const fiber = ctx.plugin(commands);
    await fiber.await();
    expect(fiber.state).toBe(2);
    await vi.waitFor(() => expect(ctx.get('commandUi')).toBeInstanceOf(commands.CommandUiRuntime));
    expect(registerSource).toHaveBeenCalledOnce();
    expect(registerSource.mock.calls[0][0]).toMatchObject({ trigger: '/', name: 'command' });
    await vi.waitFor(() => expect(registerSlot).toHaveBeenCalledOnce());
    expect(registerSlot.mock.calls[0][0]).toMatchObject({ name: 'conversation.input.overlay', id: 'command-popup' });
    expect(typeof ctx.get('commandUi').register).toBe('function');
    expect(typeof ctx.get('commandUi').popupFor).toBe('function');
  } finally {
    await ctx.fiber.dispose();
  }
  expect(disposeSource).toHaveBeenCalledOnce();
});
