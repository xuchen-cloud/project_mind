import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./client.jsx', () => ({ createDshClient: fixture.create }));
vi.mock('./session-model.mjs', () => ({ observeSessionModel: () => () => {} }));
vi.mock('./scroll-edges.mjs', () => ({ installScrollEdges: () => () => {} }));
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ HostPortalProvider: ({ children }: { children: React.ReactNode }) => children }));
import { DshConversationHost, DshSettingsHost, disposeDshClients } from './index.jsx';

afterEach(async () => { await disposeDshClients(); vi.clearAllMocks(); });

it('retains separate null and Project clients across UI closure, publishes null events and disposes both on Workspace teardown', async () => {
  const listeners = new Map<number | null, Set<(type: string, data: unknown) => void>>();
  const dispose = vi.fn();
  fixture.create.mockImplementation(async (projectId: number | null) => ({
    ctx: { slots: { renderSlot: () => <div data-testid={projectId === null ? 'workspace-chat' : 'project-chat'} /> } },
    subscribe(listener: (type: string, data: unknown) => void) {
      let group = listeners.get(projectId);
      if (!group) { group = new Set(); listeners.set(projectId, group); }
      group.add(listener);
      return () => { group.delete(listener); };
    },
    select: async (sessionId: string) => ({ sessionId, release: vi.fn() }),
    dispose,
  }));
  const busy = vi.fn(); const runs = vi.fn();
  window.addEventListener('mind:dsh-project-busy', busy);
  window.addEventListener('mind:dsh-session-runs', runs);
  const view = render(<DshConversationHost projectId={null} sessionId="same-id" />);
  await screen.findByTestId('workspace-chat');
  view.rerender(<DshConversationHost projectId={7} sessionId="same-id" />);
  await screen.findByTestId('project-chat');
  view.rerender(<DshConversationHost projectId={null} sessionId="same-id" />);
  await screen.findByTestId('workspace-chat');
  expect(fixture.create.mock.calls).toEqual([[null], [7]]);
  expect(dispose).not.toHaveBeenCalled();
  // Each scope's retained subscription survives its last UI seat.
  act(() => {
    for (const listener of listeners.get(null)!) {
      listener('busy', true);
      listener('sessionRuns', { 'same-id': true });
    }
  });
  expect(busy.mock.calls.at(-1)?.[0].detail).toEqual({ projectId: null, busy: true });
  expect(runs.mock.calls.at(-1)?.[0].detail).toEqual({ projectId: null, runningBySession: { 'same-id': true } });
  view.unmount();
  expect(dispose).not.toHaveBeenCalled();
  await disposeDshClients();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(runs.mock.calls.map(([event]) => event.detail)).toContainEqual({ projectId: null, runningBySession: {} });
  window.removeEventListener('mind:dsh-project-busy', busy);
  window.removeEventListener('mind:dsh-session-runs', runs);
});

it('mounts Workspace settings with explicit null ownership', async () => {
  fixture.create.mockResolvedValue({
    ctx: { slots: { renderSlot: () => <div>Workspace settings</div> } },
    subscribe: () => () => {}, dispose: vi.fn(),
  });
  render(<DshSettingsHost projectId={null} mode="settings" />);
  await waitFor(() => expect(screen.getByText('Workspace settings')).toBeVisible());
  expect(fixture.create).toHaveBeenCalledWith(null);
});

it('bridges catalog invalidation with scope only across UI closure and rejects stale client generations', async () => {
  const generations: { projectId: number | null; listeners: Set<(type: string, data?: unknown) => void> }[] = [];
  fixture.create.mockImplementation(async (projectId: number | null) => {
    const generation = { projectId, listeners: new Set<(type: string, data?: unknown) => void>() };
    generations.push(generation);
    return {
      ctx: { slots: { renderSlot: () => <div>Catalog scope {String(projectId)}</div> } },
      subscribe(listener: (type: string, data?: unknown) => void) {
        generation.listeners.add(listener);
        return () => generation.listeners.delete(listener);
      },
      dispose: vi.fn(),
    };
  });
  const changed = vi.fn();
  window.addEventListener('mind:dsh-sessions-changed', changed);
  const emit = (generation: typeof generations[number]) => {
    for (const listener of generation.listeners) listener('sessionsChanged', { sessions: ['must-not-leak'] });
  };
  try {
    const view = render(<>
      <DshSettingsHost projectId={null} mode="settings" />
      <DshSettingsHost projectId={7} mode="settings" />
      <DshSettingsHost projectId={8} mode="settings" />
    </>);
    await screen.findByText('Catalog scope 8');
    expect(changed).not.toHaveBeenCalled();
    view.unmount();
    for (const generation of generations) emit(generation);
    expect(changed.mock.calls.map(([event]) => event.detail)).toEqual([
      { projectId: null }, { projectId: 7 }, { projectId: 8 },
    ]);
    const stale = generations[1];
    await disposeDshClients();
    changed.mockClear();
    emit(stale);
    expect(changed).not.toHaveBeenCalled();
    const reopened = render(<DshSettingsHost projectId={7} mode="settings" />);
    await screen.findByText('Catalog scope 7');
    emit(stale);
    expect(changed).not.toHaveBeenCalled();
    emit(generations[3]);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0][0].detail).toEqual({ projectId: 7 });
    reopened.unmount();
  } finally { window.removeEventListener('mind:dsh-sessions-changed', changed); }
});
