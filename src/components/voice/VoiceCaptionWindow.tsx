import { ChevronDown, ChevronUp, Pause, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { VoiceSessionSnapshot, VoiceTranscriptSegment } from "../../lib/voice-types";
import { desktopApi } from "../../services/desktopApi";
import { voiceApi } from "../../services/voiceApi";
import { Button } from "../../ui/components";

function duration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceCaptionWindow() {
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [captions, setCaptions] = useState<VoiceTranscriptSegment[]>([]);
  const [interim, setInterim] = useState<string | null>(null);
  const [captionLines, setCaptionLines] = useState(4);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const sequence = useRef(0);
  const allowClose = useRef(false);
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
      setSession(next);
      setError(null);
      if (collapsed) {
        setCaptions([]);
        setInterim(null);
        return;
      }
      const partial = next.interimText?.trim() || null;
      setInterim(partial);
      const tail = await voiceApi.transcriptTail({
        sessionId: next.sessionId,
        limit: 40,
      });
      if (current === sequence.current) setCaptions(tail);
    } catch (cause) {
      if (current === sequence.current) setError(String(cause));
    }
  }, [captionLines, collapsed]);

  useEffect(() => {
    void voiceApi.settingsGet().then((settings) => setCaptionLines(settings.captionLines)).catch((cause) => setError(String(cause)));
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
      await refresh();
      if (next.phase === "ended") { allowClose.current = true; await desktopApi.captionWindowClose(); }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleCollapsed() {
    const next = !collapsed;
    try {
      await desktopApi.captionWindowSetSize(next ? 180 : 680, next ? 72 : Math.max(220, 64 + captionLines * 30));
      setCollapsed(next);
    } catch (cause) {
      setError(String(cause));
    }
  }

  const paused = session?.phase === "paused";
  return (
    <main aria-label="独立语音字幕浮窗" className={`voice-caption-shell ${collapsed ? "voice-caption-shell--collapsed" : ""}`}>
      <div className="voice-caption-header" data-tauri-drag-region>
        <div className="voice-caption-status" data-tauri-drag-region>
          <span className={`voice-caption-status-dot ${paused ? "voice-caption-status-dot--paused" : ""}`} aria-hidden="true" />
          <span>{paused ? "已暂停" : session ? "正在录音" : "实时字幕"}</span>
          {session ? <span className="voice-caption-clock">{duration(session.activeMs)}</span> : null}
        </div>
        <div className="voice-caption-header-actions">
          <Button size="sm" variant="secondary" aria-label={collapsed ? "展开字幕" : "折叠字幕"} onClick={() => void toggleCollapsed()} leadingIcon={collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />} />
          {!collapsed ? <Button size="sm" variant="secondary" aria-label="关闭浮窗" onClick={() => void toggleCollapsed()} leadingIcon={<X size={13} />} /> : null}
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
            ) : <p className="voice-caption-empty">{session ? "等待语音识别…" : "当前没有录音"}</p>}
          </div>
          {error ? <p role="alert" className="voice-caption-error" title={error}>{error}</p> : null}
          {session ? <div className="voice-caption-controls">
            <Button size="sm" disabled={busy} leadingIcon={paused ? <Play size={13} /> : <Pause size={13} />} onClick={() => void changeSession(() => paused
              ? voiceApi.resume({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() })
              : voiceApi.pause({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() }))}>{paused ? "继续" : "暂停"}</Button>
            <Button size="sm" variant="danger" disabled={busy} leadingIcon={<Square size={12} />} onClick={() => void changeSession(() => voiceApi.end({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: crypto.randomUUID() }))}>结束</Button>
          </div> : null}
        </>
      ) : null}
    </main>
  );
}
