import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VoiceSessionSnapshot } from '../../lib/voice-types';
import { createVoiceLivePoll } from './voice-live-poll';

// Only the physical Tauri event/invoke carriers are substituted. Two pollers
// execute the production coordination, scheduling and cancellation functions.
const boundary = vi.hoisted(() => ({
  listeners: new Set<(event: { payload: any }) => void>(),
  snapshot: vi.fn(), tail: vi.fn(), messages: [] as any[], suppressGone: false,
}));
vi.mock('../../services/desktopApi', () => ({ desktopApi: {
  listenEvent: vi.fn(async (_: string, callback: (payload: any) => void) => {
    const carrier = (event: { payload: any }) => callback(event.payload);
    boundary.listeners.add(carrier);
    return () => boundary.listeners.delete(carrier);
  }),
  emitEvent: vi.fn(async (_: string, payload: any) => {
    boundary.messages.push(payload);
    if (payload.type === "gone" && boundary.suppressGone) return;
    for (const callback of boundary.listeners) callback({ payload });
  }),
} }));
vi.mock('../../services/voiceApi', () => ({ voiceApi: { snapshotGet: boundary.snapshot, transcriptTail: boundary.tail } }));
const snapshot = (revision = 1, phase = 'recording') => ({ sessionId: 's', revision, phase, activeMs: 1000 }) as VoiceSessionSnapshot;
const stops: (() => void)[] = [];
function start(role: 'main' | 'caption', captions = true) {
  const onPacket = vi.fn(), onError = vi.fn();
  const poll = createVoiceLivePoll({ role, captions: () => captions, onPacket, onError });
  stops.push(poll.stop);
  return { ...poll, onPacket, onError };
}
async function flush() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  boundary.messages = []; boundary.suppressGone = false;
  boundary.snapshot.mockReset().mockResolvedValue(snapshot());
  boundary.tail.mockReset().mockResolvedValue([{ id: 'one', text: 'live' }]);
});
afterEach(() => {
  stops.splice(0).forEach(stop => stop());
  boundary.listeners.clear();
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});

it('shares steady live snapshot/tail reads across windows and falls back after owner loss', async () => {
  const main = start('main'); await flush();
  const caption = start('caption'); await flush();
  expect(boundary.snapshot.mock.calls.length).toBe(3); // initial main read + two-window discovery
  boundary.snapshot.mockClear(); boundary.tail.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(10);
  expect(boundary.tail).toHaveBeenCalledTimes(10);
  expect(caption.onPacket).toHaveBeenLastCalledWith({ session: snapshot(), captions: [{ id: 'one', text: 'live' }] });
  boundary.snapshot.mockClear(); main.stop(); await flush();
  expect(boundary.snapshot).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(2);
});

it('keeps only one read while the owner is slow, including beyond the fallback timeout', async () => {
  start('main'); await flush(); start('caption'); await flush();
  let finish!: (value: VoiceSessionSnapshot) => void;
  boundary.snapshot.mockClear().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  boundary.tail.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(boundary.snapshot).toHaveBeenCalledOnce();
  expect(boundary.tail).not.toHaveBeenCalled();
  boundary.snapshot.mockResolvedValue(snapshot(2));
  finish(snapshot(2)); await flush();
  expect(boundary.tail).toHaveBeenCalledOnce();
});

it('uses five-second hidden reads, no tails, and refreshes immediately on visibility', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const main = start('main'); await flush();
  boundary.snapshot.mockClear(); boundary.tail.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(2);
  expect(boundary.tail).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); await flush();
  expect(boundary.snapshot).toHaveBeenCalledTimes(3);
  expect(boundary.tail).toHaveBeenCalledOnce();
  main.stop(); boundary.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(boundary.snapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the hidden main owner live for a visible caption peer, then expires its lease', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  start('main'); await flush();
  for (const listener of boundary.listeners) listener({ payload: { origin: 'caption-window', type: 'interest', visible: true, captions: true } });
  await flush(); boundary.snapshot.mockClear(); boundary.tail.mockClear();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(10);
  expect(boundary.tail).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(5000);
  boundary.snapshot.mockClear(); boundary.tail.mockClear();
  await vi.advanceTimersByTimeAsync(4999);
  expect(boundary.snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(boundary.snapshot).toHaveBeenCalledOnce();
  expect(boundary.tail).not.toHaveBeenCalled();
});

