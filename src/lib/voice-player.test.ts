import { afterEach, expect, it, vi } from 'vitest';
import { VoicePlayer } from './voice-player';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    { path: 'mic', epoch: 1, source: 'microphone', startMs: 600, durationMs: 2000 },
    { path: 'sys', epoch: 1, source: 'system', startMs: 180, durationMs: 2000 },
    { path: 'next', epoch: 2, source: 'microphone', startMs: 200, durationMs: 2000 },
  ], path => path, new AbortController().signal);
  expect(player.duration).toBeCloseTo(4.8);
  await player.play();
  expect(starts).toEqual([[10.18, 0], [10.6, 0], [12.8, 0]]);
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

it('appends saved chunks without replaying history or resetting the running clock and speed', async () => {
  const starts: number[][] = [];
  const rates: number[] = [];
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBufferSource: () => {
      const playbackRate = { value: 1 };
      return { playbackRate, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => { starts.push(args); rates.push(playbackRate.value); } };
    },
    resume: async () => {}, close: async () => {},
  };
  const decode = vi.fn(async () => ({ duration: 60, numberOfChannels: 1, length: 60 * 48_000, getChannelData: () => new Float32Array([0.1]) }));
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  vi.stubGlobal('fetch', fetchAudio);
  const player = new VoicePlayer();
  const first = { path: 'first', epoch: 1, source: 'microphone' as const, startMs: 0, durationMs: 60_000 };
  const signal = new AbortController().signal;
  await player.load([first], path => path, signal);
  player.setSpeed(1.5);
  await player.play();
  context.currentTime = 12;
  await player.load([first, { ...first, path: 'next', startMs: 60_000 }], path => path, signal);
  expect(player.duration).toBe(120);
  expect(player.position).toBe(3);
  expect(fetchAudio.mock.calls.length).toBe(2);
  expect(decode).toHaveBeenCalledTimes(2);
  expect(starts).toHaveLength(2);
  expect(rates).toEqual([1.5, 1.5]);
  player.dispose();
});

it('loads a bounded window of a six-hour dual-track recording and seeks both tracks on one clock', async () => {
  const starts: number[][] = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  const decode = vi.fn(async () => {
    concurrent++;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    await Promise.resolve();
    concurrent--;
    return { duration: 60, numberOfChannels: 2, length: 60 * 48_000, getChannelData: () => new Float32Array([0.1]) };
  });
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('AudioContext', class {
    currentTime = 10;
    destination = {};
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() { return { playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }; }
    async resume() {}
    async close() {}
  });
  const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  vi.stubGlobal('fetch', fetchAudio);
  const chunks = Array.from({ length: 360 }, (_, index) => (['microphone', 'system'] as const).map(source => ({
    path: `${index}-${source}`, epoch: 1, source, startMs: index * 60_000, durationMs: 60_000,
  }))).flat();
  const player = new VoicePlayer();
  await player.load(chunks, path => path, new AbortController().signal);
  expect(player.duration).toBe(21_600);
  expect(fetchAudio).toHaveBeenCalledTimes(4);
  expect(decode).toHaveBeenCalledTimes(4);
  expect(peakConcurrent).toBeLessThanOrEqual(2);
  await player.seek(18_015);
  await player.play();
  expect(starts.slice(0, 2)).toEqual([[10, 15], [10, 15]]);
  expect(fetchAudio).toHaveBeenCalledTimes(8);
  expect(player.resourceUsage.bufferCount).toBeLessThanOrEqual(8);
  expect(player.resourceUsage.bufferBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  player.dispose();
  expect(player.resourceUsage.bufferCount).toBe(0);
});

it('cancels a closed player while decode is in flight and releases its buffers', async () => {
  const decode = vi.fn();
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  vi.stubGlobal('fetch', fetchAudio);
  const player = new VoicePlayer();
  const loaded = player.load([
    { path: 'one', source: 'microphone', epoch: 1, startMs: 0, durationMs: 60_000 },
    { path: 'two', source: 'system', epoch: 1, startMs: 0, durationMs: 60_000 },
    { path: 'next', source: 'microphone', epoch: 1, startMs: 60_000, durationMs: 60_000 },
  ], path => path, new AbortController().signal);
  // Both decoder promises share this completion gate.
  let decodeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  decode.mockImplementation(async () => { decodeCalls++; await gate; return { duration: 60, numberOfChannels: 1, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) }; });
  await vi.waitFor(() => expect(decodeCalls).toBe(2));
  player.dispose();
  release();
  await loaded;
  expect(fetchAudio).toHaveBeenCalledTimes(2);
  expect(player.resourceUsage).toMatchObject({ bufferCount: 0, bufferBytes: 0, activeLoads: 0, reservedBytes: 0 });
});

