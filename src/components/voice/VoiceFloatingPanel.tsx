import { ExternalLink, LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { VoiceSessionSnapshot, VoiceTarget } from "../../lib/voice-types";
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

export function VoiceFloatingPanel({ onChanged, onOpenRecord }: VoiceFloatingPanelProps) {
  const { pushToast } = useFeedbackStore();
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const pollRef = useRef<ReturnType<typeof createVoiceLivePoll> | null>(null);
  const lastRefreshError = useRef<string | null>(null);

  const refresh = useCallback(() => pollRef.current?.refresh() ?? Promise.resolve(), []);

  useEffect(() => {
    let active = true;
    void voiceApi.availabilityGet().then(result => {
      if (!active || !result.implemented) return;
      setAvailable(true);
      pollRef.current = createVoiceLivePoll({
        role: "main",
        captions: () => false,
        onPacket({ session: next, error }) {
          if (!error) lastRefreshError.current = null;
          setSession(next?.phase === "ended" ? null : next);

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


  async function run(operation: () => Promise<VoiceSessionSnapshot>, successTitle?: string) {
    setPending(true);
    try {
      const next = await operation();
      pollRef.current?.changed(next);
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
          await onChanged();
          try {
            await desktopApi.openVoiceCaptionWindow();
          } catch (windowError) {
            pushToast({ tone: "error", title: "无法打开字幕浮窗", detail: String(windowError) });
          }
          return null;
        }
      }
      try {
        const snapshot = await voiceApi.snapshotGet();
        if (snapshot) { pollRef.current?.changed(snapshot); setSession(snapshot); }
      } catch (refreshError) { pushToast({ tone: "error", title: "语音状态读取失败", detail: String(refreshError) }); }
      pushToast({ tone: "error", title: "语音记录操作失败", detail: String(error) });
      return null;
    } finally {
      setPending(false);
    }
  }

  if (!available || !session || !["recording", "paused", "ending"].includes(session.phase)) return null;

  const paused = session.phase === "paused";
  const ending = session.phase === "ending";
  return (
    <section
      aria-label="语音录制控制"
      className="flex shrink-0 items-center justify-center gap-3 border-b border-border bg-bg px-4 py-1.5"
    >
      <Button size="sm" variant="ghost" onClick={() => onOpenRecord(session)}>{ending ? "打开录音记录" : "打开正在录制的记录"}</Button>
      {ending && session.pauseReason ? <p role="status" className="text-caption text-text-muted">{session.pauseReason}</p> : null}
      {session.activityWarning ? <p role="status" className="text-caption text-text-muted">{session.activityWarning}</p> : null}
      {!ending && session.liveTranscriptionDegraded ? <p role="status" className="text-caption text-text-muted">录音正常，文字稍后补齐</p> : null}
      {paused && session.pauseReason && session.pauseReason !== "user" ? <p role="status" className="text-caption text-text-muted">暂停原因：{session.pauseReason}</p> : null}
      <div className="flex items-center justify-center gap-2">
      <Button size="sm" variant="secondary" aria-label="打开录音浮窗" leadingIcon={<ExternalLink size={13} />}
        onClick={() => void desktopApi.openVoiceCaptionWindow().catch((error) => pushToast({ tone: "error", title: "无法打开字幕浮窗", detail: String(error) }))}>浮窗</Button>
      <span className="flex items-center gap-2 pr-1 text-ui font-medium text-text">
        <span className={ending || paused ? "h-2 w-2 rounded-full bg-warning" : "h-2 w-2 animate-pulse rounded-full bg-danger motion-reduce:animate-none"} />
        {ending ? "音频待保存" : paused ? "已暂停" : "录音中"}
        <span className="font-mono tabular-nums text-text-muted">{formatDuration(session.activeMs)}</span>
      </span>
      <Button
        size="sm"
        disabled={pending || ending}
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
        disabled={pending || ending}
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
