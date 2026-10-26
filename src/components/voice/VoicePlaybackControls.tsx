import { Pause, Play } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { VoicePlayer } from '../../lib/voice-player';
import type { VoicePlaybackChunk } from '../../lib/voice-types';
import { desktopApi } from '../../services/desktopApi';
import { Button } from '../../ui/components';

export interface VoicePlaybackHandle { seek(milliseconds: number): void }
interface Props {
  sessionId: string;
  chunks: VoicePlaybackChunk[];
  visible: boolean;
  sourceTimeMs?: number | null;
  sourceNavigationKey?: string;
  onAvailability(ready: boolean, durationMs: number): void;
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Owns frame updates so playback never rerenders Transcript or speaker editors. */
export const VoicePlaybackControls = forwardRef<VoicePlaybackHandle, Props>(function VoicePlaybackControls(
  { sessionId, chunks, visible, sourceTimeMs, sourceNavigationKey, onAvailability }, ref,
) {
  const playerRef = useRef<VoicePlayer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<string | null>(null);
  const appliedSource = useRef<string | null>(null);
  const positionRef = useRef(0);
  const speedRef = useRef(1);
  const loadRevision = useRef(0);

  function reportError(prefix: string, cause: unknown) {
    const player = playerRef.current;
    if (player) {
      player.pause();
      positionRef.current = player.position * 1000;
      setPositionMs(positionRef.current);
    }
    setPlaying(false);
    setError(`${prefix}：${cause instanceof Error ? cause.message : String(cause)}`);
  }

  useEffect(() => {
    const abort = new AbortController();
    const player = new VoicePlayer(cause => reportError('音频播放失败', cause));
    abortRef.current = abort;
    playerRef.current = player;
    positionRef.current = 0;
    appliedSource.current = null;
    setPositionMs(0);
    setPlaying(false);
    setReady(false);
    setDurationMs(0);
    onAvailability(false, 0);
    setError(null);
    return () => {
      loadRevision.current++;
      abort.abort();
      player.dispose();
      playerRef.current = null;
    };
  }, [sessionId, onAvailability]);

  useEffect(() => {
    const player = playerRef.current;
    const abort = abortRef.current;
    if (!player || !abort) return;
    const revision = ++loadRevision.current;
    if (chunks.length === 0) {
      setDurationMs(0);
      setReady(false);
      onAvailability(false, 0);
      return;
    }
    void player.load(chunks, desktopApi.toFileUrl, abort.signal).then(() => {
      if (abort.signal.aborted || revision !== loadRevision.current) return;
      const duration = player.duration * 1000;
      setDurationMs(duration);
      setReady(duration > 0);
      onAvailability(duration > 0, duration);
    }).catch(cause => {
      if (!abort.signal.aborted && revision === loadRevision.current) reportError('音频加载失败', cause);
    });
  }, [chunks, sessionId, onAvailability]);

  function seek(milliseconds: number) {
    const player = playerRef.current;
    if (!player) return;
    positionRef.current = milliseconds;
    setPositionMs(milliseconds);
    void Promise.resolve(player.seek(milliseconds / 1000)).catch(cause => reportError('音频定位失败', cause));
  }
  useImperativeHandle(ref, () => ({ seek }));

  useEffect(() => {
    if (sourceTimeMs == null) { setSourceStatus(null); return; }
    if (!visible || !ready || !playerRef.current) return;
    const key = JSON.stringify([sessionId, sourceNavigationKey, sourceTimeMs]);
    if (appliedSource.current === key) return;
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0 || sourceTimeMs > durationMs) {
      setSourceStatus('来源时间点已超出当前录音范围，无法定位。');
      return;
    }
    appliedSource.current = key;
    playerRef.current.pause();
    setPlaying(false);
    seek(sourceTimeMs);
    setSourceStatus(`已定位录音来源 ${formatTime(sourceTimeMs)}。`);
  }, [visible, ready, durationMs, sessionId, sourceTimeMs, sourceNavigationKey]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const next = (playerRef.current?.position ?? 0) * 1000;
      positionRef.current = next;
      setPositionMs(next);
      if (next >= durationMs) {
        playerRef.current?.pause();
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, durationMs]);

  function toggle() {
    const player = playerRef.current;
    if (!player) return;
    if (playing) {
      player.pause();
      positionRef.current = player.position * 1000;
      setPositionMs(positionRef.current);
      setPlaying(false);
      return;
    }
    setError(null);
    if (positionRef.current >= durationMs) seek(0);
    player.setSpeed(speedRef.current);
    void player.play().then(started => {
      if (started !== false && playerRef.current === player && !abortRef.current?.signal.aborted) setPlaying(true);
    }).catch(cause => reportError('音频未能启动', cause));
  }

  return <>
    {durationMs > 0 ? <div className="flex items-center gap-3">
      <Button type="button" size="sm" variant="secondary" aria-label={playing ? '暂停录音' : '播放录音'}
        leadingIcon={playing ? <Pause size={14} /> : <Play size={14} />} onClick={toggle} disabled={!ready}>
        {playing ? '暂停' : '播放'}
      </Button>
      <span className="w-10 text-right font-mono text-caption tabular-nums text-text-muted">{formatTime(positionMs)}</span>
      <input className="min-w-24 flex-1 accent-[var(--color-accent)]" type="range" min={0} max={Math.max(1, durationMs)} step={100}
        value={Math.min(positionMs, durationMs)} aria-label="录音进度" onChange={event => seek(Number(event.target.value))} />
      <span className="w-10 font-mono text-caption tabular-nums text-text-muted">{formatTime(durationMs)}</span>
      <select className="h-7 rounded-[var(--radius-6)] border border-border bg-bg px-2 text-ui text-text" aria-label="播放倍速" value={speed}
        onChange={event => {
          const next = Number(event.target.value);
          speedRef.current = next;
          setSpeed(next);
          playerRef.current?.setSpeed(next);
        }}>
        {[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
      </select>
    </div> : <p className="text-body text-text-muted">暂停或结束录制后，这里会显示已保存的音频。</p>}
    {error ? <p role="alert" className="mt-2 text-caption text-danger">{error}</p> : null}
    {visible && sourceStatus ? <p role="status" className="mt-2 text-caption text-text-soft">{sourceStatus}</p> : null}
  </>;
});
