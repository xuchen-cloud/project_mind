import { ExternalLink, LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { VoiceSessionSnapshot, VoiceTarget, VoiceTranscriptSegment } from "../../lib/voice-types";
import { desktopApi } from "../../services/desktopApi";
import { voiceApi } from "../../services/voiceApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { createVoiceLivePoll } from "./voice-live-poll";
import { Button } from "../../ui/components";

interface VoiceFloatingPanelProps {
  target: VoiceTarget;
  targetLabel: string;
  onOpenRecord: (snapshot: VoiceSessionSnapshot) => void;
  onChanged: () => void | Promise<void>;
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":")
    : [minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function VoiceFloatingPanel({ onChanged }: VoiceFloatingPanelProps) {
  const { pushToast } = useFeedbackStore();
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [captions, setCaptions] = useState<VoiceTranscriptSegment[]>([]);
  const [interim, setInterim] = useState<string | null>(null);
  const [captionLines, setCaptionLines] = useState(4);
  const [recognitionEnabled, setRecognitionEnabled] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof createVoiceLivePoll> | null>(null);
  const captionConfig = useRef({ captionLines, recognitionEnabled });
  captionConfig.current = { captionLines, recognitionEnabled };
  const lastRefreshError = useRef<string | null>(null);

  const refresh = useCallback(() => pollRef.current?.refresh() ?? Promise.resolve(), []);

  useEffect(() => {
    void voiceApi.settingsGet().then((settings) => {
      setCaptionLines(Math.min(8, Math.max(2, settings.captionLines)));
      setRecognitionEnabled(Boolean(settings.speechProfile));
    }).catch(error => pushToastRef.current({ tone: "error", title: "语音设置读取失败", detail: String(error) }));
  }, []);

  useEffect(() => {
    let active = true;
    void voiceApi.availabilityGet().then(result => {
      if (!active || !result.implemented) return;
      setAvailable(true);
      pollRef.current = createVoiceLivePoll({
        role: "main",
        captions: () => !!captionConfig.current.recognitionEnabled,
        onPacket({ session: next, captions: latest, error }) {
          if (!error) lastRefreshError.current = null;
          setSession(next?.phase === "ended" ? null : next);
          if (next && captionConfig.current.recognitionEnabled && document.visibilityState !== "hidden") {
            const partial = next.interimText?.trim() || null;
            setInterim(partial);
            const visibleCount = Math.min(8, Math.max(2, captionConfig.current.captionLines)) - (partial ? 1 : 0);
            if (latest) setCaptions(latest.slice(-visibleCount));
          } else { setCaptions([]); setInterim(null); }
        },
        onError(error) {
          const detail = String(error);
          if (detail === lastRefreshError.current) return;
          lastRefreshError.current = detail;
          pushToastRef.current({ tone: "error", title: "语音记录状态或字幕更新失败", detail });
        },
      });
    }).catch(error => {
      if (active) pushToastRef.current({ tone: "error", title: "语音记录状态读取失败", detail: String(error) });
    });
    return () => {
      active = false;
      pollRef.current?.stop();
      pollRef.current = null;
    };
  }, [refresh]);

  useEffect(() => { pollRef.current?.configure(); }, [captionLines, recognitionEnabled]);

  async function run(operation: () => Promise<VoiceSessionSnapshot>, successTitle?: string) {
    setPending(true);
    try {
      const next = await operation();
      pollRef.current?.changed(next);
      if (next.sessionId !== session?.sessionId || next.phase === "ended") { setCaptions([]); setInterim(null); }
      setSession(next.phase === "ended" ? null : next);
      if (next.phase === "ended") {
        try {
          await desktopApi.closeVoiceCaptionWindow();
        } catch (windowError) {
          pushToast({ tone: "error", title: "浮窗关闭失败", detail: String(windowError) });
        }
      }
      await onChanged();
      if (next.phase === "recording") {
        try {
          await desktopApi.openVoiceCaptionWindow();
        } catch (error) {
          pushToast({ tone: "error", title: "无法打开字幕浮窗", detail: String(error) });
        }
      }
      if (successTitle) pushToast({ tone: "success", title: successTitle });
      return next;
    } catch (error) {
      if (String(error).includes("another recording session already owns audio capture")) {
        const existing = await voiceApi.snapshotGet().catch(() => null);
        if (existing) {
          setSession(existing);
          setCaptions([]);
          setInterim(null);
          await onChanged();
          try {
            await desktopApi.openVoiceCaptionWindow();
          } catch (windowError) {
            pushToast({ tone: "error", title: "无法打开字幕浮窗", detail: String(windowError) });
          }
          return null;
        }
      }
      pushToast({ tone: "error", title: "语音记录操作失败", detail: String(error) });
      return null;
    } finally {
      setPending(false);
    }
  }

  if (!available || !session) return null;

  const paused = session.phase === "paused";
  return (
    <section
      aria-label="语音录制控制"
      className="fixed bottom-9 left-1/2 z-50 flex w-[min(80vw,680px)] -translate-x-1/2 flex-col gap-2 rounded-[var(--radius-10)] border border-border-strong bg-bg/95 px-3 py-2 shadow-xl backdrop-blur"
    >
      {captions.length > 0 || interim ? (
        <ol aria-label="实时字幕" aria-live="polite" className="w-full space-y-1 text-body text-text">
          {captions.map((caption) => <li key={caption.id}>{caption.text}</li>)}
          {interim ? <li className="text-text-muted" aria-label="临时字幕">{interim}</li> : null}
        </ol>
      ) : null}
      {session.recognitionError ? <p role="alert" className="text-caption text-danger">实时转写已中断，录音继续保存。{session.recognitionError}</p> : null}
      {paused && session.pauseReason && session.pauseReason !== "user" ? <p role="status" className="text-caption text-text-muted">暂停原因：{session.pauseReason}</p> : null}
      <div className="flex w-full items-center justify-center gap-2">
      <Button size="sm" variant="secondary" aria-label={recognitionEnabled ? "打开字幕浮窗" : "打开录音浮窗"} leadingIcon={<ExternalLink size={13} />}
        onClick={() => void desktopApi.openVoiceCaptionWindow().catch((error) => pushToast({ tone: "error", title: "无法打开字幕浮窗", detail: String(error) }))}>浮窗</Button>
      <span className="flex items-center gap-2 pr-1 text-ui font-medium text-text">
        <span className={paused ? "h-2 w-2 rounded-full bg-warning" : "h-2 w-2 animate-pulse rounded-full bg-danger motion-reduce:animate-none"} />
        {paused ? "已暂停" : "录音中"}
        <span className="font-mono tabular-nums text-text-muted">{formatDuration(session.activeMs)}</span>
      </span>
      <Button
        size="sm"
        disabled={pending}
        leadingIcon={pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={13} /> : paused ? <Play size={13} /> : <Pause size={13} />}
        onClick={() => void run(() => paused
          ? voiceApi.resume({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: requestId() })
          : voiceApi.pause({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: requestId() }))}
      >
        {paused ? "继续" : "暂停"}
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        leadingIcon={<Square size={12} />}
        onClick={() => void run(
          () => voiceApi.end({ sessionId: session.sessionId, expectedRevision: session.revision, requestId: requestId() }),
          "语音记录已保存",
        )}
      >
        结束
      </Button>
      </div>
    </section>
  );
}