function legacyWavHeader() {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF'); text(8, 'WAVE'); text(12, 'fmt '); text(36, 'data');
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true); view.setUint32(28, 192_000, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  view.setUint32(40, 3600 * 192_000, true);
  return header;
}

it('seeks an older unchunked original WAV by byte range instead of decoding the entire track', async () => {
  const ranges: (string | null)[] = [];
  const header = legacyWavHeader();
  const decode = vi.fn(async () => ({ duration: 60, numberOfChannels: 1, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) }));
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const range = new Headers(options.headers).get('Range');
    ranges.push(range);
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(range!)!;
    return { ok: true, status: 206, headers: new Headers({ 'Content-Range': `bytes ${first}-${last}/691200044` }), arrayBuffer: async () => range === 'bytes=0-43' ? header.slice(0) : new ArrayBuffer(Number(last) - Number(first) + 1) };
  }));
  const player = new VoicePlayer();
  await player.load([{ path: 'old.wav', epoch: 1, source: 'microphone', startMs: 0, durationMs: 3_600_000 }], path => path, new AbortController().signal);
  await player.seek(3015);
  expect(player.duration).toBe(3600);
  expect(ranges).toHaveLength(49); // one header plus four windows × twelve capped ranges
  expect(ranges).toContain('bytes=576000044-577024043');
  expect(ranges.every(range => range !== null)).toBe(true);
  expect(decode).toHaveBeenCalledTimes(4);
  expect(player.resourceUsage.bufferBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
  player.dispose();
});

it('advances a bounded playback window continuously without restarting an already scheduled source', async () => {
  vi.useFakeTimers();
  const starts: number[][] = [];
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }),
    resume: async () => {}, close: async () => {},
  };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  const decode = vi.fn(async () => ({ duration: 60, numberOfChannels: 2, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) }));
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  vi.stubGlobal('fetch', fetchAudio);
  const chunks = Array.from({ length: 60 }, (_, index) => (['microphone', 'system'] as const).map(source => ({ path: `${index}-${source}`, epoch: 1, source, startMs: index * 60_000, durationMs: 60_000 }))).flat();
  const player = new VoicePlayer();
  await player.load(chunks, path => path, new AbortController().signal);
  await player.play();
  for (let minute = 1; minute < 59; minute++) {
    context.currentTime = 10 + minute * 60 + 0.5;
    await vi.advanceTimersByTimeAsync(250);
    expect(player.resourceUsage.bufferCount).toBe(4);
    expect(player.resourceUsage.bufferBytes + player.resourceUsage.reservedBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    expect(player.resourceUsage.activeSources).toBe(4);
  }
  expect(fetchAudio).toHaveBeenCalledTimes(120);
  expect(decode).toHaveBeenCalledTimes(120);
  expect(starts).toHaveLength(120);
  expect(starts.slice(-2)).toEqual([[3550, 0], [3550, 0]]);
  player.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('keeps playback intent through rapid seeks while serializing uncancellable decodes', async () => {
  const starts: number[][] = [];
  let release!: () => void;
  let hold = false;
  let active = 0;
  let maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }),
    resume: async () => {}, close: async () => {},
  };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  const decode = vi.fn(async () => {
    active++; maximum = Math.max(maximum, active);
    if (hold) await gate;
    active--;
    return { duration: 60, numberOfChannels: 1, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) };
  });
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  const chunks = Array.from({ length: 60 }, (_, index) => (['microphone', 'system'] as const).map(source => ({ path: `${index}-${source}`, epoch: 1, source, startMs: index * 60_000, durationMs: 60_000 }))).flat();
  const player = new VoicePlayer();
  await player.load(chunks, path => path, new AbortController().signal);
  await player.play();
  hold = true;
  const firstSeek = player.seek(1210);
  await vi.waitFor(() => expect(active).toBe(2));
  const lastSeek = player.seek(2415);
  release();
  await Promise.all([firstSeek, lastSeek]);
  expect(maximum).toBe(2);
  expect(starts.slice(-4, -2)).toEqual([[10, 15], [10, 15]]);
  context.currentTime = 11;
  expect(player.position).toBe(2416);
  player.dispose();
});

