import type { VoicePlaybackChunk } from './voice-types';

const MAX_BUFFERS = 8;
const MAX_BUFFER_BYTES = 96 * 1024 * 1024;
const DECODE_CONCURRENCY = 2;
const LOOKAHEAD_SECONDS = 60;
const SAMPLE_RATE = 48_000;

type Entry = { chunk: VoicePlaybackChunk; key: string; sourceOffset: number; start: number; end: number; prefixEnd: number };
type WavHeader = { bytes: ArrayBuffer; sampleRate: number; blockAlign: number; dataBytes: number };
type Decoded = { buffer: AudioBuffer; bytes: number };

/** One audio clock schedules both original sources. Only the playback window is decoded. */
export class VoicePlayer {
  private context: AudioContext | null = null;
  private decoder: OfflineAudioContext | null = null;
  private entries: Entry[] = [];
  private buffers = new Map<string, Decoded>();
  private headers = new Map<string, Promise<WavHeader>>();
  private sources = new Map<string, AudioBufferSourceNode>();
  private gain: GainNode | null = null;
  private peak = 0;
  private offset = 0;
  private started = 0;
  private rate = 1;
  private active = false;
  private wantsPlayback = false;
  private disposed = false;
  private url: (path: string) => string = path => path;
  private signal: AbortSignal | null = null;
  private loading = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private windowRevision = 0;
  private activeLoads = 0;
  private reservedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onError: ((error: unknown) => void) | undefined;
  duration = 0;

  constructor(onError?: (error: unknown) => void) { this.onError = onError; }

  /** Current ownership, including reservations for the at most two decoding buffers. */
  get resourceUsage() {
    return {
      bufferCount: this.buffers.size,
      bufferBytes: [...this.buffers.values()].reduce((sum, item) => sum + item.bytes, 0),
      reservedBytes: this.reservedBytes,
      activeLoads: this.activeLoads,
      activeSources: this.sources.size,
    };
  }

  async load(chunks: VoicePlaybackChunk[], url: (path: string) => string, signal: AbortSignal) {
    if (this.disposed || signal.aborted) return;
    this.url = url;
    if (this.signal !== signal) {
      this.signal?.removeEventListener('abort', this.abort);
      this.signal = signal;
      signal.addEventListener('abort', this.abort, { once: true });
    }
    // The manifest contains persisted sample durations. Discovering the full timeline
    // must not require reading every original file first.
    const epochs = new Map<number, VoicePlaybackChunk[]>();
    for (const chunk of chunks) {
      const group = epochs.get(chunk.epoch) ?? [];
      group.push(chunk);
      epochs.set(chunk.epoch, group);
    }
    let offset = 0;
    const entries: Entry[] = [];
    for (const [, group] of [...epochs].sort(([a], [b]) => a - b)) {
      let duration = 0;
      for (const chunk of group) {
        const start = offset + chunk.startMs / 1000;
        const end = start + chunk.durationMs / 1000;
        // Old recordings saved a whole epoch in one WAV. Treat these original
        // files as virtual 60-second chunks, using bounded asset byte ranges.
        for (let sourceOffset = 0; sourceOffset < chunk.durationMs / 1000; sourceOffset += LOOKAHEAD_SECONDS) {
          entries.push({ chunk, key: `${chunk.path}\0${sourceOffset}`, sourceOffset,
            start: start + sourceOffset, end: Math.min(end, start + sourceOffset + LOOKAHEAD_SECONDS), prefixEnd: 0 });
        }
        duration = Math.max(duration, (chunk.startMs + chunk.durationMs) / 1000);
      }
      offset += duration;
    }
    entries.sort((a, b) => a.start - b.start);
    let prefixEnd = 0;
    for (const entry of entries) entry.prefixEnd = prefixEnd = Math.max(prefixEnd, entry.end);
    this.entries = entries;
    this.duration = offset;
    await this.ensureWindow();
    if (this.active) this.scheduleAvailable();
  }

  get position() {
    return Math.min(this.duration, this.offset + (this.active ? (this.context!.currentTime - this.started) * this.rate : 0));
  }