it('publishes recording status and an explicit error even when transcript loading fails', async () => {
  const main = start('main'); await flush(); const caption = start('caption'); await flush();
  boundary.snapshot.mockResolvedValue(snapshot(2, 'paused'));
  boundary.tail.mockRejectedValue(new Error('tail offline'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(main.onPacket).toHaveBeenLastCalledWith({ session: snapshot(2, 'paused'), captions: null, error: 'Error: tail offline' });
  expect(caption.onPacket).toHaveBeenLastCalledWith({ session: snapshot(2, 'paused'), captions: null, error: 'Error: tail offline' });
  expect(main.onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'tail offline' }));
  expect(caption.onError).toHaveBeenLastCalledWith('Error: tail offline');
});

it('does not let an older in-flight read restore a recording after ending in another window', async () => {
  const main = start('main'); await flush(); const caption = start('caption'); await flush();
  let finish!: (value: VoiceSessionSnapshot) => void;
  boundary.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(1000);
  caption.changed(snapshot(2, 'ended'));
  finish(snapshot()); await flush();
  expect(main.onPacket).toHaveBeenLastCalledWith({ session: null, captions: null });
  expect(caption.onPacket).toHaveBeenLastCalledWith({ session: null, captions: null });
  main.stop(); caption.stop(); await flush();
  expect(vi.getTimerCount()).toBe(0);
  expect(boundary.listeners.size).toBe(0);
});

it('shares five-second polling when both windows are hidden without loading captions', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  start('main'); await flush(); start('caption'); await flush();
  boundary.snapshot.mockClear(); boundary.tail.mockClear(); boundary.messages = [];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(boundary.messages.map(message => message.type)).toEqual(["state", "state", "state", "state"]);
  expect(boundary.snapshot).toHaveBeenCalledTimes(4);
  expect(boundary.tail).not.toHaveBeenCalled();
});

it('discards a native reply after stop without rearming work or reporting it', async () => {
  let finish!: (value: VoiceSessionSnapshot) => void;
  boundary.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const poll = start('main'); await flush(); poll.stop();
  finish(snapshot()); await flush();
  expect(poll.onPacket).not.toHaveBeenCalled();
  expect(poll.onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['visible', 'hidden'] as const)('shares idle polling with a %s main and visible caption without a three-second fallback', async visibility => {
  const mainDocument = document.implementation.createHTMLDocument();
  Object.defineProperty(mainDocument, 'visibilityState', { value: visibility });
  const captionDocument = document.implementation.createHTMLDocument();
  Object.defineProperty(captionDocument, 'visibilityState', { value: 'visible' });
  boundary.snapshot.mockResolvedValue(null);
  vi.stubGlobal('document', mainDocument); start('main'); await flush();
  vi.stubGlobal('document', captionDocument); const caption = start('caption'); await flush();
  boundary.snapshot.mockClear(); boundary.tail.mockClear(); boundary.messages = [];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(boundary.messages.map(message => message.type)).toEqual(["state", "state", "state", "state"]);
  expect(boundary.snapshot).toHaveBeenCalledTimes(4);
  expect(boundary.tail).not.toHaveBeenCalled();
  expect(caption.onPacket).toHaveBeenLastCalledWith({ session: null, captions: null });
});

it('keeps real separate hidden-main/visible-caption documents on one live owner', async () => {
  const mainDocument = document.implementation.createHTMLDocument();
  Object.defineProperty(mainDocument, 'visibilityState', { value: 'hidden' });
  const captionDocument = document.implementation.createHTMLDocument();
  Object.defineProperty(captionDocument, 'visibilityState', { value: 'visible' });
  vi.stubGlobal('document', mainDocument); start('main'); await flush();
  vi.stubGlobal('document', captionDocument); start('caption'); await flush();
  boundary.snapshot.mockClear(); boundary.tail.mockClear(); boundary.messages = [];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(20);
  expect(boundary.tail).toHaveBeenCalledTimes(20);
  expect(boundary.messages.filter(message => message.type === 'busy')).toHaveLength(0);
  expect(boundary.messages.filter(message => message.type === 'interest')).toHaveLength(4);
});

it.each([['recording', 3000], ['idle', 7000]] as const)('takes over after an abrupt owner loss within the %s lease', async (phase, lease) => {
  boundary.snapshot.mockResolvedValue(phase === 'idle' ? null : snapshot());
  const main = start('main'); await flush(); const caption = start('caption'); await flush();
  boundary.suppressGone = true; main.stop(); boundary.snapshot.mockClear();
  await vi.advanceTimersByTimeAsync(lease - 1);
  expect(boundary.snapshot).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(boundary.snapshot).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(phase === 'idle' ? 5000 : 1000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(2);
  caption.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('does not emit background state or busy messages when there is no caption consumer', async () => {
  boundary.snapshot.mockResolvedValue(null);
  start('main'); await flush();
  boundary.snapshot.mockClear(); boundary.messages = [];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(boundary.snapshot).toHaveBeenCalledTimes(4);
  expect(boundary.messages).toHaveLength(0);
});