it('reports a future-window read error and stops playback without retrying indefinitely', async () => {
  vi.useFakeTimers();
  const context = {
    currentTime: 10, destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBufferSource: () => ({ playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start() {} }),
    resume: async () => {}, close: async () => {},
  };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData() { return { duration: 60, numberOfChannels: 1, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) }; }
  });
  const fetchAudio = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }));
  vi.stubGlobal('fetch', fetchAudio);
  const onError = vi.fn();
  const player = new VoicePlayer(onError);
  await player.load(Array.from({ length: 3 }, (_, index) => ({ path: String(index), epoch: 1, source: 'microphone' as const, startMs: index * 60_000, durationMs: 60_000 })), path => path, new AbortController().signal);
  await player.play();
  fetchAudio.mockResolvedValue({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) });
  context.currentTime = 70.5;
  await vi.advanceTimersByTimeAsync(250);
  expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('音频读取失败 (403)'));
  const stopped = player.position;
  context.currentTime = 80;
  expect(player.position).toBe(stopped);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchAudio).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  player.dispose();
});

it('rejects an over-budget original channel layout before decode allocates its AudioBuffer', async () => {
  const encoded = new ArrayBuffer(44);
  new DataView(encoded).setUint16(22, 64, true);
  const decode = vi.fn();
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => encoded })));
  const player = new VoicePlayer();
  await expect(player.load([{ path: 'wide.wav', epoch: 1, source: 'system', startMs: 0, durationMs: 60_000 }], path => path, new AbortController().signal)).rejects.toThrow('96 MiB');
  expect(decode).not.toHaveBeenCalled();
  expect(player.resourceUsage).toMatchObject({ bufferCount: 0, activeLoads: 0, reservedBytes: 0 });
  player.dispose();
});

it('rejects a 206 response for the wrong byte range before decoding any audio', async () => {
  const header = legacyWavHeader();
  const decode = vi.fn(async () => ({ duration: 60, numberOfChannels: 1, length: 2_880_000, getChannelData: () => new Float32Array([0.1]) }));
  vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const range = new Headers(options.headers).get('Range')!;
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(range)!;
    return { ok: true, status: 206, headers: new Headers({ 'Content-Range': `bytes ${Number(first) + 1}-${Number(last) + 1}/691200044` }),
      arrayBuffer: async () => range === 'bytes=0-43' ? header.slice(0) : new ArrayBuffer(Number(last) - Number(first) + 1) };
  }));
  const player = new VoicePlayer();
  await expect(player.load([{ path: 'old.wav', epoch: 1, source: 'microphone', startMs: 0, durationMs: 3_600_000 }], path => path, new AbortController().signal))
    .rejects.toThrow('音频分段响应范围不匹配');
  expect(decode).not.toHaveBeenCalled();
  expect(player.resourceUsage).toMatchObject({ bufferCount: 0, reservedBytes: 0, activeLoads: 0 });
  player.dispose();
});
