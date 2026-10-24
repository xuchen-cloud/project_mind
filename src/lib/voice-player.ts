import type { VoicePlaybackChunk } from './voice-types';

/** One audio clock schedules both sources and all pause/resume epochs. */
export class VoicePlayer {
  private context: AudioContext | null = null;
  private buffers: { start: number; buffer: AudioBuffer }[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private gainValue = 1;
  private offset = 0;
  private started = 0;
  private rate = 1;
  private active = false;
  duration = 0;

  async load(chunks: VoicePlaybackChunk[], url: (path: string) => string, signal: AbortSignal) {
    // Decoding saved audio must not open a physical output device while recording.
    const decoder = new OfflineAudioContext(2, 1, 48_000);
    const decoded = await Promise.all(chunks.map(async chunk => {
      const response = await fetch(url(chunk.path), { signal });
      if (!response.ok) throw new Error(`音频读取失败 (${response.status})`);
      const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
      return { chunk, buffer };
    }));
    if (signal.aborted) return;
    let offset = 0;
    let peak = 0;
    for (const epoch of [...new Set(chunks.map(chunk => chunk.epoch))].sort((a, b) => a - b)) {
      let duration = 0;
      for (const { chunk, buffer } of decoded.filter(item => item.chunk.epoch === epoch)) {
        this.buffers.push({ start: offset + chunk.startMs / 1000, buffer });
        duration = Math.max(duration, chunk.startMs / 1000 + buffer.duration);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          for (const value of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(value));
        }
      }
      offset += duration;
    }
    this.duration = offset;
    // Preserve quiet recordings while bounding the boost and two-source headroom.
    this.gainValue = peak > 0 ? Math.min(8, 0.45 / peak) : 1;
  }

  get position() {
    return Math.min(this.duration, this.offset + (this.active ? (this.context!.currentTime - this.started) * this.rate : 0));
  }

  async play() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.gainValue;
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
    this.schedule();
  }

  private schedule() {
    this.stopSources();
    this.started = this.context!.currentTime;
    this.active = true;
    for (const { start, buffer } of this.buffers) {
      const elapsed = this.offset - start;
      if (elapsed >= buffer.duration) continue;
      const source = this.context!.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.gain!);
      source.start(this.started + Math.max(0, -elapsed) / this.rate, Math.max(0, elapsed));
      this.sources.push(source);
    }
  }

  pause() {
    this.offset = this.position;
    this.active = false;
    this.stopSources();
  }

  seek(seconds: number) {
    this.offset = Math.max(0, Math.min(this.duration, seconds));
    if (this.active) this.schedule();
  }

  setSpeed(rate: number) {
    this.offset = this.position;
    this.rate = rate;
    if (this.active) this.schedule();
  }

  private stopSources() {
    for (const source of this.sources) { source.stop(); source.disconnect(); }
    this.sources = [];
  }

  dispose() {
    this.pause();
    if (this.context) void this.context.close();
  }
}
