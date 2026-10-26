import { desktopApi } from '../../services/desktopApi';
import type { VoiceSessionSnapshot, VoiceTranscriptSegment } from '../../lib/voice-types';
import { voiceApi } from '../../services/voiceApi';

const EVENT = 'voice:live-state';
const ACTIVE_MS = 1000;
const IDLE_MS = 5000;
const OWNER_GRACE_MS = 2000;
const BUSY_LEASE_MS = 30_000;
const PEER_LEASE_MS = 15_000;

export interface VoiceLivePacket {
  session: VoiceSessionSnapshot | null;
  captions: VoiceTranscriptSegment[] | null;
  error?: string;
}
type Message = {
  origin: string;
  type: 'state' | 'interest' | 'changed' | 'busy' | 'gone';
  leaseMs?: number;
  packet?: VoiceLivePacket;
  error?: string;
  visible?: boolean;
  captions?: boolean;
  force?: boolean;
  departed?: boolean;
};

/** The main window reads; the caption window consumes its publications and
 * takes over only when they stop. Each reader has one in-flight refresh. */
export function createVoiceLivePoll(options: {
  role: 'main' | 'caption';
  captions(): boolean;
  onPacket(packet: VoiceLivePacket): void;
  onError(error: unknown): void;
}) {
  const origin = crypto.randomUUID();
  const hostDocument = document;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: Promise<void> | null = null;
  let queued = false;
  let generation = 0;
  let ownerDeadline = 0;
  let lastInterest = 0;
  let initialized = false;
  let peer = { present: false, visible: false, captions: false, seen: 0 };
  let latest: VoiceLivePacket = { session: null, captions: null };
  const visible = () => hostDocument.visibilityState !== 'hidden';
  const peerVisible = () => peer.visible && Date.now() - peer.seen < PEER_LEASE_MS;
  const ownerRecent = () => Date.now() < ownerDeadline;
  const recording = () => ['recording', 'paused'].includes(latest.session?.phase ?? '');
  const send = (message: Omit<Message, 'origin'>) => {
    void desktopApi.emitEvent(EVENT, { ...message, origin }).catch(error => { if (!stopped) options.onError(error); });
  };
  const cadence = () => recording()
    && (visible() || (options.role === 'main' && peerVisible())) ? ACTIVE_MS : IDLE_MS;
  const arm = () => {
    clearTimeout(timer);
    if (stopped) return;
    const delay = options.role === 'caption' && ownerRecent()
      ? ownerDeadline - Date.now() : cadence();
    timer = setTimeout(() => { void read(); }, delay);
  };
  const accept = (packet: VoiceLivePacket) => {
    initialized = true;
    latest = packet;
    options.onPacket(packet);
  };
  const read = (force = false): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (options.role === 'caption' && ownerRecent()) { arm(); return Promise.resolve(); }
    if (pending) { queued ||= force; return pending; }
    clearTimeout(timer);
    const current = generation;
    // Ordinary fast reads send only their result. One delayed busy receipt
    // protects a slow native call without a periodic heartbeat.
    if (options.role === 'main') busyNoticeTimer = setTimeout(() => {
      if (peer.present) send({ type: 'busy', leaseMs: BUSY_LEASE_MS });
    }, ACTIVE_MS);
    pending = (async () => {
      try {
        const session = await voiceApi.snapshotGet();
        if (stopped || current !== generation) return;
        const wantsCaptions = (visible() && options.captions())
          || (options.role === 'main' && peerVisible() && peer.captions);
        let captions: VoiceTranscriptSegment[] | null = null;
        let captionError: unknown;
        if (session && session.phase !== 'ended' && wantsCaptions) {
          try { captions = await voiceApi.transcriptTail({ sessionId: session.sessionId, limit: 8 }); }
          catch (error) { captionError = error; }
        }
        if (stopped || current !== generation) return;
        const packet = { session, captions, ...(captionError ? { error: String(captionError) } : {}) };
        accept(packet);
        if (options.role === 'main' && peer.present) send({ type: 'state', leaseMs: cadence() + OWNER_GRACE_MS, packet, ...(captionError ? { error: String(captionError) } : {}) });
        if (captionError) options.onError(captionError);
      } catch (error) {
        if (stopped || current !== generation) return;
        options.onError(error);
        if (options.role === 'main' && peer.present) send({ type: 'state', leaseMs: cadence() + OWNER_GRACE_MS, error: String(error) });
      }
    })().finally(() => {
      clearTimeout(busyNoticeTimer);
      pending = null;
      if (stopped) return;
      if (queued) { queued = false; void read(); } else arm();
    });
    return pending;
  };
  const interest = (force = false) => {
    lastInterest = Date.now();
    send({ type: 'interest', visible: visible(), captions: options.captions(), force });
  };
  const refresh = () => {
    if (options.role === 'caption') {
      interest(true);
      if (ownerRecent()) return Promise.resolve();
    }
    return read(true);
  };
  const onVisibility = () => {
    if (visible()) void refresh();
    else { if (options.role === 'caption') interest(); arm(); }
  };
  hostDocument.addEventListener('visibilitychange', onVisibility);
  void desktopApi.listenEvent<Message>(EVENT, message => {
    if (stopped || message.origin === origin) return;
    if (message.type === 'interest' && options.role === 'main') {
      const changed = peer.visible !== message.visible || peer.captions !== message.captions;
      peer = { present: !message.departed, visible: !!message.visible, captions: !!message.captions, seen: Date.now() };
      if (message.force) void read(true);
      else if (changed && peer.visible) {
        if (pending) send({ type: 'busy', leaseMs: BUSY_LEASE_MS });
        else if (initialized && !recording()) send({ type: 'state', packet: latest, leaseMs: cadence() + OWNER_GRACE_MS });
        else void read();
      }
      else if (changed) arm();
    } else if (message.type === 'busy' && options.role === 'caption') {
      ownerDeadline = Date.now() + (message.leaseMs ?? BUSY_LEASE_MS);
      arm();
    } else if (message.type === 'state' && options.role === 'caption') {
      ownerDeadline = Date.now() + (message.leaseMs ?? IDLE_MS + OWNER_GRACE_MS);
      // A fallback read that began before a main-window publication cannot
      // overwrite it when the delayed native response arrives.
      generation++;
      if (message.packet) accept(message.packet);
      if (message.error) options.onError(message.error);
      // Renew visible recording interest on useful publications, never on an
      // independent idle heartbeat. A crashed caption expires after 15 seconds.
      if (recording() && visible() && Date.now() - lastInterest >= IDLE_MS) interest();
      arm();
    } else if (message.type === 'gone' && options.role === 'caption') {
      ownerDeadline = 0;
      if (recording()) void read(); else arm();
    } else if (message.type === 'changed' && message.packet) {
      generation++;
      accept(message.packet);
      if (options.role === 'main') void read(true); else arm();
    }
  }).then(stop => { if (stopped) stop(); else unsubscribe = stop; }).catch(error => { if (!stopped) options.onError(error); });
  if (options.role === 'caption') interest();
  void read();
  return {
    refresh,
    configure() {
      if (options.role === 'caption') {
        interest();
        if (ownerRecent()) return;
      }
      // Snapshot reads consult the latest configuration after the await.
      // A render/configuration effect must not enqueue another initial read.
      if (!pending && (!initialized || recording())) void read();
    },
    changed(session: VoiceSessionSnapshot) {
      generation++;
      const packet = { session: session.phase === 'ended' ? null : session, captions: null };
      accept(packet);
      send({ type: 'changed', packet });
      if (session.phase !== 'ended' && options.role === 'main') void read(true); else arm();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearTimeout(timer);
      clearTimeout(busyNoticeTimer);
      hostDocument.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.();
      if (options.role === 'caption') send({ type: 'interest', visible: false, captions: false, departed: true });
      else send({ type: 'gone' });
    },
  };
}
