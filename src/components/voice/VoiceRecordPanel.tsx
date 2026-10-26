import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VoiceRecordLookup, VoiceTranscriptCursor, VoiceSpeaker, VoiceSpeakerTurn } from "../../lib/voice-types";
import type { ContactRecord } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { voiceApi } from "../../services/voiceApi";
import { projectMindApi } from "../../services/projectMindApi";
import { ContactMentionPicker } from "../contact/ContactMentionPicker";
import { Button, TextField } from "../../ui/components";
import { VoicePlaybackControls, type VoicePlaybackHandle } from "./VoicePlaybackControls";

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

type SpeakerInterval = { turn: VoiceSpeakerTurn; maxEnd: number; left: SpeakerInterval | null; right: SpeakerInterval | null };

function indexSpeakerTurns(turns: VoiceSpeakerTurn[]): SpeakerInterval | null {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  function build(start: number, end: number): SpeakerInterval | null {
    if (start >= end) return null;
    const middle = (start + end) >>> 1;
    const left = build(start, middle);
    const right = build(middle + 1, end);
    const turn = sorted[middle];
    return { turn, left, right, maxEnd: Math.max(turn.endMs, left?.maxEnd ?? 0, right?.maxEnd ?? 0) };
  }
  return build(0, sorted.length);
}

function overlappingSpeakers(node: SpeakerInterval | null, start: number, end: number, ids: Set<number>) {
  if (!node || node.maxEnd <= start) return;
  overlappingSpeakers(node.left, start, end, ids);
  if (node.turn.startMs >= end) return;
  if (node.turn.endMs > start) ids.add(node.turn.speakerId);
  overlappingSpeakers(node.right, start, end, ids);
}

function SpeakerContactSelector({ speaker, busy, onLink }: { speaker: VoiceSpeaker; busy: boolean; onLink: (contactId: number | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ContactRecord | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const contactsQuery = useQuery({
    queryKey: ["voice-speaker-contacts", query],
    queryFn: () => projectMindApi.contactSearch({ query, limit: 5 }),
    enabled: open,
    retry: false,
  });
  async function confirm(contactId: number) {
    if (await onLink(contactId)) { setSelected(null); setOpen(false); }
  }
  return <div className="grid w-full gap-2 text-caption text-text-muted">
    {speaker.contactId !== null ? <p>{speaker.association === "automatic" ? "自动匹配联系人" : "已关联联系人"}：{speaker.name}</p> : null}
    {speaker.contactId !== null ? <p>修改自定义名称将解除联系人关联。</p> : null}
    {!speaker.voiceprintReady ? <p>声音样本不足，仅关联本次记录</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen((current) => !current)} aria-expanded={open}>选择联系人</Button>
      {!selected && speaker.association === "automatic" && speaker.contactId !== null ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void confirm(speaker.contactId!)}>{speaker.voiceprintReady ? "确认并记住声音" : "确认关联本次记录"}</Button> : null}
      {speaker.contactId !== null ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onLink(null)}>解除联系人关联</Button> : null}
    </div>
    {open ? <div className="grid gap-2">
      <label className="grid gap-1"><span>搜索已有联系人</span><TextField value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} /></label>
      {contactsQuery.isError ? <div><p role="alert" className="text-danger">联系人加载失败：{String(contactsQuery.error)}</p><Button type="button" size="sm" variant="secondary" onClick={() => void contactsQuery.refetch()}>重试搜索联系人</Button></div> : <ContactMentionPicker open loading={contactsQuery.isPending} results={contactsQuery.data ?? []} activeIndex={activeIndex} query={query} canCreate={false} onHoverIndex={setActiveIndex} onSelect={setSelected} className="[&_.recommendation-list]:max-h-none! [&_.recommendation-list]:overflow-visible!" />}
      {selected ? <div className="flex flex-wrap items-center gap-2"><span>已选择：{selected.name}</span><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void confirm(selected.id)}>{speaker.voiceprintReady ? "确认并记住声音" : "确认关联本次记录"}</Button></div> : null}
      {contactsQuery.data?.length === 0 ? <p>可在设置 → 联系人中新增联系人。</p> : null}
    </div> : null}
  </div>;
}

