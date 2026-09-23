import { afterEach, expect, it, vi } from 'vitest';
import { VoicePlayer } from './voice-player';

afterEach(() => vi.unstubAllGlobals());

it('schedules delayed sources and later epochs once on the same audio clock', async () => {
  const starts: number[][] = [];
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    decodeAudioData: async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.02]) }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }),
    resume: async () => {}, close: async () => {},
  };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  const player = new VoicePlayer();
  await player.load([
    { path: 'mic', epoch: 1, source: 'microphone', startMs: 600, durationMs: 1000 },
    { path: 'sys', epoch: 1, source: 'system', startMs: 180, durationMs: 1000 },
    { path: 'next', epoch: 2, source: 'microphone', startMs: 200, durationMs: 1000 },
  ], path => path, new AbortController().signal);
  expect(player.duration).toBeCloseTo(4.8);
  await player.play();
  expect(starts).toEqual([[10.6, 0], [10.18, 0], [12.8, 0]]);
  context.currentTime = 13;
  expect(player.position).toBe(3);
  expect(starts).toHaveLength(3);
  player.pause();
  context.currentTime = 20;
  expect(player.position).toBe(3);
  player.dispose();
});
