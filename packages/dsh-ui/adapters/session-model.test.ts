import { expect, it, vi } from 'vitest';
import { observeSessionModel } from './session-model.mjs';

type Selection = { provider: string; model: string; reasoningEffort?: string };
type Projection = { lastUsed: Selection | null; next: Selection | null };
function fixture() {
  let running = false;
  let projection: Projection = { lastUsed: { provider: 'mind-main', model: 'model-a' }, next: { provider: 'mind-main', model: 'model-b', reasoningEffort: 'high' } };
  const sessionListeners = new Set<() => void>();
  const modelListeners = new Set<() => void>();
  const model = { getSnapshot: () => projection, subscribe: (listener: () => void) => { modelListeners.add(listener); return () => modelListeners.delete(listener); } };
  const session = { getSnapshot: () => ({ sessionId: 'session-a', running }), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }, projections: { faceOf: vi.fn(() => model) } };
  return {
    reference: { binding: { session } },
    run: (value: boolean) => { running = value; sessionListeners.forEach(listener => listener()); },
    choose: (value: typeof projection) => { projection = value; modelListeners.forEach(listener => listener()); },
    listeners: () => sessionListeners.size + modelListeners.size,
  };
}

it('shows the next selection while idle and the recorded model while running, even after a later selection', () => {
  const source = fixture(); const changed = vi.fn();
  const dispose = observeSessionModel(source.reference, changed);
  expect(changed).toHaveBeenLastCalledWith({ sessionId: 'session-a', running: false, model: 'model-b', reasoningEffort: 'high' });
  source.run(true);
  expect(changed).toHaveBeenLastCalledWith({ sessionId: 'session-a', running: true, model: 'model-a' });
  source.choose({ lastUsed: { provider: 'mind-main', model: 'model-a' }, next: { provider: 'mind-main', model: 'model-c', reasoningEffort: 'low' } });
  expect(changed).toHaveBeenLastCalledWith({ sessionId: 'session-a', running: true, model: 'model-a' });
  source.run(false);
  expect(changed).toHaveBeenLastCalledWith({ sessionId: 'session-a', running: false, model: 'model-c', reasoningEffort: 'low' });
  dispose(); expect(source.listeners()).toBe(0);
  changed.mockClear(); source.run(true); expect(changed).not.toHaveBeenCalled();
});

it('does not substitute a future model for an unknown running selection', () => {
  const source = fixture(); const changed = vi.fn();
  source.choose({ lastUsed: null, next: { provider: 'mind-main', model: 'future-model' } });
  source.run(true);
  const dispose = observeSessionModel(source.reference, changed);
  expect(changed).toHaveBeenLastCalledWith({ sessionId: 'session-a', running: true, model: null });
  dispose();
});