export function VoiceRecordPanel({ target: requestedTarget, visible = true, sourceTimeMs, sourceNavigationKey, onMinutesCommitted, onCopyMinutes }: VoiceRecordPanelProps) {
  const queryClient = useQueryClient();
  const targetKey = JSON.stringify(requestedTarget);
  // Keep observation lifetimes stable when parents recreate the same lookup.
  const target = useMemo(() => requestedTarget, [targetKey]);
  const voiceReads = useMemo(() => ({
    active: false,
    visible: false,
    generation: 0,
    dirty: new Set<string>(),
    draining: new Map<string, Promise<void>>(),
    recoveryProgress: undefined as string | undefined,
    endedSession: null as string | null,
  }), [target]);
  const drainVoiceReads = useCallback(() => {
    if (!voiceReads.active || !voiceReads.visible) return;
    const generation = voiceReads.generation;
    const isCurrent = () => voiceReads.active && voiceReads.generation === generation;
    for (const key of voiceReads.dirty) {
      if (voiceReads.draining.has(key)) continue;
      const filter = { queryKey: [key, target], exact: true };
      const job = (async () => {
        while (isCurrent() && voiceReads.visible && voiceReads.dirty.has(key)) {
          const query = queryClient.getQueryCache().find(filter);
          if (query?.state.fetchStatus === "fetching") {
            // Wait for the actual IPC read even while its observers are disabled.
            // Its failure remains visible in Query state; the dirty read is still due.
            await query.promise?.catch(() => undefined);
          }
          if (!isCurrent() || !voiceReads.visible) return;
          voiceReads.dirty.delete(key);
          await queryClient.invalidateQueries(filter, { cancelRefetch: false });
        }
      })().finally(() => {
        if (isCurrent()) voiceReads.draining.delete(key);
      });
      voiceReads.draining.set(key, job);
    }
  }, [queryClient, target, voiceReads]);
  const refreshAfterVoiceRead = useCallback((key: string) => {
    if (!voiceReads.active) return Promise.resolve();
    voiceReads.dirty.add(key);
    drainVoiceReads();
    return voiceReads.draining.get(key) ?? Promise.resolve();
  }, [drainVoiceReads, voiceReads]);
  useEffect(() => {
    voiceReads.active = true;
    return () => {
      voiceReads.active = false;
      voiceReads.generation++;
      voiceReads.dirty.clear();
      voiceReads.draining.clear();
      voiceReads.recoveryProgress = undefined;
      voiceReads.endedSession = null;
    };
  }, [voiceReads]);
  useEffect(() => {
    voiceReads.visible = visible;
    if (visible) drainVoiceReads();
    return () => { voiceReads.visible = false; };
  }, [drainVoiceReads, visible, voiceReads]);
  const playbackQuery = useQuery({
    queryKey: ["voice-playback", target],
    queryFn: () => voiceApi.playbackGet(target),
    staleTime: 0,
    refetchOnMount: "always",
    enabled: visible,
    refetchInterval: (query) => visible && ["recording", "paused"].includes(query.state.data?.phase ?? "") ? 1_000 : false,
    retry: false,
  });
  const ended = playbackQuery.data?.phase === "ended";
  const recording = ["recording", "paused"].includes(playbackQuery.data?.phase ?? "");
  const diarizationKey = ["voice-diarization", target];
  const diarizationQuery = useQuery({
    queryKey: diarizationKey,
    queryFn: () => voiceApi.diarizationGet(target),
    enabled: visible && ended,
    refetchInterval: (query) => visible && ["pending", "running"].includes(query.state.data?.status ?? "") ? 1_000 : false,
    retry: false,
  });
  const speakerModelQuery = useQuery({
    queryKey: ["voice-diarization-model"],
    queryFn: () => voiceApi.diarizationModelStatusGet(),
    enabled: visible && ended,
    retry: false,
  });
  const [speakerDrafts, setSpeakerDrafts] = useState<Record<number, string>>({});
  const [speakerError, setSpeakerError] = useState<string | null>(null);
  const [speakerBusy, setSpeakerBusy] = useState(false);
  useEffect(() => { setSpeakerDrafts({}); setSpeakerError(null); }, [playbackQuery.data?.sessionId]);
  async function startDiarization() {
    setSpeakerBusy(true);
    setSpeakerError(null);
    try { queryClient.setQueryData(diarizationKey, await voiceApi.diarizationStart(target)); }
    catch (error) { setSpeakerError(error instanceof Error ? error.message : String(error)); }
    finally { setSpeakerBusy(false); }
  }
  async function renameSpeaker(speakerId: number, name: string) {
    const snapshot = diarizationQuery.data;
    if (!snapshot) return;
    const trimmed = name.trim();
    if ([...trimmed].length < 1 || [...trimmed].length > 80) {
      setSpeakerError("说话人名称须为 1–80 个字符");
      return;
    }
    setSpeakerBusy(true);
    setSpeakerError(null);
    try {
      const next = await voiceApi.speakerRename({ target, speakerId, name: trimmed, expectedRevision: snapshot.revision });
      queryClient.setQueryData(diarizationKey, next);
      setSpeakerDrafts((current) => { const nextDrafts = { ...current }; delete nextDrafts[speakerId]; return nextDrafts; });
    } catch (error) {
      setSpeakerError(error instanceof Error ? error.message : String(error));
      await diarizationQuery.refetch();
    } finally { setSpeakerBusy(false); }
  }
  async function linkSpeakerContact(speakerId: number, contactId: number | null) {
    const snapshot = diarizationQuery.data;
    if (!snapshot) return false;
    setSpeakerBusy(true);
    setSpeakerError(null);
    try {
      queryClient.setQueryData(diarizationKey, await voiceApi.speakerLinkContact({ target, speakerId, contactId, expectedRevision: snapshot.revision }));
      setSpeakerDrafts((current) => { const next = { ...current }; delete next[speakerId]; return next; });
      return true;
    } catch (error) {
      setSpeakerError(error instanceof Error ? error.message : String(error));
      await diarizationQuery.refetch();
      return false;
    } finally { setSpeakerBusy(false); }
  }
  useEffect(() => {
    const current = playbackQuery.data;
    if (current?.phase === "ended" && voiceReads.endedSession !== current.sessionId) {
      voiceReads.endedSession = current.sessionId;
      // The first ended observation can follow a minutes read from before
      // voice_end enqueued final minutes, just like a recording -> ended change.
      for (const key of ["voice-transcript", "voice-minutes", "voice-recovery"]) {
        void refreshAfterVoiceRead(key);
      }
    }
  }, [playbackQuery.data?.phase, playbackQuery.data?.sessionId, refreshAfterVoiceRead, voiceReads]);
  const [totalMs, setTotalMs] = useState(0);
  const [ready, setReady] = useState(false);
  const playbackRef = useRef<VoicePlaybackHandle | null>(null);
  const onPlaybackAvailability = useCallback((available: boolean, duration: number) => {
    setReady(available);
    setTotalMs(duration);
  }, []);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [generatingMinutes, setGeneratingMinutes] = useState(false);
  const [copyingMinutes, setCopyingMinutes] = useState(false);
  useEffect(() => { setGeneratingMinutes(false); }, [voiceReads]);
  const lastMinutesVersion = useRef<number | null>(null);
  const lastCommittedMinutes = useRef<{ sessionId: string; version: number } | null>(null);
  const minutesQuery = useQuery({
    queryKey: ["voice-minutes", target],
    queryFn: () => voiceApi.minutesGet(target),
    staleTime: 0,
    refetchOnMount: "always",
    enabled: visible,
    refetchInterval: (query) => !visible ? false : ["pending", "running"].includes(query.state.data?.status ?? "") ? 500 : recording ? 5_000 : false,
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
    staleTime: 0,
    refetchOnMount: "always",
    enabled: visible && !!playbackQuery.data,
    refetchInterval: (query) => visible && (recording || query.state.data?.some(gap => ["waiting", "pending", "running"].includes(gap.status))) ? 5_000 : false,
    retry: false,
  });
  const recoveryProgress = recoveryQuery.data?.map(gap => `${gap.id}:${gap.cursorMs}:${gap.status === "ready"}`).join(",");
  const hasRecoveredTranscript = recoveryQuery.data?.some(gap => gap.status === "ready" || gap.cursorMs > gap.startMs) ?? false;
  useEffect(() => {
    if (recoveryProgress === undefined) return;
    const previous = voiceReads.recoveryProgress;
    voiceReads.recoveryProgress = recoveryProgress;
    if (previous === recoveryProgress) return;
    if (recoveryProgress) void refreshAfterVoiceRead("voice-transcript");
    // Every committed recovery batch can enqueue minutes, including a first
    // snapshot that already completed before this panel observed the task.
    if (previous !== undefined || hasRecoveredTranscript) {
      void refreshAfterVoiceRead("voice-minutes");
    }
  }, [recoveryProgress, hasRecoveredTranscript, refreshAfterVoiceRead, voiceReads]);
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

  const segments = useMemo(() => transcriptQuery.data?.pages.flatMap(page => page.segments) ?? [], [transcriptQuery.data?.pages]);
  const speakerIndex = useMemo(() => indexSpeakerTurns(diarizationQuery.data?.turns ?? []), [diarizationQuery.data?.turns]);
  const speakerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (diarizationQuery.data?.status !== "ready") return labels;
    for (const segment of segments) {
      const ids = new Set<number>();
      overlappingSpeakers(speakerIndex, segment.startMs, segment.endMs, ids);
      labels.set(segment.id, diarizationQuery.data.speakers.filter(speaker => ids.has(speaker.id)).map(speaker => speaker.name).join("、") || "未确定");
    }
    return labels;
  }, [segments, speakerIndex, diarizationQuery.data?.speakers, diarizationQuery.data?.status]);

  if (playbackQuery.isError && !playbackQuery.data) return <section aria-label="录音播放">
    <p role="alert" className="text-caption text-danger">录音加载失败：{String(playbackQuery.error)}</p>
    <Button type="button" size="sm" variant="secondary" onClick={() => void playbackQuery.refetch()}>重新读取录音</Button>
  </section>;
  if (playbackQuery.isLoading || !playbackQuery.data) return null;

  const seek = (next: number) => playbackRef.current?.seek(next);

  const generateMinutes = async () => {
    const observation = voiceReads;
    setGeneratingMinutes(true);
    setMinutesError(null);
    try {
      await voiceApi.minutesGenerate({ target, requestId: crypto.randomUUID() });
      await refreshAfterVoiceRead("voice-minutes");
    } catch (error) {
      if (observation.active) setMinutesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (observation.active) setGeneratingMinutes(false);
    }
  };

  const retryRecovery = async () => {
    const observation = voiceReads;
    try {
      await voiceApi.recoveryRetry(target);
      await refreshAfterVoiceRead("voice-recovery");
    } catch (error) {
      if (observation.active) setMinutesError(String(error));
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
      {playbackQuery.isError ? <p role="alert" className="mb-2 text-caption text-danger">录音刷新失败：{String(playbackQuery.error)}</p> : null}
      {recoveryQuery.isError ? <p role="alert" className="mb-2 text-caption text-danger">补转写状态读取失败：{String(recoveryQuery.error)}</p> : null}
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
            <Button variant="ghost" onClick={() => void retryRecovery()}>重试补转写</Button>
          ) : null}
        </div>
      ) : null}
      <VoicePlaybackControls ref={playbackRef} sessionId={playbackQuery.data.sessionId} chunks={playbackQuery.data.chunks}
        visible={visible} sourceTimeMs={sourceTimeMs} sourceNavigationKey={sourceNavigationKey} onAvailability={onPlaybackAvailability} />
      {ended ? <section aria-label="说话人区分" className="mt-4 border-t border-border pt-3">
        <h3 className="text-body font-medium text-text">说话人</h3>
        {diarizationQuery.isPending ? <p className="mt-2 text-caption text-text-muted">正在读取说话人状态…</p> : null}
        {["pending", "running"].includes(diarizationQuery.data?.status ?? "") ? <p role="status" className="mt-2 text-caption text-text-muted">{diarizationQuery.data?.status === "running" ? "正在本地区分说话人…" : "等待本地区分说话人（本地转写优先）"}</p> : null}
        {diarizationQuery.data?.status === "ready" ? <div className="mt-2 grid gap-2">
          {diarizationQuery.data.speakers.length === 0 ? <p className="text-caption text-text-muted">未检测到说话人</p> : null}
          <p className="text-caption text-text-muted">名称用于此录音的全部转写标签，不修改原始转写；一段可能包含多位说话人。</p>
          {diarizationQuery.data.speakers.map((speaker) => <div key={`${diarizationQuery.data?.sessionId}:${speaker.id}`} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-caption text-text-muted"><span>说话人{speaker.id}的名称</span><TextField value={speakerDrafts[speaker.id] ?? speaker.name} onChange={(event) => setSpeakerDrafts((current) => ({ ...current, [speaker.id]: event.target.value }))} /></label>
            <Button size="sm" variant="secondary" disabled={speakerBusy || speakerDrafts[speaker.id] === undefined} onClick={() => void renameSpeaker(speaker.id, speakerDrafts[speaker.id] ?? speaker.name)}>保存说话人{speaker.id}</Button>
            <SpeakerContactSelector speaker={speaker} busy={speakerBusy} onLink={(contactId) => linkSpeakerContact(speaker.id, contactId)} />
          </div>)}
        </div> : null}
        {!diarizationQuery.isPending && (!diarizationQuery.data || ["not_started", "failed"].includes(diarizationQuery.data.status)) ? (
          speakerModelQuery.data?.ready ? <Button size="sm" variant="secondary" className="mt-2" disabled={speakerBusy} onClick={() => void startDiarization()}>{speakerBusy ? "提交中…" : diarizationQuery.data?.status === "failed" ? "重试说话人区分" : "开始区分说话人"}</Button>
            : <p className="mt-2 text-caption text-text-muted">请前往设置 → 语音记录，下载并启用说话人区分。</p>
        ) : null}
        {speakerError || diarizationQuery.data?.error || diarizationQuery.error || speakerModelQuery.error ? <p role="alert" className="mt-2 text-caption text-danger">{speakerError || diarizationQuery.data?.error || String(diarizationQuery.error ?? speakerModelQuery.error)}</p> : null}
        {diarizationQuery.isError ? <Button size="sm" variant="secondary" onClick={() => void diarizationQuery.refetch()}>重新读取说话人状态</Button> : null}
      </section> : null}
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
            {playbackQuery.data?.recognitionError ? <p role="alert" className="mb-2 text-caption text-danger">本次录音的转写曾中断，可能缺少部分内容。{playbackQuery.data.recognitionError}</p> : null}
            {transcriptQuery.isPending ? <p className="text-body text-text-muted">正在加载转写…</p> : null}
            {transcriptQuery.isError ? <p className="text-body text-danger">转写加载失败：{String(transcriptQuery.error)}</p> : null}
            {segments.length === 0 ? (
              <p className="text-body text-text-muted">暂无转写。</p>
            ) : null}
            <ol className="grid gap-1">
              {segments.map((segment) => (
                <li key={segment.id}>
                  <button type="button" className="w-full rounded-[var(--radius-6)] px-2 py-1.5 text-left text-body text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
                    disabled={!ready || segment.startMs > totalMs}
                    onClick={() => seek(segment.startMs)}
                    title={segment.startMs > totalMs ? "对应音频尚不可用" : undefined}>
                    <span className="mr-2 font-mono text-caption tabular-nums text-text-muted">{formatTime(segment.startMs)}</span>
                    {diarizationQuery.data?.status === "ready" ? <span className="mr-2 text-caption text-text-muted">{speakerLabels.get(segment.id)}</span> : null}
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