  async play() {
    if (this.disposed) return false;
    this.wantsPlayback = true;
    if (this.active) return true;
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.updateGain();
      this.gain.connect(this.context.destination);
    }
    const revision = this.windowRevision;
    await this.context.resume();
    await this.ensureWindow();
    if (this.disposed || this.signal?.aborted || revision !== this.windowRevision) return false;
    if (this.active) return true;
    this.started = this.context.currentTime;
    this.active = true;
    this.scheduleAvailable();
    this.armMaintenance();
    return true;
  }

  private window() {
    const position = this.position;
    // Prefix maxima allow binary search even when the two source chunks overlap.
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid].prefixEnd <= position) lo = mid + 1;
      else hi = mid;
    }
    const result: Entry[] = [];
    for (let index = lo; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry.start > position + LOOKAHEAD_SECONDS || result.length > MAX_BUFFERS) break;
      if (entry.end > position) result.push(entry);
    }
    if (result.length <= MAX_BUFFERS) return result;
    // Many short pause epochs can fit inside one minute. Limit only the future
    // lookahead, keeping every source at the current time and stopping before the cutoff.
    const cutoff = result[MAX_BUFFERS].start;
    const limited = result.filter(entry => entry.start < cutoff);
    if (cutoff <= position || limited.length === 0) throw new Error('音频窗口超过播放块容量');
    return limited;
  }

  private ensureWindow() {
    const revision = this.windowRevision;
    // A seek may abort fetch, but decodeAudioData cannot be cancelled. Serialize
    // windows so a superseded decode still occupies its slot until it settles.
    const task = this.queue.then(async () => {
      if (this.disposed || this.signal?.aborted || revision !== this.windowRevision) return;
      const entries = this.window();
      const wanted = new Set(entries.map(entry => entry.key));
      for (const path of this.buffers.keys()) {
        if (!wanted.has(path)) {
          this.stopSource(path);
          this.buffers.delete(path);
        }
      }
      const missing = entries.filter(entry => !this.buffers.has(entry.key));
      let cursor = 0;
      const signal = this.loading.signal;
      const worker = async () => {
        while (cursor < missing.length && !signal.aborted && !this.disposed) {
          const entry = missing[cursor++];
          // Reserve the normal stereo capture size before fetch, then inspect
          // the original WAV channels before decoding (including multichannel devices).
          let reservation = Math.ceil((entry.end - entry.start + 0.002) * SAMPLE_RATE) * 2 * 4;
          if (this.resourceUsage.bufferBytes + this.reservedBytes + reservation > MAX_BUFFER_BYTES) {
            throw new Error('音频窗口超过 96 MiB 解码容量');
          }
          this.reservedBytes += reservation;
          this.activeLoads++;
          try {
            const encoded = await this.readEntry(entry, signal);
            if (signal.aborted || this.disposed) return;
            if (encoded.byteLength >= 44) {
              const channels = new DataView(encoded).getUint16(22, true);
              const required = Math.ceil((entry.end - entry.start + 0.002) * SAMPLE_RATE) * channels * 4;
              if (this.resourceUsage.bufferBytes + this.reservedBytes - reservation + required > MAX_BUFFER_BYTES) {
                throw new Error('音频窗口超过 96 MiB 解码容量');
              }
              this.reservedBytes += required - reservation;
              reservation = required;
            }
            this.decoder ??= new OfflineAudioContext(2, 1, SAMPLE_RATE);
            const buffer = await this.decoder.decodeAudioData(encoded);
            if (signal.aborted || this.disposed) return;
            const bytes = (buffer.length ?? Math.ceil(buffer.duration * SAMPLE_RATE)) * buffer.numberOfChannels * 4;
            if (bytes > reservation) throw new Error('音频解码尺寸超过原始轨道预算');
            for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
              for (const value of buffer.getChannelData(channel)) this.peak = Math.max(this.peak, Math.abs(value));
            }
            this.buffers.set(entry.key, { buffer, bytes });
            this.updateGain();
          } finally {
            this.reservedBytes -= reservation;
            this.activeLoads--;
          }
        }
      };
      // Wait for both workers even on failure: a failed fetch must not release
      // the queue while its peer is still decoding.
      const results = await Promise.allSettled(Array.from({ length: Math.min(DECODE_CONCURRENCY, missing.length) }, worker));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected' && !signal.aborted && !this.disposed) throw failure.reason;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private async readRange(path: string, start: number, length: number, signal: AbortSignal) {
    const result = new Uint8Array(length);
    // Tauri's asset protocol caps a single range response at 1000 KiB.
    for (let offset = 0; offset < length; offset += 1000 * 1024) {
      signal.throwIfAborted();
      const size = Math.min(1000 * 1024, length - offset);
      const response = await fetch(this.url(path), { signal, headers: { Range: `bytes=${start + offset}-${start + offset + size - 1}` } });
      if (!response.ok || response.status !== 206) throw new Error(`音频分段读取失败 (${response.status})`);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
      if (!range || Number(range[1]) !== start + offset || Number(range[2]) !== start + offset + size - 1
        || Number(range[3]) <= Number(range[2])) throw new Error('音频分段响应范围不匹配');
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      if (bytes.byteLength !== size) throw new Error('音频分段读取不完整');
      result.set(new Uint8Array(bytes), offset);
    }
    return result.buffer;
  }

  private async readEntry(entry: Entry, signal: AbortSignal) {
    if (entry.chunk.durationMs <= LOOKAHEAD_SECONDS * 1000) {
      const response = await fetch(this.url(entry.chunk.path), { signal });
      if (!response.ok) throw new Error(`音频读取失败 (${response.status})`);
      return response.arrayBuffer();
    }
    const path = entry.chunk.path;
    let pending = this.headers.get(path);
    if (!pending) {
      pending = this.readRange(path, 0, 44, signal).then(bytes => {
        const view = new DataView(bytes);
        const tag = (offset: number) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
        if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data'
          || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 3 || view.getUint16(34, true) !== 32) {
          throw new Error('原始录音 WAV 格式无效');
        }
        const sampleRate = view.getUint32(24, true);
        const blockAlign = view.getUint16(32, true);
        if (!sampleRate || !blockAlign || blockAlign !== view.getUint16(22, true) * 4) throw new Error('原始录音 WAV 格式无效');
        return { bytes, sampleRate, blockAlign, dataBytes: view.getUint32(40, true) };
      });
      if (this.headers.size >= MAX_BUFFERS) this.headers.delete(this.headers.keys().next().value!);
      this.headers.set(path, pending);
      void pending.catch(() => { if (this.headers.get(path) === pending) this.headers.delete(path); });
    }
    const header = await pending;
    const first = Math.round(entry.sourceOffset * header.sampleRate) * header.blockAlign;
    const length = Math.min(header.dataBytes - first,
      Math.round((entry.end - entry.start) * header.sampleRate) * header.blockAlign);
    if (length <= 0) throw new Error('原始录音 WAV 时间轴无效');
    const data = await this.readRange(path, 44 + first, length, signal);
    const encoded = new Uint8Array(44 + length);
    encoded.set(new Uint8Array(header.bytes));
    encoded.set(new Uint8Array(data), 44);
    const view = new DataView(encoded.buffer);
    view.setUint32(4, length + 36, true);
    view.setUint32(40, length, true);
    return encoded.buffer;
  }

  private updateGain() {
    if (this.gain) this.gain.gain.value = this.peak > 0 ? Math.min(8, 0.45 / this.peak) : 1;
  }

  private scheduleAvailable() {
    if (!this.active || this.disposed) return;
    const position = this.position;
    const clock = this.context!.currentTime;
    for (const entry of this.window()) {
      const decoded = this.buffers.get(entry.key);
      if (!decoded || this.sources.has(entry.key)) continue;
      const elapsed = position - entry.start;
      if (elapsed >= decoded.buffer.duration) continue;
      const source = this.context!.createBufferSource();
      source.buffer = decoded.buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.gain!);
      source.onended = () => {
        if (this.sources.get(entry.key) === source) this.sources.delete(entry.key);
        source.disconnect();
      };
      // Both tracks use the same epoch anchor, including after async window loads.
      source.start(clock + Math.max(0, entry.start - position) / this.rate, Math.max(0, elapsed));
      this.sources.set(entry.key, source);
    }
  }

  private armMaintenance() {
    if (this.timer !== null || !this.active || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active || this.disposed) return;
      if (this.position >= this.duration) { this.pause(); return; }
      void this.ensureWindow().then(() => {
        if (!this.active || this.disposed) return;
        this.scheduleAvailable();
        this.armMaintenance();
      }).catch(error => { this.pause(); this.onError?.(error); });
    }, 250);
  }

  pause() {
    this.offset = this.position;
    this.active = false;
    this.wantsPlayback = false;
    this.windowRevision++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const path of this.sources.keys()) this.stopSource(path);
  }

  async seek(seconds: number) {
    const resume = this.wantsPlayback;
    this.pause();
    this.wantsPlayback = resume;
    this.loading.abort();
    this.loading = new AbortController();
    this.offset = Math.max(0, Math.min(this.duration, seconds));
    const revision = this.windowRevision;
    await this.ensureWindow();
    if (resume && !this.disposed && revision === this.windowRevision) await this.play();
  }

  setSpeed(rate: number) {
    // While a seek is buffering, changing speed must not cancel its resume intent.
    if (!this.active) { this.rate = rate; return; }
    const resume = this.active;
    this.pause();
    this.wantsPlayback = resume;
    this.rate = rate;
    if (resume) {
      this.started = this.context!.currentTime;
      this.active = true;
      this.scheduleAvailable();
      this.armMaintenance();
    }
  }

  private stopSource(path: string) {
    const source = this.sources.get(path);
    if (!source) return;
    source.onended = null;
    source.stop();
    source.disconnect();
    this.sources.delete(path);
  }

  private abort = () => {
    this.loading.abort();
    this.pause();
  };

  dispose() {
    this.disposed = true;
    this.abort();
    this.signal?.removeEventListener('abort', this.abort);
    this.buffers.clear();
    this.headers.clear();
    this.entries = [];
    this.decoder = null;
    if (this.context) void this.context.close();
  }
}
