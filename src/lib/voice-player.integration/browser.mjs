import { VoicePlayer } from '/voice-player.js';

const check = (condition, description) => { if (!condition) throw Error(description); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = path => `/asset/${encodeURIComponent(path)}`;
const decodeCalls = [], starts = [], contexts = [], peaks = [];
let activeDecodes = 0, maxDecodes = 0;
// These are forwarding observers of real browser objects, not AudioBuffer or
// AudioContext substitutes. Output is measured before a real zero-gain node so
// the acceptance run does not play tones through the user's speakers.
const decode = OfflineAudioContext.prototype.decodeAudioData;
OfflineAudioContext.prototype.decodeAudioData = async function(bytes) {
  activeDecodes++; maxDecodes = Math.max(maxDecodes, activeDecodes);
  try {
    const buffer = await decode.call(this, bytes);
    decodeCalls.push({ duration: buffer.duration, rate: buffer.sampleRate, channels: buffer.numberOfChannels,
      firstSample: buffer.getChannelData(0)[1], length: buffer.length });
    check(buffer instanceof AudioBuffer, 'decoder returned a real AudioBuffer');
    return buffer;
  } finally { activeDecodes--; }
};
const createGain = AudioContext.prototype.createGain;
AudioContext.prototype.createGain = function() {
  const gain = createGain.call(this), connect = gain.connect;
  const analyser = this.createAnalyser(); analyser.fftSize = 1024;
  const mute = createGain.call(this); mute.gain.value = 0;
  analyser.connect(mute); mute.connect(this.destination);
  gain.connect = function(destination, ...args) {
    if (destination === this.context.destination) return connect.call(this, analyser, ...args);
    return connect.call(this, destination, ...args);
  };
  contexts.push({ context: this, analyser });
  return gain;
};
const createSource = AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource = function() {
  const node = createSource.call(this), start = node.start;
  node.start = function(...args) {
    starts.push({ args, rate: this.playbackRate.value, duration: this.buffer.duration, contextTime: this.context.currentTime });
    return start.apply(this, args);
  };
  return node;
};
const chunk = (file, source, startMs = 0) => ({ path: file.path, epoch: 1, source, startMs, durationMs: file.seconds * 1000 });
let rolling, rollingChunks, longPlayer, files;
let state = {};
window.voiceIntegration = {
  playFinished: null,
  async prepare(input, privatePath) {
    files = input;
    const path = files['legacy-mic.wav'].path;
    const header = await fetch(endpoint(path), { headers: { Range: 'bytes=0-43' } });
    check(header.status === 206, 'real asset handler returns 206');
    check(header.headers.get('Content-Range') === `bytes 0-43/${files['legacy-mic.wav'].bytes}`, 'exact real header Content-Range');
    const bytes = await header.arrayBuffer();
    check(bytes.byteLength === 44 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF', 'real original WAV header');
    const capped = await fetch(endpoint(path), { headers: { Range: 'bytes=44-2097195' } });
    check(capped.status === 206 && capped.headers.get('Content-Range') === `bytes 44-1024043/${files['legacy-mic.wav'].bytes}`, 'actual Tauri 1000 KiB cap');
    check((await capped.arrayBuffer()).byteLength === 1000 * 1024, 'actual capped body length');
    const denied = await fetch(endpoint(privatePath), { headers: { Range: 'bytes=0-3' } });
    check(denied.status === 403, 'actual Scope rejects an unauthorized file');
    const invalid = await fetch(endpoint(path), { headers: { Range: `bytes=${files['legacy-mic.wav'].bytes}-` } });
    check(invalid.status === 416, 'actual handler rejects an unsatisfiable Range');
    const errors = [];
    longPlayer = new VoicePlayer(error => errors.push(String(error)));
    const legacy = [chunk(files['legacy-mic.wav'], 'microphone'), chunk(files['legacy-system.wav'], 'system')];
    let before = decodeCalls.length;
    await longPlayer.load(legacy, endpoint, new AbortController().signal);
    check(longPlayer.duration === 3600, 'one-hour dual original timeline');
    check(decodeCalls.length - before === 4, 'first window decodes exactly four actual buffers');
    before = decodeCalls.length;
    await longPlayer.seek(3015);
    check(decodeCalls.length - before === 4 && longPlayer.position === 3015, 'long seek loads only its target window');
    check(longPlayer.resourceUsage.bufferBytes === 46_080_000, 'real mono buffers use 46,080,000 bytes');
    check(decodeCalls.every(row => row.duration === 60 && row.rate === 48_000 && row.channels === 1 && Math.abs(row.firstSample) > 0), 'real 60s float WAV windows decode with source samples');
    state.legacy = { decodes: decodeCalls.length, position: longPlayer.position, usage: longPlayer.resourceUsage };
    // Keep the legacy player for real play/seek under the next user gesture.
    rolling = new VoicePlayer(error => errors.push(String(error)));
    rollingChunks = [chunk(files['mic-0.wav'], 'microphone'), chunk(files['system-0.wav'], 'system')];
    await rolling.load(rollingChunks, endpoint, new AbortController().signal);
    rolling.setSpeed(1.5);
    state.errors = errors;
    return { range: { header: header.status, capped: capped.status, denied: denied.status, unsatisfiable: invalid.status }, legacy: state.legacy,
      actualDecodeCount: decodeCalls.length, maxDecodeConcurrency: maxDecodes };
  },
};
document.querySelector('#play').onclick = async () => {
  try {
    let before = starts.length;
    await longPlayer.play();
    const longStarts = starts.slice(before);
    check(longStarts.length === 4, 'real long playback schedules current and next original track pairs');
    check(longStarts[0].args[0] === longStarts[1].args[0] && longStarts[0].args[1] === longStarts[1].args[1] && longStarts[0].args[1] >= 15 && longStarts[0].args[1] < 15.1, 'both original tracks start on one clock at offset 15');
    await sleep(120);
    check(longPlayer.position > 3015, 'real AudioContext advances the long recording clock');
    await longPlayer.seek(3025);
    check(longPlayer.position >= 3025, 'playing seek restores real AudioContext playback');
    longPlayer.dispose();
    before = starts.length;
    await rolling.play();
    await sleep(120);
    const initial = starts.slice(before), positionBefore = rolling.position, decodesBefore = decodeCalls.length;
    check(initial.length === 2 && positionBefore > 0, 'two real original tracks playing before append');
    const context = contexts.at(-1).context;
    rollingChunks.push(chunk(files['mic-1.wav'], 'microphone', 2000), chunk(files['system-1.wav'], 'system', 2000));
    await rolling.load(rollingChunks, endpoint, new AbortController().signal);
    check(rolling.position >= positionBefore && rolling.duration === 4, 'append preserves running position');
    check(decodeCalls.length - decodesBefore === 2, 'append decodes only two new files');
    const rollingStarts = starts.slice(before);
    check(rollingStarts.length === 4 && rollingStarts.every(row => row.rate === 1.5), 'append preserves speed without restarting old nodes');
    check(rollingStarts[2].args[0] === rollingStarts[3].args[0], 'appended source pair uses the same clock');
    check(Math.abs((rollingStarts[2].args[0] - rollingStarts[0].args[0]) - (2 - rollingStarts[0].args[1]) / 1.5) < 0.0001, 'new chunks scheduled at exact speed-adjusted boundary');
    // Sample actual rendered audio on both sides of the first chunk boundary.
    const { analyser } = contexts.at(-1), samples = new Float32Array(analyser.fftSize);
    while (rolling.position < 2.6) {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      peaks.push({ position: rolling.position, rms });
      await sleep(25);
    }
    const boundary = peaks.filter(row => row.position >= 1.75 && row.position <= 2.25);
    check(boundary.length >= 5 && boundary.every(row => row.rms > 0.005), 'real rendered audio is non-silent continuously across appended chunk boundary');
    const advanced = rolling.position;
    await rolling.seek(2.5);
    await sleep(100);
    check(rolling.position > 2.5, 'real rolling playback resumes after seek');
    const usage = rolling.resourceUsage;
    rolling.dispose();
    check(rolling.resourceUsage.bufferCount === 0 && rolling.resourceUsage.activeSources === 0, 'dispose releases buffers and source nodes');
    check(state.errors.length === 0 && activeDecodes === 0 && maxDecodes <= 2, 'no playback errors or excess decoder concurrency');
    window.voiceIntegration.playFinished = { status: 'passed', legacy: state.legacy, longStarts, rollingStarts,
      actualDecodeCount: decodeCalls.length, maxDecodeConcurrency: maxDecodes, appendedDecodeCount: decodeCalls.length - decodesBefore,
      boundarySamples: boundary, contextStateBeforeDispose: context.state, advancedPosition: advanced, rollingUsage: usage, disposed: rolling.resourceUsage };
  } catch (error) {
    longPlayer?.dispose(); rolling?.dispose();
    window.voiceIntegration.playFinished = { status: 'failed', error: String(error), stack: error.stack, starts, decodeCalls, peaks, state };
  }
};
