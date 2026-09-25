import { ChevronDown, ChevronUp, Pause, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { VoiceSessionSnapshot, VoiceTranscriptSegment } from "../../lib/voice-types";
import { desktopApi } from "../../services/desktopApi";
import { voiceApi } from "../../services/voiceApi";
import { Button, IconButton } from "../../ui/components";

function duration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceCaptionWindow() {
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [captions, setCaptions] = useState<VoiceTranscriptSegment[]>([]);
  const [interim, setInterim] = useState<string | null>(null);
  const [captionLines, setCaptionLines] = useState(4);
  const [recognitionEnabled, setRecognitionEnabled] = useState<boolean | null>(() =>
    new URLSearchParams(window.location.search).get("audioOnly") === "1" ? false : null);
  const [collapsed, setCollapsed] = useState(() =>
    new URLSearchParams(window.location.search).get("audioOnly") === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const sequence = useRef(0);
  const allowClose = useRef(false);
  const hasSeenSession = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const latestCaptionId = captions[captions.length - 1]?.id;

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await voiceApi.snapshotGet();
      if (current !== sequence.current) return;
      if (!next || next.phase === "ended") {
        allowClose.current = true;
        await desktopApi.captionWindowClose();
        return;
      }
      hasSeenSession.current = true;
      setSession(next);
      setError(null);
      if (collapsed || !recognitionEnabled) {
        setCaptions([]);
        setInterim(null);
        return;
      }
      const partial = next.interimText?.trim() || null;
      setInterim(partial);
      const tail = await voiceApi.transcriptTail({
        sessionId: next.sessionId,
        limit: Math.min(8, Math.max(2, captionLines)),
      });
      if (current === sequence.current) setCaptions(tail);
    } catch (cause) {
      if (current !== sequence.current) return;
      if (!hasSeenSession.current) {
        allowClose.current = true;
        await desktopApi.captionWindowClose().catch(() => undefined);
      } else {
        setError(String(cause));
      }
    }
  }, [captionLines, collapsed, recognitionEnabled]);

  useEffect(() => {
    void voiceApi.settingsGet().then((settings) => {
      setCaptionLines(Math.min(8, Math.max(2, settings.captionLines)));
      const enabled = Boolean(settings.speechProfile);
      setRecognitionEnabled(enabled);
      if (!enabled) {
        void desktopApi.captionWindowSetSize(160, 48)
          .then(() => setCollapsed(true))
          .catch((cause) => setError(String(cause)));
      }
    }).catch((cause) => setError(String(cause)));
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => { window.clearInterval(timer); sequence.current += 1; };
  }, [refresh]);

  useLayoutEffect(() => {
    if (!collapsed && scrollRef.current) {
      setOverflowing(scrollRef.current.scrollHeight > scrollRef.current.clientHeight);
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [latestCaptionId, interim, collapsed]);

  useEffect(() => {
    let disposed = false;
    const unlisten = desktopApi.captionWindowOnCloseRequested(() => {
      if (allowClose.current) return true;
      if (!collapsed) void toggleCollapsed();
      return false;
    });
    void unlisten.then((stop) => { if (disposed) stop(); });
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, [collapsed]);

  async function changeSession(operation: () => Promise<VoiceSessionSnapshot>) {
    setBusy(true);
    try {
      const next = await operation();
      setSession(next.phase === "ended" ? null : next);
      setError(null);
      if (next.phase === "ended") {
        allowClose.current = true;
        await desktopApi.captionWindowClose();
        return;
      }
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCollapsed() {
    if (recognitionEnabled === false) return;
    const next = !collapsed;
    try {
      await desktopApi.captionWindowSetSize(next ? 190 : 680, next ? 48 : Math.max(220, 64 + captionLines * 30));
      setCollapsed(next);
    } catch (cause) {
      setError(String(cause));
    }
  }

  const paused = session?.phase === "paused";
  const togglePause = () => {
    if (!session) return;
    void changeSession(() => paused
      ? voiceApi.resume({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() })
      : voiceApi.pause({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() }));
  };
  const endSession = () => {
    if (!session) return;
    void changeSession(() => voiceApi.end({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() }));
  };
  return (
    <main aria-label="语音记录浮窗" className={`voice-caption-shell ${collapsed ? "voice-caption-shell--collapsed" : ""}`}>
      <div className="voice-caption-header" data-tauri-drag-region>
        <div className="voice-caption-status" data-tauri-drag-region>
          <span className={`voice-caption-status-dot ${paused ? "voice-caption-status-dot--paused" : ""}`} role={collapsed ? "img" : undefined} aria-label={collapsed ? (paused ? "已暂停" : "正在录音") : undefined} aria-hidden={collapsed ? undefined : true} />
          {!collapsed ? <span>{paused ? "已暂停" : session ? "正在录音" : ""}</span> : null}
          {session ? <span className="voice-caption-clock" aria-label="录音时间">{duration(session.activeMs)}</span> : null}
        </div>
        <div className="voice-caption-header-actions">
          {collapsed && session ? <>
            <IconButton size="sm" className="voice-caption-icon-button" disabled={busy} aria-label={paused ? "开始录音" : "暂停录音"} title={paused ? "开始录音" : "暂停录音"} onClick={togglePause}>{paused ? <Play size={14} /> : <Pause size={14} />}</IconButton>
            <IconButton size="sm" variant="danger" className="voice-caption-icon-button" disabled={busy} aria-label="结束录音" title="结束录音" onClick={endSession}><Square size={13} /></IconButton>
          </> : null}
          {recognitionEnabled ? (collapsed
            ? <IconButton size="sm" className="voice-caption-icon-button" aria-label="展开字幕" title="展开字幕" onClick={() => void toggleCollapsed()}><ChevronUp size={14} /></IconButton>
            : <Button size="sm" variant="secondary" aria-label="折叠字幕" onClick={() => void toggleCollapsed()} leadingIcon={<ChevronDown size={13} />} />) : null}
          {recognitionEnabled && !collapsed ? <Button size="sm" variant="secondary" aria-label="关闭浮窗" onClick={() => void toggleCollapsed()} leadingIcon={<X size={13} />} /> : null}
        </div>
      </div>
      {!collapsed ? (
        <>
          <div ref={scrollRef} className={`voice-caption-scroll ${overflowing ? "voice-caption-scroll--overflow" : ""}`}>
            {captions.length || interim ? (
              <ol aria-label="实时字幕" aria-live="polite" className="voice-caption-lines">
                {captions.map((caption) => <li className="voice-caption-line" key={caption.id}>{caption.text}</li>)}
                {interim ? <li aria-label="临时字幕" className="voice-caption-interim">{interim}</li> : null}
              </ol>
            ) : <p className="voice-caption-empty">{session ? (recognitionEnabled ? "等待语音识别…" : "仅录音模式，不生成字幕和转写") : "当前没有录音"}</p>}
          </div>
          {error ? <p role="alert" className="voice-caption-error" title={error}>{error}</p> : null}
          {session ? <div className="voice-caption-controls">
            <Button size="sm" disabled={busy} aria-label={paused ? "开始录音" : "暂停录音"} leadingIcon={paused ? <Play size={13} /> : <Pause size={13} />} onClick={togglePause}>{paused ? "开始" : "暂停"}</Button>
            <Button size="sm" variant="danger" disabled={busy} aria-label="结束录音" leadingIcon={<Square size={12} />} onClick={endSession}>结束</Button>
          </div> : null}
        </>
      ) : null}
    </main>
  );
}
