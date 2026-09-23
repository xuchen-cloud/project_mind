import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  playbackGet: vi.fn(),
  transcriptList: vi.fn(),
  toFileUrl: vi.fn((path: string) => `asset://${path}`),
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  seek: vi.fn(),
}));

vi.mock("../../services/voiceApi", () => ({
  voiceApi: { playbackGet: mocks.playbackGet, transcriptList: mocks.transcriptList },
}));

vi.mock("../../services/desktopApi", () => ({
  desktopApi: { toFileUrl: mocks.toFileUrl },
}));

vi.mock("../../lib/voice-player", () => ({
  VoicePlayer: class {
    duration = 60;
    position = 0;
    async load() {}
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
    mocks.transcriptList.mockReset();
    mocks.toFileUrl.mockClear();
    mocks.play.mockClear();
    mocks.pause.mockClear();
    mocks.seek.mockClear();
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

  afterEach(() => vi.unstubAllGlobals());

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
