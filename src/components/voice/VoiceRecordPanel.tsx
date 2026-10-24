import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { VoiceRecordLookup, VoiceTranscriptCursor } from "../../lib/voice-types";
import { queryKeys } from "../../lib/queryKeys";
import { desktopApi } from "../../services/desktopApi";
import { voiceApi } from "../../services/voiceApi";
import { Button } from "../../ui/components";
import { VoicePlayer } from "../../lib/voice-player";

export interface VoiceRecordPanelProps {
  target: VoiceRecordLookup;
  visible?: boolean;
  sourceTimeMs?: number | null;
  sourceNavigationKey?: string;
  onMinutesCommitted?: () => void;
  onCopyMinutes?: (content: string) => Promise<void>;
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceRecordPanel({ target, visible = true, sourceTimeMs, sourceNavigationKey, onMinutesCommitted, onCopyMinutes }: VoiceRecordPanelProps) {
  const queryClient = useQueryClient();
  const playbackQuery = useQuery({
    queryKey: ["voice-playback", target],
    queryFn: () => voiceApi.playbackGet(target),
    enabled: visible,
    refetchInterval: (query) => visible && ["recording", "paused"].includes(query.state.data?.phase ?? "") ? 1_000 : false,
    retry: false,
  });
  const previousPlayback = useRef(playbackQuery.data);
  useEffect(() => {
    const previous = previousPlayback.current;
    const current = playbackQuery.data;
    previousPlayback.current = current;
    if (current?.phase === "ended" && previous?.sessionId === current.sessionId
      && ["recording", "paused"].includes(previous.phase)) {
      void queryClient.invalidateQueries({ queryKey: ["voice-transcript", target] });
    }
  }, [playbackQuery.data, queryClient, target]);
  const [loadedDuration, setLoadedDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const totalMs = loadedDuration;
  const playerRef = useRef<VoicePlayer | null>(null);
  const positionRef = useRef(0);
  const speedRef = useRef(1);
  const [positionMs, setPositionMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [sourceSeekStatus, setSourceSeekStatus] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [generatingMinutes, setGeneratingMinutes] = useState(false);
  const [copyingMinutes, setCopyingMinutes] = useState(false);
  const lastMinutesVersion = useRef<number | null>(null);
  const lastCommittedMinutes = useRef<{ sessionId: string; version: number } | null>(null);
  const minutesQuery = useQuery({
    queryKey: ["voice-minutes", target],
    queryFn: () => voiceApi.minutesGet(target),
    enabled: visible,
    refetchInterval: (query) => !visible ? false : ["pending", "running"].includes(query.state.data?.status ?? "") ? 500 : 5_000,
    retry: false,
  });
  const minutesBusy = generatingMinutes || ["pending", "running"].includes(minutesQuery.data?.status ?? "");
  const displayedMinutes = minutesQuery.data?.status === "running" && minutesQuery.data.preview
    ? minutesQuery.data.preview : minutesQuery.data?.content;
  useEffect(() => {
    const version = minutesQuery.data?.version;
    if (version == null) return;
    if (lastMinutesVersion.current !== null && version > lastMinutesVersion.current) {
      void queryClient.invalidateQueries({ queryKey: target.scope === "workspace" ? queryKeys.workspacePage : queryKeys.projectPage(target.projectId) });
    }
    lastMinutesVersion.current = version;
  }, [minutesQuery.data?.version, queryClient, target]);
  useEffect(() => {
    const snapshot = minutesQuery.data;
    if (!snapshot?.version || !onMinutesCommitted) return;
    if (lastCommittedMinutes.current?.sessionId === snapshot.sessionId
      && lastCommittedMinutes.current.version >= snapshot.version) return;
    lastCommittedMinutes.current = { sessionId: snapshot.sessionId, version: snapshot.version };
    onMinutesCommitted();
  }, [minutesQuery.data, onMinutesCommitted]);
  const recoveryQuery = useQuery({
    queryKey: ["voice-recovery", target],
    queryFn: () => voiceApi.recoveryGet(target),
    enabled: visible && !!playbackQuery.data,
    refetchInterval: visible ? 5_000 : false,
    retry: false,
  });
  const recoveryProgress = recoveryQuery.data?.map(gap => `${gap.id}:${gap.cursorMs}`).join(",");
  useEffect(() => {
    if (recoveryProgress) void queryClient.invalidateQueries({ queryKey: ["voice-transcript", target] });
  }, [recoveryProgress, queryClient, target]);
  const transcriptQuery = useInfiniteQuery({
    queryKey: ["voice-transcript", target],
    initialPageParam: null as VoiceTranscriptCursor | null,
    queryFn: async ({ pageParam }) => {
      const page = await voiceApi.transcriptList({ target, after: pageParam, limit: 100 });
      if (!page) throw new Error("语音记录不存在");
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: transcriptOpen && visible,
    retry: false,
  });

  useEffect(() => {
    const chunks = playbackQuery.data?.chunks;
    if (!chunks?.length) {
      setLoadedDuration(0);
      setReady(false);
      return;
    }
    const player = new VoicePlayer();
    playerRef.current = player;
    const abort = new AbortController();
    setReady(false);
    setPlaying(false);
    setPositionMs(0);
    positionRef.current = 0;
    setPlaybackError(null);
    void player.load(chunks, desktopApi.toFileUrl, abort.signal).then(() => {
      if (abort.signal.aborted) return;
      setLoadedDuration(player.duration * 1000);
      player.setSpeed(speedRef.current);
      setReady(true);
    }).catch(error => {
      if (!abort.signal.aborted) setPlaybackError(`音频加载失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { abort.abort(); player.dispose(); playerRef.current = null; };
  }, [playbackQuery.data?.chunks]);

  useEffect(() => {
    setSourceSeekStatus(null);
    if (!visible || sourceTimeMs == null || !ready || !playerRef.current) return;
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0 || sourceTimeMs > totalMs) {
      setSourceSeekStatus("来源时间点已超出当前录音范围，无法定位。");
      return;
    }
    // Pause before seeking: an already playing resident player must not
    // schedule audio while a new source destination is being revealed.
    playerRef.current.pause();
    playerRef.current.seek(sourceTimeMs / 1000);
    positionRef.current = sourceTimeMs;
    setPositionMs(sourceTimeMs);
    setPlaying(false);
    setSourceSeekStatus(`已定位录音来源 ${formatTime(sourceTimeMs)}。`);
  }, [visible, ready, totalMs, sourceTimeMs, sourceNavigationKey]);

  function syncAudio(nextPositionMs: number, shouldPlay: boolean) {
    const player = playerRef.current;
    if (!player) return;
    player.seek(nextPositionMs / 1000);
    player.setSpeed(speedRef.current);
    if (!shouldPlay) player.pause();
  }

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const next = (playerRef.current?.position ?? 0) * 1000;
      positionRef.current = next;
      setPositionMs(next);
      if (next >= totalMs) {
        setPlaying(false);
        syncAudio(totalMs, false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalMs]);

  if (playbackQuery.isLoading || !playbackQuery.data) return null;

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      syncAudio(positionRef.current, false);
      return;
    }
    const start = positionRef.current >= totalMs ? 0 : positionRef.current;
    setPlaybackError(null);
    positionRef.current = start;
    setPositionMs(start);
    syncAudio(start, true);
    void playerRef.current?.play().then(() => setPlaying(true)).catch(error => {
      setPlaybackError(`音频未能启动：${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const seek = (next: number) => {
    positionRef.current = next;
    setPositionMs(next);
    syncAudio(next, playing);
  };

  const generateMinutes = async () => {
    setGeneratingMinutes(true);
    setMinutesError(null);
    try {
      await voiceApi.minutesGenerate({ target, requestId: crypto.randomUUID() });
      await minutesQuery.refetch();
    } catch (error) {
      setMinutesError(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingMinutes(false);
    }
  };

  const copyMinutes = async () => {
    if (!onCopyMinutes || !minutesQuery.data?.content) return;
    setCopyingMinutes(true);
    setMinutesError(null);
    try {
      await onCopyMinutes(minutesQuery.data.content);
    } catch (error) {
      setMinutesError(error instanceof Error ? error.message : String(error));
    } finally {
      setCopyingMinutes(false);
    }
  };

  return (
    <section aria-label="录音播放" className="rounded-[var(--radius-10)] border border-border bg-bg-subtle p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-body font-medium text-text">
          <Volume2 size={16} className="text-accent" />
          录音
        </div>
        <span className="text-caption text-text-muted">
          {playbackQuery.data.phase === "ended" ? "已保存" : "录制尚未结束"}
        </span>
      </div>
      {recoveryQuery.data?.some(gap => gap.status !== "ready") ? (
        <div className="mb-3 text-caption text-text-muted" role="status">
          {recoveryQuery.data.filter(gap => gap.status !== "ready").map(gap => (
            <p key={gap.id}>
              {formatTime(gap.startMs)}–{gap.endMs === null ? "录制中" : formatTime(gap.endMs)}：
              {gap.status === "running" ? "正在补转写" : gap.status === "failed" ? "补转写失败" : "等待补转写（实时录音优先）"}
              {gap.status === "failed" && gap.error ? `：${gap.error}` : ""}
            </p>
          ))}
          {recoveryQuery.data.some(gap => gap.status === "failed") ? (
            <Button variant="ghost" onClick={() => void voiceApi.recoveryRetry(target).then(() => recoveryQuery.refetch()).catch(error => setMinutesError(String(error)))}>重试补转写</Button>
          ) : null}
        </div>
      ) : null}
      {totalMs > 0 ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={playing ? "暂停录音" : "播放录音"}
            leadingIcon={playing ? <Pause size={14} /> : <Play size={14} />}
            onClick={togglePlayback}
            disabled={!ready}
          >
            {playing ? "暂停" : "播放"}
          </Button>
          <span className="w-10 text-right font-mono text-caption tabular-nums text-text-muted">{formatTime(positionMs)}</span>
          <input
            className="min-w-24 flex-1 accent-[var(--color-accent)]"
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={100}
            value={Math.min(positionMs, totalMs)}
            aria-label="录音进度"
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span className="w-10 font-mono text-caption tabular-nums text-text-muted">{formatTime(totalMs)}</span>
          <select
            className="h-7 rounded-[var(--radius-6)] border border-border bg-bg px-2 text-ui text-text"
            aria-label="播放倍速"
            value={speed}
            onChange={(event) => {
              const next = Number(event.target.value);
              speedRef.current = next;
              setSpeed(next);
              syncAudio(positionRef.current, playing);
            }}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </div>
      ) : (
        <p className="text-body text-text-muted">暂停或结束录制后，这里会显示已保存的音频。</p>
      )}
      {playbackError ? <p className="mt-2 text-caption text-danger">{playbackError}</p> : null}
      {visible && sourceSeekStatus ? <p role="status" className="mt-2 text-caption text-text-soft">{sourceSeekStatus}</p> : null}
      <section aria-label="会议纪要" className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-body font-medium text-text">会议纪要</h3>
          <div className="flex items-center gap-2">
            {onCopyMinutes && minutesQuery.data?.content && !minutesBusy ? <Button type="button" size="sm" variant="secondary" disabled={copyingMinutes}
              onClick={() => void copyMinutes()}>{copyingMinutes ? "复制中…" : "复制到正文"}</Button> : null}
            <Button type="button" size="sm" variant="secondary" disabled={minutesBusy}
              onClick={() => void generateMinutes()}>{generatingMinutes ? "提交中…" : "生成纪要"}</Button>
          </div>
        </div>
        {minutesQuery.data?.status === "pending" || minutesQuery.data?.status === "running" ?
          <p className="mt-2 text-caption text-text-muted">正在生成纪要…</p> : null}
        {minutesError || minutesQuery.data?.error || minutesQuery.error ?
          <p className="mt-2 text-caption text-danger">{minutesError || minutesQuery.data?.error || String(minutesQuery.error)}</p> : null}
        {displayedMinutes ? (
          <div className="mt-3 grid gap-3 text-body text-text">{displayedMinutes.split(/\n(?=## )/).map((section) => {
            const [heading, ...body] = section.trim().split("\n");
            return <div key={heading}><h4 className="font-medium">{heading.replace(/^## /, "")}</h4><p className="mt-1 whitespace-pre-wrap text-text-muted">{body.join("\n").trim()}</p></div>;
          })}</div>
        ) : minutesBusy ? null : <p className="mt-2 text-body text-text-muted">暂无会议纪要。选择文本模型后，可从最终转写生成纪要和 AI 标题。</p>}
      </section>
      <div className="mt-4 border-t border-border pt-3">
        <Button type="button" size="sm" variant="secondary" aria-expanded={transcriptOpen}
          onClick={() => setTranscriptOpen((current) => !current)}>
          转写
        </Button>
        {transcriptOpen ? (
          <div className="mt-3" aria-label="语音转写">
            {transcriptQuery.isPending ? <p className="text-body text-text-muted">正在加载转写…</p> : null}
            {transcriptQuery.isError ? <p className="text-body text-danger">转写加载失败：{String(transcriptQuery.error)}</p> : null}
            {transcriptQuery.data?.pages.flatMap((page) => page.segments).length === 0 ? (
              <p className="text-body text-text-muted">暂无转写。</p>
            ) : null}
            <ol className="grid gap-1">
              {transcriptQuery.data?.pages.flatMap((page) => page.segments).map((segment) => (
                <li key={segment.id}>
                  <button type="button" className="w-full rounded-[var(--radius-6)] px-2 py-1.5 text-left text-body text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
                    disabled={!ready || segment.startMs > totalMs}
                    onClick={() => seek(segment.startMs)}
                    title={segment.startMs > totalMs ? "对应音频尚不可用" : undefined}>
                    <span className="mr-2 font-mono text-caption tabular-nums text-text-muted">{formatTime(segment.startMs)}</span>
                    {segment.text}
                  </button>
                </li>
              ))}
            </ol>
            {transcriptQuery.hasNextPage ? (
              <Button type="button" size="sm" variant="secondary" className="mt-2"
                disabled={transcriptQuery.isFetchingNextPage}
                onClick={() => void transcriptQuery.fetchNextPage()}>
                {transcriptQuery.isFetchingNextPage ? "加载中…" : "加载更多"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
