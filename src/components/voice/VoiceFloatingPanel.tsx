import { LoaderCircle, Mic, Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { VoiceSessionSnapshot, VoiceTarget } from "../../lib/voice-types";
import { voiceApi } from "../../services/voiceApi";
import { useFeedbackStore } from "../../state/feedback-store";
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

export function VoiceFloatingPanel({ target, targetLabel, onOpenRecord, onChanged }: VoiceFloatingPanelProps) {
  const { pushToast } = useFeedbackStore();
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await voiceApi.snapshotGet());
    } catch {
      // Workspace changes briefly make the snapshot unavailable.
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    void Promise.resolve()
      .then(() => voiceApi.availabilityGet())
      .then((result) => {
        if (!active || !result.implemented) return;
        setAvailable(true);
        void refresh();
        timer = window.setInterval(() => void refresh(), 1_000);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh]);

  async function run(operation: () => Promise<VoiceSessionSnapshot>, successTitle?: string) {
    setPending(true);
    try {
      const next = await operation();
      setSession(next.phase === "ended" ? null : next);
      await onChanged();
      if (successTitle) pushToast({ tone: "success", title: successTitle });
      return next;
    } catch (error) {
      pushToast({ tone: "error", title: "语音记录操作失败", detail: String(error) });
      return null;
    } finally {
      setPending(false);
    }
  }

  if (!available) return null;

  if (!session) {
    return (
      <div className="fixed bottom-9 right-4 z-40">
        <Button
          variant="primary"
          leadingIcon={pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} /> : <Mic size={14} />}
          disabled={pending}
          onClick={() => void run(
            () => voiceApi.start({ target, requestId: requestId() }),
            `已开始录制到${targetLabel}`,
          ).then((next) => next && onOpenRecord(next))}
        >
          开始语音记录
        </Button>
      </div>
    );
  }

  const paused = session.phase === "paused";
  return (
    <section
      aria-label="语音录制控制"
      className="fixed bottom-9 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-[var(--radius-10)] border border-border-strong bg-bg/95 px-3 py-2 shadow-xl backdrop-blur"
    >
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
    </section>
  );
}
