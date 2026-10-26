import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playbackGet: vi.fn(),
  recoveryGet: vi.fn(),
  recoveryRetry: vi.fn(),
  diarizationGet: vi.fn(),
  diarizationStart: vi.fn(),
  diarizationModelStatusGet: vi.fn(),
  speakerRename: vi.fn(),
  speakerLinkContact: vi.fn(),
  contactSearch: vi.fn(),
  transcriptList: vi.fn(),
  minutesGet: vi.fn(),
  minutesGenerate: vi.fn(),
  toFileUrl: vi.fn((path: string) => `asset://${path}`),
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  seek: vi.fn(),
  load: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
  position: 0,
  created: vi.fn(),
  disposed: vi.fn(),
  setSpeed: vi.fn(),
}));

vi.mock("../../services/voiceApi", () => ({
  voiceApi: { diarizationGet: mocks.diarizationGet, diarizationStart: mocks.diarizationStart, diarizationModelStatusGet: mocks.diarizationModelStatusGet, speakerRename: mocks.speakerRename, speakerLinkContact: mocks.speakerLinkContact, recoveryGet: mocks.recoveryGet, recoveryRetry: mocks.recoveryRetry, playbackGet: mocks.playbackGet, transcriptList: mocks.transcriptList, minutesGet: mocks.minutesGet, minutesGenerate: mocks.minutesGenerate },
}));

vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { contactSearch: mocks.contactSearch } }));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: { toFileUrl: mocks.toFileUrl },
}));

vi.mock("../../lib/voice-player", () => ({
  VoicePlayer: class {
    constructor() { mocks.created(); }
    duration = 60;
    get position() { return mocks.position; }
    load(...args: unknown[]) { return mocks.load(...args); }
    play() { return mocks.play(); }
    pause() { mocks.pause(); }
    seek(position: number) { mocks.seek(position); }
    setSpeed(rate: number) { mocks.setSpeed(rate); }
    dispose() { mocks.disposed(); }
  },
}));

class FakeAudio {
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  volume = 1;
  preload = "";
  preservesPitch = true;
  constructor(public src: string) {}
  play() {
    this.paused = false;
    return mocks.play();
  }
  pause() {
    this.paused = true;
    mocks.pause();
  }
  removeAttribute() {}
  load() {}
}

import { VoiceRecordPanel } from "./VoiceRecordPanel";
import { createProjectMindQueryClient } from "../../lib/queryClient";

