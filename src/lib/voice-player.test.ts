import { afterEach, expect, it, vi } from 'vitest';
import { VoicePlayer } from './voice-player';

afterEach(() => vi.unstubAllGlobals());

it('schedules delayed sources and later epochs once on the same audio clock', async () => {
  const starts: number[][] = [];
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }),
    resume: async () => {}, close: async () => {},
  };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData() { return { duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.02]) }; }
  });
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

it('seeks across rolling chunk boundaries without replaying an earlier chunk', async () => {
  const starts: number[][] = [];
  vi.stubGlobal('AudioContext', class {
    currentTime = 10;
    destination = {};
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() { return { playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }; }
    async resume() {}
    async close() {}
  });
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData() { return { duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.1]) }; }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  const player = new VoicePlayer();
  await player.load([
    { path: 'first', epoch: 1, source: 'microphone', startMs: 0, durationMs: 1000 },
    { path: 'second', epoch: 1, source: 'microphone', startMs: 1000, durationMs: 1000 },
  ], path => path, new AbortController().signal);
  player.seek(1.25);
  await player.play();
  expect(player.duration).toBe(2);
  expect(starts).toEqual([[10, 0.25]]);
  player.dispose();
});

it('loads, seeks and disposes an unplayed recording without opening an output device', async () => {
  const createHardwareContext = vi.fn();
  vi.stubGlobal('AudioContext', class { constructor() { createHardwareContext(); } });
  const decode = vi.fn(async () => ({ duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0.1]) }));
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  const player = new VoicePlayer();
  await player.load([
    { path: 'mic', epoch: 1, source: 'microphone', startMs: 0, durationMs: 2000 },
  ], path => path, new AbortController().signal);
  expect(decode).toHaveBeenCalledOnce();
  expect(player.duration).toBe(2);
  player.seek(1);
  player.setSpeed(1.5);
  player.pause();
  expect(player.position).toBe(1);
  player.dispose();
  expect(createHardwareContext).not.toHaveBeenCalled();
});

it('opens one output device on first play and reuses it after pause', async () => {
  const createHardwareContext = vi.fn();
  const resume = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const context = {
    currentTime: 0, destination: {}, createGain: () => gain, resume, close,
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start() {} }),
  };
  vi.stubGlobal('AudioContext', class { constructor() { createHardwareContext(); return context; } });
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData() { return { duration: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0.1]) }; }
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  const player = new VoicePlayer();
  await player.load([
    { path: 'mic', epoch: 1, source: 'microphone', startMs: 0, durationMs: 2000 },
  ], path => path, new AbortController().signal);
  expect(createHardwareContext).not.toHaveBeenCalled();
  await player.play();
  expect(createHardwareContext).toHaveBeenCalledOnce();
  expect(gain.gain.value).toBeCloseTo(4.5);
  expect(gain.connect).toHaveBeenCalledWith(context.destination);
  context.currentTime = 0.5;
  player.pause();
  expect(player.position).toBe(0.5);
  await player.play();
  expect(createHardwareContext).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledTimes(2);
  player.dispose();
  expect(close).toHaveBeenCalledOnce();
});
