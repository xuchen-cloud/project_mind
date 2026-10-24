import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playbackGet: vi.fn(),
  recoveryGet: vi.fn(),
  recoveryRetry: vi.fn(),
  transcriptList: vi.fn(),
  minutesGet: vi.fn(),
  minutesGenerate: vi.fn(),
  toFileUrl: vi.fn((path: string) => `asset://${path}`),
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  seek: vi.fn(),
  load: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../../services/voiceApi", () => ({
  voiceApi: { recoveryGet: mocks.recoveryGet, recoveryRetry: mocks.recoveryRetry, playbackGet: mocks.playbackGet, transcriptList: mocks.transcriptList, minutesGet: mocks.minutesGet, minutesGenerate: mocks.minutesGenerate },
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: { toFileUrl: mocks.toFileUrl },
}));

vi.mock("../../lib/voice-player", () => ({
  VoicePlayer: class {
    duration = 60;
    position = 0;
    load() { return mocks.load(); }
    play() { return mocks.play(); }
    pause() { mocks.pause(); }
    seek(position: number) { mocks.seek(position); }
    setSpeed() {}
    dispose() {}
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

describe("VoiceRecordPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio);
    mocks.playbackGet.mockReset();
    mocks.recoveryGet.mockReset().mockResolvedValue([]);
    mocks.recoveryRetry.mockReset().mockResolvedValue(undefined);
    mocks.transcriptList.mockReset();
    mocks.minutesGet.mockReset().mockResolvedValue({ sessionId: "session-one", version: 1, content: "## 摘要\n讨论了发布计划。", status: "ready", error: null });
    mocks.minutesGenerate.mockReset().mockResolvedValue({ sessionId: "session-one", version: 1, content: "## 摘要\n讨论了发布计划。", status: "pending", error: null });
    mocks.toFileUrl.mockClear();
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
    mocks.transcriptList.mockResolvedValue({ segments: [{ id: "final", startMs: 0, endMs: 60000, text: "结束后保存的最终转写", language: "zh" }], nextCursor: null });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText("已保存")).toBeInTheDocument();
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