describe("VoiceRecordPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio);
    mocks.diarizationGet.mockReset().mockResolvedValue(null);
    mocks.diarizationStart.mockReset().mockResolvedValue(null);
    mocks.speakerRename.mockReset();
    mocks.speakerLinkContact.mockReset();
    mocks.contactSearch.mockReset().mockResolvedValue([]);
    mocks.diarizationModelStatusGet.mockReset().mockResolvedValue({ ready: false, detail: "模型未导入" });
    mocks.playbackGet.mockReset();
    mocks.recoveryGet.mockReset().mockResolvedValue([]);
    mocks.recoveryRetry.mockReset().mockResolvedValue(undefined);
    mocks.transcriptList.mockReset();
    mocks.minutesGet.mockReset().mockResolvedValue({ sessionId: "session-one", version: 1, content: "## 摘要\n讨论了发布计划。", status: "ready", error: null });
    mocks.minutesGenerate.mockReset().mockResolvedValue({ sessionId: "session-one", version: 1, content: "## 摘要\n讨论了发布计划。", status: "pending", error: null });
    mocks.toFileUrl.mockClear();
    mocks.position = 0;
    mocks.created.mockClear();
    mocks.disposed.mockClear();
    mocks.setSpeed.mockClear();
    mocks.play.mockClear();
    mocks.pause.mockClear();
    mocks.seek.mockClear();
    mocks.load.mockReset().mockResolvedValue(undefined);
    mocks.transcriptList.mockResolvedValue({ segments: [], nextCursor: null });
    mocks.playbackGet.mockResolvedValue({
      sessionId: "session-one",
      phase: "ended",
      chunks: [
        { source: "microphone", epoch: 1, startMs: 600, durationMs: 59_400, path: "/voice/mic.wav" },
        { source: "system", epoch: 1, startMs: 180, durationMs: 59_820, path: "/voice/system.wav" },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function advancePolling(milliseconds: number) {
    await act(() => vi.advanceTimersByTimeAsync(milliseconds));
    await act(() => vi.advanceTimersByTimeAsync(10));
  }

  function renderPollingPanel(copies = 1, cachedMinutes?: unknown) {
    vi.useFakeTimers();
    const client = createProjectMindQueryClient();
    const target = { scope: "workspace" as const, recordId: 7 };
    if (cachedMinutes !== undefined) {
      client.setQueryData(["voice-minutes", target], cachedMinutes);
      client.setQueryData(["voice-recovery", target], []);
    }
    const panel = (visible = true, recordId = 7, copies = 1) => <QueryClientProvider client={client}>
      {Array.from({ length: copies }, (_, index) => <VoiceRecordPanel key={index} target={{ ...target, recordId }} visible={visible} />)}
    </QueryClientProvider>;
    const view = render(panel(true, 7, copies));
    return { client, target, panel, view, close: () => { view.unmount(); client.clear(); } };
  }

  it.each(["ready", "failed", "empty"])("stops all periodic minutes and recovery reads for ended %s records", async (status) => {
    const minutes = await mocks.minutesGet();
    mocks.minutesGet.mockClear().mockResolvedValue(status === "empty" ? null : { ...minutes, status });
    mocks.recoveryGet.mockResolvedValue(status === "empty" ? [] : [{ id: 3, cursorMs: 6000, startMs: 1000, endMs: 6000, status, error: null }]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    // First ended, and ready/advanced recovery, each require a bounded reread.
    expect(mocks.minutesGet).toHaveBeenCalledTimes(status === "empty" ? 2 : 3);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    await advancePolling(120_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(status === "empty" ? 2 : 3);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    polling.close();
  });

  it("polls pending and running minutes every 500ms, then stops at ready", async () => {
    const minutes = await mocks.minutesGet();
    mocks.minutesGet.mockClear().mockResolvedValue({ ...minutes, status: "pending" });
    const polling = renderPollingPanel();
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    mocks.minutesGet.mockResolvedValue({ ...minutes, status: "running", preview: "## 处理中" });
    await advancePolling(500);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    expect(screen.getByText("处理中")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 最新纪要" });
    await advancePolling(500);
    expect(screen.getByText("最新纪要")).toBeInTheDocument();
    const calls = mocks.minutesGet.mock.calls.length;
    await advancePolling(120_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(calls);
    polling.close();
  });

  it("wakes minutes on recovery progress and completion, then stops both reads", async () => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 10_000, cursorMs: 0, status: "waiting", error: null };
    mocks.minutesGet.mockClear();
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    for (const status of ["pending", "running"]) {
      const calls = mocks.recoveryGet.mock.calls.length;
      mocks.recoveryGet.mockResolvedValue([{ ...gap, status }]);
      await advancePolling(5000);
      expect(mocks.recoveryGet).toHaveBeenCalledTimes(calls + 1);
      expect(mocks.recoveryGet).toHaveBeenLastCalledWith(polling.target);
    }
    const beforeProgress = mocks.minutesGet.mock.calls.length;
    mocks.minutesGet.mockResolvedValue({ ...minutes, status: "pending" });
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 5000, status: "pending" }]);
    await advancePolling(5000);
    expect(mocks.minutesGet.mock.calls.length).toBeGreaterThan(beforeProgress);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue(minutes);
    await advancePolling(500);
    const beforeCompletion = mocks.minutesGet.mock.calls.length;
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 补转写后的纪要" });
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 10_000, status: "ready" }]);
    await advancePolling(5000);
    expect(mocks.minutesGet.mock.calls.length).toBeGreaterThan(beforeCompletion);
    expect(screen.getByText("补转写后的纪要")).toBeInTheDocument();
    const calls = [mocks.minutesGet.mock.calls.length, mocks.recoveryGet.mock.calls.length];
    await advancePolling(120_000);
    expect([mocks.minutesGet.mock.calls.length, mocks.recoveryGet.mock.calls.length]).toEqual(calls);
    polling.close();
  });

  it("resumes stopped observers after manual generation and failed recovery retry", async () => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "failed", error: "连接超时" };
    mocks.minutesGet.mockClear();
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    mocks.minutesGenerate.mockImplementation(async () => {
      mocks.minutesGet.mockResolvedValue({ ...minutes, status: "pending" });
    });
    fireEvent.click(screen.getByRole("button", { name: "生成纪要" }));
    await advancePolling(10);
    expect(mocks.minutesGenerate).toHaveBeenCalledOnce();
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 手动新纪要" });
    await advancePolling(500);
    expect(screen.getByText("手动新纪要")).toBeInTheDocument();
    mocks.recoveryRetry.mockImplementation(async () => {
      mocks.recoveryGet.mockResolvedValue([{ ...gap, status: "pending", error: null }]);
    });
    fireEvent.click(screen.getByRole("button", { name: "重试补转写" }));
    await advancePolling(10);
    expect(mocks.recoveryRetry).toHaveBeenCalledWith(polling.target);
    expect(screen.getByText(/等待补转写/)).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 3, content: "## 重试后的纪要" });
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 6000, status: "ready", error: null }]);
    await advancePolling(5000);
    expect(screen.getByText("重试后的纪要")).toBeInTheDocument();
    const calls = [mocks.minutesGet.mock.calls.length, mocks.recoveryGet.mock.calls.length];
    await advancePolling(60_000);
    expect([mocks.minutesGet.mock.calls.length, mocks.recoveryGet.mock.calls.length]).toEqual(calls);
    polling.close();
  });

  it("reads nothing while hidden and refreshes fresh cached terminal data immediately on return", async () => {
    const minutes = await mocks.minutesGet();
    mocks.minutesGet.mockClear();
    const polling = renderPollingPanel();
    await advancePolling(10);
    polling.view.rerender(polling.panel(false));
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 隐藏时完成的纪要" });
    mocks.recoveryGet.mockResolvedValue([{ id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "pending", error: null }]);
    await advancePolling(1000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    expect(mocks.playbackGet).toHaveBeenCalledOnce();
    polling.view.rerender(polling.panel());
    await advancePolling(10);
    expect(screen.getByText("隐藏时完成的纪要")).toBeInTheDocument();
    expect(screen.getByText(/等待补转写/)).toBeInTheDocument();
    // Returning reads once; discovering a new recovery gap also wakes minutes.
    expect(mocks.minutesGet).toHaveBeenCalledTimes(4);
    expect(mocks.recoveryGet).toHaveBeenCalledTimes(2);
    expect(mocks.playbackGet).toHaveBeenCalledTimes(2);
    polling.close();
  });

  it("refreshes a cached target on switching back without waking the previous target", async () => {
    const minutes = await mocks.minutesGet();
    mocks.minutesGet.mockClear();
    const polling = renderPollingPanel();
    await advancePolling(10);
    polling.view.rerender(polling.panel(true, 8));
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenLastCalledWith({ scope: "workspace", recordId: 8 });
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 返回目标的新纪要" });
    mocks.minutesGet.mockClear();
    mocks.recoveryGet.mockClear();
    polling.view.rerender(polling.panel());
    await advancePolling(10);
    expect(screen.getByText("返回目标的新纪要")).toBeInTheDocument();
    expect(mocks.minutesGet).toHaveBeenCalledExactlyOnceWith(polling.target);
    expect(mocks.recoveryGet).toHaveBeenCalledExactlyOnceWith(polling.target);
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    polling.close();
  });

  it("shares in-flight minutes and recovery reads and observes business cache updates", async () => {
    const minutes = await mocks.minutesGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    let resolveRecovery!: (gaps: unknown[]) => void;
    mocks.minutesGet.mockReset().mockImplementation(() => new Promise(resolve => { resolveMinutes = resolve; }));
    mocks.recoveryGet.mockReset().mockImplementation(() => new Promise(resolve => { resolveRecovery = resolve; }));
    const polling = renderPollingPanel(2);
    await advancePolling(10_000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    await act(async () => { resolveMinutes(minutes); resolveRecovery([]); });
    await advancePolling(10);
    // Finish the bounded first-ended reread as well.
    await act(async () => { resolveMinutes(minutes); resolveRecovery([]); });
    await advancePolling(10);
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(mocks.recoveryGet).toHaveBeenCalledTimes(2);
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 共享任务的新纪要" });
    act(() => { polling.client.setQueryData(["voice-minutes", polling.target], { ...minutes, status: "pending" }); });
    await advancePolling(500);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("共享任务的新纪要")).toHaveLength(2);
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    polling.close();
  });

  it.each(["recording", "paused"])("keeps low frequency discovery during %s", async (phase) => {
    mocks.playbackGet.mockResolvedValue({ sessionId: "session-one", phase, chunks: [] });
    const polling = renderPollingPanel();
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    await advancePolling(4000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    await advancePolling(1000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(mocks.recoveryGet).toHaveBeenCalledTimes(2);
    polling.close();
  });

  it.each([false, true])("rereads minutes and recovery after pre-end reads settle (cached: %s)", async (cached) => {
    const minutes = await mocks.minutesGet();
    const playback = await mocks.playbackGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    let resolveRecovery!: (gaps: unknown[]) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveMinutes = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    mocks.recoveryGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; }))
      .mockResolvedValue([{ id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "pending", error: null }]);
    mocks.playbackGet.mockClear().mockResolvedValue({ ...playback, phase: "recording" });
    const polling = renderPollingPanel(1, cached ? minutes : undefined);
    await advancePolling(10);
    mocks.playbackGet.mockResolvedValue(playback);
    await advancePolling(1000);
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    await act(async () => { resolveMinutes(minutes); resolveRecovery([]); });
    await advancePolling(10);
    // A newly discovered gap also wakes minutes when the old gap cache was present.
    expect(mocks.minutesGet).toHaveBeenCalledTimes(cached ? 3 : 2);
    expect(mocks.recoveryGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    expect(screen.getByText(/等待补转写/)).toBeInTheDocument();
    polling.close();
  });

  it("rereads minutes after a pre-progress ready read settles", async () => {
    const minutes = await mocks.minutesGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveMinutes = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "running", error: null };
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 6000, status: "ready" }]);
    await advancePolling(5000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    await act(async () => { resolveMinutes(minutes); });
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    polling.close();
  });

  it.each(["unmount", "scope switch"])("discards queued end refreshes after %s", async (action) => {
    const minutes = await mocks.minutesGet();
    const playback = await mocks.playbackGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    let resolveRecovery!: (gaps: unknown[]) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveMinutes = resolve; })).mockResolvedValue(minutes);
    mocks.recoveryGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; })).mockResolvedValue([]);
    mocks.playbackGet.mockClear().mockResolvedValue({ ...playback, phase: "paused" });
    const polling = renderPollingPanel();
    await advancePolling(10);
    mocks.playbackGet.mockResolvedValue(playback);
    await advancePolling(1000);
    if (action === "unmount") polling.view.unmount();
    else polling.view.rerender(<QueryClientProvider client={polling.client}><VoiceRecordPanel target={{ scope: "project", projectId: 1, recordId: 7 }} /></QueryClientProvider>);
    await advancePolling(10);
    await act(async () => { resolveMinutes(minutes); resolveRecovery([]); });
    await advancePolling(10);
    expect(mocks.minutesGet.mock.calls.filter(([target]) => target.scope === "workspace")).toHaveLength(1);
    expect(mocks.recoveryGet.mock.calls.filter(([target]) => target.scope === "workspace")).toHaveLength(1);
    if (action === "scope switch") {
      expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
      expect(mocks.recoveryGet).toHaveBeenCalledTimes(2);
    }
    polling.close();
  });

  it.each(["unmount", "scope switch"])("discards queued recovery progress refreshes after %s", async (action) => {
    const minutes = await mocks.minutesGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveMinutes = resolve; })).mockResolvedValue(minutes);
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "running", error: null };
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 6000, status: "ready" }]);
    await advancePolling(5000);
    if (action === "unmount") polling.view.unmount();
    else polling.view.rerender(<QueryClientProvider client={polling.client}><VoiceRecordPanel target={{ scope: "project", projectId: 1, recordId: 7 }} /></QueryClientProvider>);
    await advancePolling(10);
    await act(async () => { resolveMinutes(minutes); });
    await advancePolling(10);
    expect(mocks.minutesGet.mock.calls.filter(([target]) => target.scope === "workspace")).toHaveLength(1);
    // The new scope independently observes a first completed recovery snapshot.
    if (action === "scope switch") expect(mocks.minutesGet.mock.calls.filter(([target]) => target.scope === "project")).toHaveLength(3);
    polling.close();
  });

  it.each(["ready", "empty"])("observes manual generation after the initial deferred %s read settles", async (initial) => {
    const minutes = await mocks.minutesGet();
    let resolveOld!: (snapshot: unknown) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    const polling = renderPollingPanel();
    await advancePolling(10);
    const generate = screen.getByRole("button", { name: "生成纪要" });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await advancePolling(10);
    expect(mocks.minutesGenerate).toHaveBeenCalledOnce();
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    await act(async () => { resolveOld(initial === "ready" ? minutes : null); });
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 手动任务完成" });
    await advancePolling(500);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    expect(screen.getByText("手动任务完成")).toBeInTheDocument();
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    polling.close();
  });

  it.each(["generate", "retry"])("keeps cached %s refresh singleflight until the old native read settles", async (action) => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "failed", error: "连接超时" };
    const api = action === "generate" ? mocks.minutesGet : mocks.recoveryGet;
    let resolveOld!: (snapshot: unknown) => void;
    api.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(action === "generate" ? { ...minutes, status: "pending" } : [{ ...gap, status: "pending", error: null }]);
    const polling = renderPollingPanel(1, minutes);
    if (action === "retry") {
      act(() => { polling.client.setQueryData(["voice-recovery", polling.target], [gap]); });
    }
    await advancePolling(10);
    fireEvent.click(screen.getByRole("button", { name: action === "generate" ? "生成纪要" : "重试补转写" }));
    await advancePolling(10);
    expect(action === "generate" ? mocks.minutesGenerate : mocks.recoveryRetry).toHaveBeenCalledOnce();
    // No second native request may start while the first one is unresolved.
    expect(api).toHaveBeenCalledOnce();
    await act(async () => { resolveOld(action === "generate" ? minutes : [gap]); });
    await advancePolling(10);
    expect(api).toHaveBeenCalledTimes(2);
    expect(screen.getByText(action === "generate" ? "正在生成纪要…" : /等待补转写/)).toBeInTheDocument();
    api.mockResolvedValue(action === "generate" ? minutes : [{ ...gap, cursorMs: 6000, status: "ready", error: null }]);
    await advancePolling(action === "generate" ? 500 : 5000);
    expect(api).toHaveBeenCalledTimes(3);
    await advancePolling(60_000);
    expect(api).toHaveBeenCalledTimes(3);
    polling.close();
  });

  it.each([
    ["generate", "unmount"], ["generate", "scope switch"],
    ["retry", "unmount"], ["retry", "scope switch"],
  ])("discards the queued manual %s read after %s", async (action, teardown) => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "failed", error: "连接超时" };
    const api = action === "generate" ? mocks.minutesGet : mocks.recoveryGet;
    const key = action === "generate" ? "voice-minutes" : "voice-recovery";
    let resolveOld!: (snapshot: unknown) => void;
    api.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(action === "generate" ? minutes : []);
    const polling = renderPollingPanel(1, minutes);
    if (action === "retry") {
      act(() => { polling.client.setQueryData(["voice-recovery", polling.target], [gap]); });
    }
    await advancePolling(10);
    fireEvent.click(screen.getByRole("button", { name: action === "generate" ? "生成纪要" : "重试补转写" }));
    await advancePolling(10);
    expect(api).toHaveBeenCalledOnce();
    if (teardown === "unmount") polling.view.unmount();
    else polling.view.rerender(<QueryClientProvider client={polling.client}><VoiceRecordPanel target={{ scope: "project", projectId: 1, recordId: 7 }} /></QueryClientProvider>);
    await advancePolling(10);
    await act(async () => { resolveOld(action === "generate" ? minutes : [gap]); });
    await advancePolling(10);
    expect(api.mock.calls.filter(([target]) => target.scope === "workspace")).toHaveLength(1);
    expect(polling.client.getQueryState([key, polling.target])?.isInvalidated).toBe(false);
    polling.close();
  });

  it.each(["ready", "empty"])("retains the end refresh across hiding and showing before the old %s read settles", async (oldStatus) => {
    const minutes = await mocks.minutesGet();
    const playback = await mocks.playbackGet();
    let resolveOld!: (snapshot: unknown) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    mocks.playbackGet.mockClear().mockResolvedValue({ ...playback, phase: "recording" });
    const polling = renderPollingPanel();
    await advancePolling(10);
    mocks.playbackGet.mockResolvedValue(playback);
    await advancePolling(1000);
    polling.view.rerender(polling.panel(false));
    await advancePolling(1000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    polling.view.rerender(polling.panel());
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    await act(async () => { resolveOld(oldStatus === "ready" ? minutes : null); });
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue(minutes);
    await advancePolling(500);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    polling.close();
  });

  it.each(["minutes first", "recovery first"])("rereads minutes after the first completed recovery snapshot (%s)", async (order) => {
    const minutes = await mocks.minutesGet();
    let resolveMinutes!: (snapshot: unknown) => void;
    let resolveRecovery!: (gaps: unknown[]) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveMinutes = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    mocks.recoveryGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveRecovery = resolve; }));
    const polling = renderPollingPanel();
    await advancePolling(10);
    const gaps = [{ id: 3, startMs: 0, endMs: 6000, cursorMs: 6000, status: "ready", error: null }];
    if (order === "minutes first") await act(async () => { resolveMinutes(minutes); });
    await act(async () => { resolveRecovery(gaps); });
    await advancePolling(10);
    if (order === "recovery first") {
      expect(mocks.minutesGet).toHaveBeenCalledOnce();
      await act(async () => { resolveMinutes(minutes); });
      await advancePolling(10);
    }
    expect(mocks.minutesGet).toHaveBeenCalledTimes(order === "minutes first" ? 3 : 2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 首次恢复后的纪要" });
    await advancePolling(500);
    expect(screen.getByText("首次恢复后的纪要")).toBeInTheDocument();
    expect(mocks.minutesGet).toHaveBeenCalledTimes(order === "minutes first" ? 4 : 3);
    polling.view.rerender(polling.panel());
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(order === "minutes first" ? 4 : 3);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    polling.close();
  });

  it("retains recovery progress intent across hiding before the old minutes read settles", async () => {
    const minutes = await mocks.minutesGet();
    let resolveOld!: (snapshot: unknown) => void;
    mocks.minutesGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ...minutes, status: "pending" });
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "running", error: null };
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    mocks.recoveryGet.mockResolvedValue([{ ...gap, cursorMs: 6000, status: "ready" }]);
    await advancePolling(5000);
    polling.view.rerender(polling.panel(false));
    await advancePolling(1000);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    polling.view.rerender(polling.panel());
    await advancePolling(10);
    await act(async () => { resolveOld(minutes); });
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    polling.close();
  });

  it.each(["generate", "retry"])("queues manual %s completion while hidden and drains on resume", async (action) => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "failed", error: "连接超时" };
    const mutation = action === "generate" ? mocks.minutesGenerate : mocks.recoveryRetry;
    const read = action === "generate" ? mocks.minutesGet : mocks.recoveryGet;
    let finishMutation!: () => void;
    mutation.mockImplementationOnce(() => new Promise<void>(resolve => { finishMutation = resolve; }));
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    read.mockClear();
    fireEvent.click(screen.getByRole("button", { name: action === "generate" ? "生成纪要" : "重试补转写" }));
    await advancePolling(10);
    polling.view.rerender(polling.panel(false));
    await act(async () => { finishMutation(); });
    await advancePolling(10);
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValue(action === "generate" ? { ...minutes, status: "pending" } : [{ ...gap, status: "pending", error: null }]);
    polling.view.rerender(polling.panel());
    await advancePolling(10);
    // Resume's automatic read and the retained intent coalesce into one read.
    expect(read).toHaveBeenCalledOnce();
    expect(screen.getByText(action === "generate" ? "正在生成纪要…" : /等待补转写/)).toBeInTheDocument();
    polling.close();
  });

  it("rereads old ready minutes when the first deferred playback observes an ended session", async () => {
    const minutes = await mocks.minutesGet();
    const playback = await mocks.playbackGet();
    let resolvePlayback!: (snapshot: unknown) => void;
    mocks.minutesGet.mockClear();
    mocks.playbackGet.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolvePlayback = resolve; }));
    const polling = renderPollingPanel();
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledOnce();
    mocks.minutesGet.mockResolvedValue({ ...minutes, status: "pending" });
    // voice_end has enqueued final minutes before this first manifest returns.
    await act(async () => { resolvePlayback(playback); });
    await advancePolling(10);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(2);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    mocks.minutesGet.mockResolvedValue({ ...minutes, version: 2, content: "## 首开收尾纪要" });
    await advancePolling(500);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    expect(screen.getByText("首开收尾纪要")).toBeInTheDocument();
    polling.view.rerender(polling.panel());
    await advancePolling(60_000);
    expect(mocks.minutesGet).toHaveBeenCalledTimes(3);
    expect(mocks.recoveryGet).toHaveBeenCalledOnce();
    polling.close();
  });

  it("keeps first-ended and completed-recovery intents dormant while hidden under StrictMode", async () => {
    const minutes = await mocks.minutesGet();
    const playback = await mocks.playbackGet();
    mocks.minutesGet.mockClear().mockResolvedValue({ ...minutes, status: "pending" });
    mocks.playbackGet.mockClear();
    const client = createProjectMindQueryClient();
    const target = { scope: "workspace" as const, recordId: 7 };
    client.setQueryData(["voice-playback", target], playback);
    client.setQueryData(["voice-minutes", target], minutes);
    client.setQueryData(["voice-recovery", target], [{ id: 3, startMs: 0, endMs: 6000, cursorMs: 6000, status: "ready", error: null }]);
    vi.useFakeTimers();
    const panel = (visible: boolean) => <StrictMode><QueryClientProvider client={client}><VoiceRecordPanel target={target} visible={visible} /></QueryClientProvider></StrictMode>;
    const view = render(panel(false));
    await advancePolling(10_000);
    expect(mocks.minutesGet).not.toHaveBeenCalled();
    expect(mocks.recoveryGet).not.toHaveBeenCalled();
    expect(mocks.playbackGet).not.toHaveBeenCalled();
    view.rerender(panel(true));
    await advancePolling(10);
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it.each(["generate", "retry"])("drops manual %s completion from a departed scope while hidden", async (action) => {
    const minutes = await mocks.minutesGet();
    const gap = { id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "failed", error: "连接超时" };
    const mutation = action === "generate" ? mocks.minutesGenerate : mocks.recoveryRetry;
    const read = action === "generate" ? mocks.minutesGet : mocks.recoveryGet;
    let finishMutation!: () => void;
    mutation.mockImplementationOnce(() => new Promise<void>(resolve => { finishMutation = resolve; }));
    mocks.recoveryGet.mockResolvedValue([gap]);
    const polling = renderPollingPanel();
    await advancePolling(10);
    fireEvent.click(screen.getByRole("button", { name: action === "generate" ? "生成纪要" : "重试补转写" }));
    await advancePolling(10);
    polling.view.rerender(polling.panel(false));
    polling.view.rerender(<QueryClientProvider client={polling.client}><VoiceRecordPanel target={{ scope: "project", projectId: 1, recordId: 7 }} /></QueryClientProvider>);
    await advancePolling(10);
    read.mockClear();
    await act(async () => { finishMutation(); });
    await advancePolling(10);
    expect(read).not.toHaveBeenCalled();
    polling.close();
  });

  it("keeps the same playing transport and speed when another saved chunk arrives", async () => {
    const client = new QueryClient();
    const target = { scope: "workspace" as const, recordId: 7 };
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={target} /></QueryClientProvider>);
    const play = await screen.findByRole("button", { name: "播放录音" });
    await waitFor(() => expect(play).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "播放倍速" }), { target: { value: "1.5" } });
    fireEvent.click(play);
    await screen.findByRole("button", { name: "暂停录音" });
    const seeks = mocks.seek.mock.calls.length;
    await act(async () => {
      const snapshot = await mocks.playbackGet();
      client.setQueryData(["voice-playback", target], { ...snapshot, chunks: [...snapshot.chunks,
        { source: "microphone", epoch: 1, startMs: 60_000, durationMs: 60_000, path: "/voice/next.wav" }] });
    });
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(mocks.created).toHaveBeenCalledOnce();
    expect(mocks.disposed).not.toHaveBeenCalled();
    expect(mocks.seek).toHaveBeenCalledTimes(seeks);
    expect(screen.getByRole("button", { name: "暂停录音" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "播放倍速" })).toHaveValue("1.5");
    view.unmount();
  });

  it("updates playback frames without reading the saved Transcript again", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const readText = vi.fn(() => "稳定转写");
    mocks.transcriptList.mockResolvedValue({ segments: [{ id: "a", startMs: 0, endMs: 1000, get text() { return readText(); }, language: "zh" }], nextCursor: null });
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "转写" }));
    await screen.findByRole("button", { name: /稳定转写/ });
    fireEvent.click(screen.getByRole("button", { name: "播放录音" }));
    await screen.findByRole("button", { name: "暂停录音" });
    readText.mockClear();
    for (let index = 1; index <= 20; index++) {
      mocks.position = index / 10;
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback(index * 16));
      });
    }
    expect(screen.getByLabelText("录音进度")).toHaveValue("2000");
    expect(readText).not.toHaveBeenCalled();
    view.unmount();
  });

  it("indexes speaker overlaps once for a transcript page rather than comparing every pair", async () => {
    const readStart = vi.fn();
    mocks.diarizationGet.mockResolvedValue({ sessionId: "session-one", revision: 1, status: "ready", error: null,
      speakers: [{ id: 1, name: "小明", contactId: null, association: null, voiceprintReady: false }],
      turns: Array.from({ length: 400 }, (_, index) => ({ get startMs() { readStart(); return index * 1000; }, endMs: index * 1000 + 800, speakerId: 1 })) });
    mocks.transcriptList.mockResolvedValue({ segments: Array.from({ length: 100 }, (_, index) => ({ id: String(index), startMs: index * 1000, endMs: index * 1000 + 900, text: `句子${index}`, language: "zh" })), nextCursor: null });
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    await screen.findByRole("textbox", { name: "说话人1的名称" });
    readStart.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "转写" }));
    await screen.findByRole("button", { name: /句子99/ });
    expect(readStart.mock.calls.length).toBeLessThan(8000);
    view.unmount();
  });

  it("shares slow playback polling across consumers without overlapping API requests", async () => {
    vi.useFakeTimers();
    let resolve!: (snapshot: unknown) => void;
    const snapshot = await mocks.playbackGet();
    mocks.playbackGet.mockReset().mockImplementation(() => new Promise(done => { resolve = done; }));
    const client = new QueryClient();
    const target = { scope: "workspace" as const, recordId: 7 };
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={target} /><VoiceRecordPanel target={target} /></QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(mocks.playbackGet).toHaveBeenCalledOnce();
    resolve({ ...snapshot, phase: "recording", chunks: [] });
    await act(() => vi.advanceTimersByTimeAsync(1010));
    expect(mocks.playbackGet).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.playbackGet).toHaveBeenCalledTimes(2);
    view.unmount();
    client.clear();
  });

  it("shows a failed playback manifest explicitly and lets the user retry", async () => {
    const saved = await mocks.playbackGet();
    mocks.playbackGet.mockRejectedValue(new Error("录音清单不可用"));
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("录音清单不可用");
    mocks.playbackGet.mockResolvedValue(saved);
    fireEvent.click(screen.getByRole("button", { name: "重新读取录音" }));
    await screen.findByRole("button", { name: "播放录音" });
    view.unmount();
  });

  it("aborts an in-flight audio load when the player panel closes", async () => {
    let resolve!: () => void;
    mocks.load.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledOnce());
    const signal = mocks.load.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(mocks.disposed).toHaveBeenCalledOnce();
    await act(async () => { resolve(); });
  });

  it("shows persisted local transcription failure beside the saved transcript", async () => {
    mocks.playbackGet.mockResolvedValue({ sessionId: "session-one", phase: "ended", chunks: [], recognitionError: "local inference failed" });
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "转写" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本次录音的转写曾中断，可能缺少部分内容。local inference failed");
    expect(await screen.findByText("暂无转写。")).toBeInTheDocument();
  });

  it("labels overlapping speakers and preserves drafts after a rename conflict", async () => {
    const snapshot = { sessionId: "session-one", revision: 1, status: "ready", error: null,
      speakers: [{ id: 1, name: "说话人1", contactId: null, association: null, voiceprintReady: false }, { id: 2, name: "说话人2", contactId: null, association: null, voiceprintReady: false }],
      turns: [{ startMs: 0, endMs: 800, speakerId: 1 }, { startMs: 500, endMs: 1000, speakerId: 2 }] };
    mocks.diarizationGet.mockResolvedValue(snapshot);
    mocks.speakerRename.mockRejectedValue(new Error("版本冲突"));
    mocks.transcriptList.mockResolvedValue({ segments: [
      { id: "a", startMs: 0, endMs: 1000, text: "原始转写", language: "zh" },
      { id: "b", startMs: 1000, endMs: 2000, text: "没有重叠", language: "zh" }], nextCursor: null });
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    const input = await screen.findByRole("textbox", { name: "说话人1的名称" });
    fireEvent.change(input, { target: { value: " 小明 " } });
    mocks.diarizationGet.mockResolvedValue({ ...snapshot, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "保存说话人1" }));
    expect(await screen.findByText("版本冲突")).toBeInTheDocument();
    expect(input).toHaveValue(" 小明 ");
    await waitFor(() => expect(mocks.diarizationGet).toHaveBeenCalledTimes(2));
    mocks.speakerRename.mockResolvedValue({ ...snapshot, revision: 3, speakers: [{ id: 1, name: "小明", contactId: null, association: null, voiceprintReady: false }, snapshot.speakers[1]] });
    fireEvent.click(screen.getByRole("button", { name: "保存说话人1" }));
    await waitFor(() => expect(mocks.speakerRename).toHaveBeenLastCalledWith({ target: { scope: "workspace", recordId: 7 }, speakerId: 1, name: "小明", expectedRevision: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "转写" }));
    expect(await screen.findByText("小明、说话人2")).toBeInTheDocument();
    expect(screen.getByText("未确定")).toBeInTheDocument();
    expect(screen.getByText("原始转写")).toBeInTheDocument();
  });

  it("shows missing model guidance and retries a failed run when models are ready", async () => {
    const snapshot = { sessionId: "session-one", revision: 1, status: "failed", error: "推理失败", speakers: [], turns: [] };
    mocks.diarizationGet.mockResolvedValue(snapshot);
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    expect(await screen.findByText(/请前往设置/)).toBeInTheDocument();
    expect(screen.getByText("推理失败")).toBeInTheDocument();
    expect(screen.queryByText(/等待本地区分/)).not.toBeInTheDocument();
    await act(async () => { client.setQueryData(["voice-diarization-model"], { ready: true }); });
    mocks.diarizationStart.mockResolvedValue({ ...snapshot, status: "pending", error: null });
    fireEvent.click(await screen.findByRole("button", { name: "重试说话人区分" }));
    expect(await screen.findByText("等待本地区分说话人（本地转写优先）")).toBeInTheDocument();
    expect(mocks.diarizationStart).toHaveBeenCalledWith({ scope: "workspace", recordId: 7 });
  });

  it("polls a running job to an empty ready result and then stops", async () => {
    vi.useFakeTimers();
    const snapshot = { sessionId: "session-one", revision: 1, status: "running", error: null, speakers: [], turns: [] };
    mocks.diarizationGet.mockResolvedValue(snapshot);
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("正在本地区分说话人…")).toBeInTheDocument();
    mocks.diarizationGet.mockResolvedValue({ ...snapshot, status: "ready", revision: 2 });
    await act(() => vi.advanceTimersByTimeAsync(1010));
    expect(screen.getByText("未检测到说话人")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.diarizationGet).toHaveBeenCalledTimes(2);
  });

  it("confirms an automatic contact match and preserves selection across CAS failure", async () => {
    const snapshot = { sessionId: "session-one", revision: 1, status: "ready", error: null,
      speakers: [{ id: 1, name: "小明", contactId: 9, association: "automatic", voiceprintReady: false }], turns: [] };
    mocks.diarizationGet.mockResolvedValue(snapshot);
    mocks.speakerLinkContact.mockRejectedValue(new Error("关联版本冲突"));
    mocks.contactSearch.mockResolvedValue([{ id: 10, name: "小红", email: "", role: "", department: "", employeeId: "" }]);
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    expect(await screen.findByText("自动匹配联系人：小明")).toBeInTheDocument();
    expect(screen.getByText("声音样本不足，仅关联本次记录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择联系人" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索已有联系人" }), { target: { value: "红" } });
    fireEvent.click(await screen.findByRole("option", { name: /小红/ }));
    mocks.diarizationGet.mockResolvedValue({ ...snapshot, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "确认关联本次记录" }));
    expect(await screen.findByText("关联版本冲突")).toBeInTheDocument();
    await waitFor(() => expect(mocks.diarizationGet).toHaveBeenCalledTimes(2));
    mocks.speakerLinkContact.mockResolvedValue({ ...snapshot, revision: 3, speakers: [{ ...snapshot.speakers[0], name: "小红", contactId: 10, association: "confirmed" }] });
    fireEvent.click(screen.getByRole("button", { name: "确认关联本次记录" }));
    await waitFor(() => expect(mocks.speakerLinkContact).toHaveBeenLastCalledWith({ target: { scope: "workspace", recordId: 7 }, speakerId: 1, contactId: 10, expectedRevision: 2 }));
    expect(await screen.findByText("已关联联系人：小红")).toBeInTheDocument();
  });

  it("requires confirmation to remember a matched voice and supports unlinking", async () => {
    const snapshot = { sessionId: "session-one", revision: 1, status: "ready", error: null,
      speakers: [{ id: 1, name: "小明", contactId: 9, association: "automatic", voiceprintReady: true }], turns: [] };
    mocks.diarizationGet.mockResolvedValue(snapshot);
    mocks.speakerLinkContact.mockResolvedValue({ ...snapshot, revision: 2, speakers: [{ ...snapshot.speakers[0], association: "confirmed" }] });
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    const confirm = await screen.findByRole("button", { name: "确认并记住声音" });
    expect(mocks.speakerLinkContact).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(await screen.findByText("已关联联系人：小明")).toBeInTheDocument();
    mocks.speakerLinkContact.mockResolvedValue({ ...snapshot, revision: 3, speakers: [{ ...snapshot.speakers[0], name: "说话人 1", contactId: null, association: null }] });
    fireEvent.click(screen.getByRole("button", { name: "解除联系人关联" }));
    await waitFor(() => expect(mocks.speakerLinkContact).toHaveBeenLastCalledWith({ target: { scope: "workspace", recordId: 7 }, speakerId: 1, contactId: null, expectedRevision: 2 }));
    await waitFor(() => expect(screen.queryByText("已关联联系人：小明")).not.toBeInTheDocument());
  });

  it("shows contact search failures and retries without treating them as empty results", async () => {
    mocks.diarizationGet.mockResolvedValue({ sessionId: "session-one", revision: 1, status: "ready", error: null,
      speakers: [{ id: 1, name: "说话人 1", contactId: null, association: null, voiceprintReady: true }], turns: [] });
    mocks.contactSearch.mockRejectedValue(new Error("搜索不可用"));
    render(<QueryClientProvider client={new QueryClient()}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "选择联系人" }));
    expect(await screen.findByText(/联系人加载失败：Error: 搜索不可用/)).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的联系人。")).not.toBeInTheDocument();
    mocks.contactSearch.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "重试搜索联系人" }));
    expect(await screen.findByText("没有匹配的联系人。")).toBeInTheDocument();
  });

  it.each(["recording", "paused"])("refreshes a visible %s recording after another window ends it, then stops polling", async (phase) => {
    vi.useFakeTimers();
    const saved = await mocks.playbackGet();
    mocks.playbackGet.mockClear().mockResolvedValue({ ...saved, phase, chunks: [] });
    mocks.transcriptList.mockResolvedValue({ segments: [{ id: "first", startMs: 0, endMs: 500, text: "录制中的转写", language: "zh" }], nextCursor: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} />
    </QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("录制尚未结束")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "播放录音" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "转写" }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("录制中的转写")).toBeInTheDocument();

    // The resident panel receives no local action or query invalidation from the caption window.
    mocks.playbackGet.mockResolvedValue(saved);
    mocks.minutesGet.mockResolvedValue({ sessionId: "session-one", version: 2, content: "## 自动收尾纪要", status: "pending", error: null });
    mocks.recoveryGet.mockResolvedValue([{ id: 3, startMs: 0, endMs: 6000, cursorMs: 0, status: "pending", error: null }]);
    mocks.transcriptList.mockResolvedValue({ segments: [{ id: "final", startMs: 0, endMs: 60000, text: "结束后保存的最终转写", language: "zh" }], nextCursor: null });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(screen.getByText("正在生成纪要…")).toBeInTheDocument();
    expect(screen.getByText(/等待补转写/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放录音" })).toBeEnabled();
    expect(screen.getByText("结束后保存的最终转写")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.playbackGet).toHaveBeenCalledTimes(2);
    const transcriptCalls = mocks.transcriptList.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.playbackGet).toHaveBeenCalledTimes(2);
    expect(mocks.transcriptList).toHaveBeenCalledTimes(transcriptCalls);
    fireEvent.click(screen.getByRole("button", { name: "播放录音" }));
    expect(mocks.play).toHaveBeenCalledOnce();
    view.unmount();
    queryClient.clear();
  });

  it("does not poll an active recording while its resident panel is hidden", async () => {
    vi.useFakeTimers();
    mocks.playbackGet.mockResolvedValue({ sessionId: "session-one", phase: "recording", chunks: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = (visible: boolean) => <QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} visible={visible} />
    </QueryClientProvider>;
    const view = render(panel(true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(mocks.playbackGet).toHaveBeenCalledOnce();
    view.rerender(panel(false));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.playbackGet).toHaveBeenCalledOnce();
    view.rerender(panel(true));
    await act(() => vi.advanceTimersByTimeAsync(1_010));
    expect(mocks.playbackGet.mock.calls.length).toBeGreaterThan(1);
    view.unmount();
    queryClient.clear();
  });

  it("shows one combined transport with seeking and playback speed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("region", { name: "录音播放" })).toBeInTheDocument();
    expect(screen.getByLabelText("录音进度")).toHaveAttribute("max", "60000");
    expect(screen.getByRole("combobox", { name: "播放倍速" })).toHaveValue("1");
    expect(screen.queryByText("麦克风")).not.toBeInTheDocument();
    expect(screen.queryByText("系统声音")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "播放录音" }));
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.playbackGet).toHaveBeenCalledWith({ scope: "workspace", recordId: 7 });
    view.unmount();
  });

  it("source navigation waits for audio readiness, seeks milliseconds, and never autoplays", async () => {
    let loaded!: () => void;
    mocks.load.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} sourceTimeMs={1250} sourceNavigationKey="source-one" />
    </QueryClientProvider>);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    expect(mocks.seek).not.toHaveBeenCalled();
    loaded();
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(1.25));
    expect(mocks.pause.mock.invocationCallOrder[0]).toBeLessThan(mocks.seek.mock.invocationCallOrder[0]);
    expect(mocks.play).not.toHaveBeenCalled();
    expect(screen.getByLabelText("录音进度")).toHaveValue("1250");
    view.unmount();
  });

  it("source navigation defers hidden resident changes and seeks a second timestamp when visible", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = (visible: boolean, time: number) => <QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} visible={visible} sourceTimeMs={time} sourceNavigationKey={`source-${time}`} />
    </QueryClientProvider>;
    const view = render(panel(true, 5000));
    await waitFor(() => expect(mocks.seek).toHaveBeenCalledWith(5));
    const calls = mocks.seek.mock.calls.length;
    view.rerender(panel(false, 11000));
    expect(mocks.seek).toHaveBeenCalledTimes(calls);
    view.rerender(panel(true, 11000));
    await waitFor(() => expect(mocks.seek).toHaveBeenLastCalledWith(11));
    expect(mocks.play).not.toHaveBeenCalled();
    view.unmount();
  });

  it("source navigation reports an unavailable timestamp without silently clamping it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} sourceTimeMs={90000} />
    </QueryClientProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("来源时间点已超出当前录音范围");
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(mocks.play).not.toHaveBeenCalled();
    view.unmount();
  });

  it("shows the saved minutes and lets the user request an update", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}><VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} /></QueryClientProvider>);
    expect(await screen.findByRole("region", { name: "会议纪要" })).toHaveTextContent("讨论了发布计划。");
    fireEvent.click(screen.getByRole("button", { name: "生成纪要" }));
    expect(mocks.minutesGenerate).toHaveBeenCalledWith(expect.objectContaining({ target: { scope: "workspace", recordId: 7 } }));
    view.unmount();
  });

  it("announces authoritative committed versions including the first snapshot, without treating a title as a draft", async () => {
    const committed = vi.fn();
    const target = { scope: "workspace" as const, recordId: 7 };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const snapshot = { sessionId: "session-one", version: 1, title: "AI title", content: "## 摘要\n纪要", status: "ready", error: null };
    mocks.minutesGet.mockResolvedValue(snapshot);
    const panel = (ready: boolean) => <QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={target} onMinutesCommitted={ready ? committed : undefined} />
    </QueryClientProvider>;
    const view = render(panel(false));
    await screen.findByText("纪要");
    expect(committed).not.toHaveBeenCalled();
    view.rerender(panel(true));
    await waitFor(() => expect(committed).toHaveBeenCalledTimes(1));
    act(() => { queryClient.setQueryData(["voice-minutes", target], { ...snapshot, status: "running", preview: "## 摘要\n新预览" }); });
    expect(committed).toHaveBeenCalledTimes(1);
    act(() => { queryClient.setQueryData(["voice-minutes", target], { ...snapshot, version: 2 }); });
    await waitFor(() => expect(committed).toHaveBeenCalledTimes(2));
    view.rerender(panel(true));
    expect(committed).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("copies the current minutes snapshot into the editable body on request", async () => {
    const copy = vi.fn(async () => undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} onCopyMinutes={copy} />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "复制到正文" }));
    expect(copy).toHaveBeenCalledWith("## 摘要\n讨论了发布计划。");
    view.unmount();
  });

  it("shows provisional minutes while generating and keeps copying disabled until complete", async () => {
    mocks.minutesGet.mockResolvedValue({ sessionId: "session-one", version: 1, content: "## 摘要\n旧纪要", preview: "## 摘要\n逐步生成的纪要", status: "running", error: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} onCopyMinutes={vi.fn()} />
    </QueryClientProvider>);
    expect(await screen.findByText("逐步生成的纪要")).toBeInTheDocument();
    expect(screen.queryByText("旧纪要")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制到正文" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成纪要" })).toBeDisabled();
    view.unmount();
  });

  it("shows the missing interval and lets the user retry failed recovery", async () => {
    mocks.recoveryGet.mockResolvedValue([{ id: 3, startMs: 1000, endMs: 6000, cursorMs: 1000, status: "failed", error: "连接超时" }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={queryClient}>
      <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} />
    </QueryClientProvider>);
    expect(await screen.findByText(/0:01–0:06：补转写失败：连接超时/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试补转写" }));
    await waitFor(() => expect(mocks.recoveryRetry).toHaveBeenCalledWith({ scope: "workspace", recordId: 7 }));
    view.unmount();
  });

  it("pages Transcript by stable cursor and seeks the shared player", async () => {
    mocks.transcriptList
      .mockResolvedValueOnce({
        segments: [{ id: "first", startMs: 1_000, endMs: 1_500, text: "第一句", language: "zh" }],
        nextCursor: { startMs: 1_000, id: "first" },
      })
      .mockResolvedValueOnce({
        segments: [{ id: "second", startMs: 2_000, endMs: 2_500, text: "第二句", language: "zh" }],
        nextCursor: null,
      });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <VoiceRecordPanel target={{ scope: "workspace", recordId: 7 }} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "转写" }));
    fireEvent.click(await screen.findByRole("button", { name: /第一句/ }));
    expect(mocks.seek).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("button", { name: /第二句/ })).toBeInTheDocument();
    expect(mocks.transcriptList).toHaveBeenCalledWith({
      target: { scope: "workspace", recordId: 7 },
      after: { startMs: 1_000, id: "first" },
      limit: 100,
    });
  });
});
