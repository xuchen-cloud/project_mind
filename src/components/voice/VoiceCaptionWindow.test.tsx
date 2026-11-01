import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onLivePacket: undefined as undefined | ((message: unknown) => void),
  snapshotGet: vi.fn(),
  transcriptTail: vi.fn(),
  settingsGet: vi.fn(),
  liveTranscriptionSet: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  end: vi.fn(),
  setSize: vi.fn(),
  openRecord: vi.fn(),
  close: vi.fn(),
  onCloseRequested: vi.fn(),
}));
vi.mock("../../services/voiceApi", () => ({ voiceApi: {
  snapshotGet: mocks.snapshotGet,
  transcriptTail: mocks.transcriptTail,
  settingsGet: mocks.settingsGet,
  liveTranscriptionSet: mocks.liveTranscriptionSet,
  pause: mocks.pause,
  resume: mocks.resume,
  end: mocks.end,
} }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { listenEvent: vi.fn(async (_event, callback) => { mocks.onLivePacket = callback; return () => {}; }), emitEvent: vi.fn(async () => {}),
  captionWindowTrackPosition: vi.fn(async () => () => undefined),
  captionWindowSetSize: mocks.setSize,
  captionWindowClose: mocks.close,
  captionWindowOpenRecord: mocks.openRecord,
  captionWindowOnCloseRequested: mocks.onCloseRequested,
} }));

import { VoiceCaptionWindow } from "./VoiceCaptionWindow";

const liveFields = { liveTranscriptionEnabled: true, liveTranscriptionDegraded: false, activityWarning: null, projectId: null };
beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.snapshotGet.mockReset().mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: "讨论中" });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: "one", text: "已确认。", startMs: 0, endMs: 500 }]);
  mocks.settingsGet.mockReset().mockResolvedValue({ liveTranscriptionEnabled: true, captionLines: 4, speechProfile: { kind: "paraformer", endpoint: "wss://example.test", model: "paraformer-realtime-v2", credentialProfileId: 1 } });
  mocks.liveTranscriptionSet.mockReset();
  mocks.pause.mockReset().mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234 });
  mocks.resume.mockReset();
  mocks.end.mockReset();
  mocks.setSize.mockReset().mockResolvedValue(undefined);
  mocks.openRecord.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.onCloseRequested.mockReset().mockResolvedValue(() => undefined);
});

it("controls the same recording and keeps provisional text separate from final captions", async () => {
  const view = render(<VoiceCaptionWindow />);
  expect(await screen.findByText("已确认。")).toBeInTheDocument();
  expect(screen.getByLabelText("临时字幕")).toHaveTextContent("讨论中");
  fireEvent.click(screen.getByRole("button", { name: "暂停录音" }));
  await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 3 })));
  view.unmount();
});

it("collapses the independent window while recording continues", async () => {
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "折叠字幕" }));
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(190, 48));
  await waitFor(() => expect(screen.queryByText("已确认。")).not.toBeInTheDocument());
  expect(screen.getByLabelText("录音时间")).toHaveTextContent("0:01");
  expect(screen.getByRole("button", { name: "暂停录音" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "结束录音" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开字幕" })).toHaveClass("voice-caption-icon-button");
  expect(screen.getByRole("button", { name: "暂停录音" })).toHaveClass("voice-caption-icon-button");
  expect(screen.getByRole("button", { name: "暂停录音" }).textContent).toBe("");
  expect(screen.getByRole("button", { name: "结束录音" }).textContent).toBe("");
  expect(screen.getByRole("img", { name: "正在录音" })).toBeInTheDocument();
  expect(screen.queryByText("正在录音")).not.toBeInTheDocument();
  expect(screen.queryByText("实时字幕")).not.toBeInTheDocument();
  expect(mocks.pause).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "展开字幕" }));
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(680, 220));
  expect(await screen.findByText("已确认。")).toBeInTheDocument();
  view.unmount();
});

it("collapses when the window close control is used", async () => {
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "关闭浮窗" }));
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(190, 48));
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("treats an OS close request as a collapse while recording", async () => {
  const view = render(<VoiceCaptionWindow />);
  await screen.findByRole("button", { name: "折叠字幕" });
  const shouldClose = mocks.onCloseRequested.mock.calls[0][0] as () => boolean;
  act(() => { expect(shouldClose()).toBe(false); });
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(190, 48));
  view.unmount();
});

it("keeps the latest caption in view", async () => {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 640 });
  try {
    const view = render(<VoiceCaptionWindow />);
    const list = await screen.findByRole("list", { name: "实时字幕" });
    const scroll = list.parentElement as HTMLDivElement;
    await waitFor(() => expect(scroll.scrollTop).toBe(640));
    view.unmount();
  } finally {
    if (height) Object.defineProperty(HTMLElement.prototype, "scrollHeight", height);
    else delete (HTMLElement.prototype as HTMLElement & { scrollHeight?: number }).scrollHeight;
  }
});

it("closes itself after the recording ends in the main window", async () => {
  mocks.snapshotGet.mockResolvedValue(null);
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("remains visible while the recording is paused", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  const view = render(<VoiceCaptionWindow />);
  expect(await screen.findByText("已暂停")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始录音" })).toBeInTheDocument();
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("closes itself when the recording has ended", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 5, phase: "ended", activeMs: 1234, interimText: null });
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("closes when ending a paused recording from the floating controls", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  mocks.end.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 5, phase: "ended", activeMs: 1234 });
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));
  await waitFor(() => expect(mocks.end).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 4 })));
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("closes after ending from the floating controls even when the next status refresh stalls", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: null });
  mocks.end.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "ended", activeMs: 1234 });
  const view = render(<VoiceCaptionWindow />);
  const endButton = await screen.findByRole("button", { name: "结束录音" });
  mocks.snapshotGet.mockImplementation(() => new Promise(() => undefined));
  fireEvent.click(endButton);
  await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("closes an orphaned window when the initial session lookup fails", async () => {
  mocks.snapshotGet.mockRejectedValue(new Error("workspace unavailable"));
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("resumes a paused recording from the floating controls", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  mocks.resume.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 5, phase: "recording", activeMs: 1234 });
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "开始录音" }));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 4 })));
  view.unmount();
});

it("keeps audio-only recording in the compact control window", async () => {
  mocks.settingsGet.mockResolvedValue({ liveTranscriptionEnabled: true, captionLines: 4, speechProfile: null });
  mocks.transcriptTail.mockResolvedValue([]);
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: null });
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(160, 48));
  expect(screen.getByRole("button", { name: "暂停录音" })).toBeInTheDocument();
  expect(screen.getByLabelText("录音时间")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "展开字幕" })).not.toBeInTheDocument();
  expect(screen.queryByText("正在录音")).not.toBeInTheDocument();
  expect(mocks.transcriptTail).not.toHaveBeenCalled();
  view.unmount();
});

it("starts compact before settings load when the window was opened for audio only", async () => {
  const previousUrl = window.location.href;
  window.history.replaceState({}, "", "/voice.html?audioOnly=1");
  mocks.settingsGet.mockImplementation(() => new Promise(() => undefined));
  try {
    const view = render(<VoiceCaptionWindow />);
    expect(screen.queryByRole("button", { name: "展开字幕" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "折叠字幕" })).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "暂停录音" });
    expect(mocks.transcriptTail).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    window.history.replaceState({}, "", previousUrl);
  }
});

it("requests a supported caption count while showing the latest lines", async () => {
  mocks.transcriptTail.mockImplementation(async ({ limit }: { limit: number }) => {
    if (limit < 2 || limit > 8) throw new Error("caption line count must be between 2 and 8");
    return [];
  });
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: "s1", limit: 8 }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.unmount();
});

it("keeps a local recognition error visible in expanded and compact recording controls", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, recognitionError: "local inference failed" });
  const view = render(<VoiceCaptionWindow />);
  expect(await screen.findByRole("alert")).toHaveTextContent("实时转写已中断，录音继续保存。local inference failed");
  fireEvent.click(screen.getByRole("button", { name: "折叠字幕" }));
  expect(await screen.findByRole("img", { name: "转写已中断，录音继续" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "结束录音" })).toBeInTheDocument();
  view.unmount();
});


afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("never overlaps snapshot or tail calls when a caption refresh is slow", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  mocks.transcriptTail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<VoiceCaptionWindow />);
  await act(() => vi.advanceTimersByTimeAsync(10));
  const initialSnapshots = mocks.snapshotGet.mock.calls.length;
  expect(initialSnapshots).toBeLessThanOrEqual(2);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.snapshotGet).toHaveBeenCalledTimes(initialSnapshots);
  expect(mocks.transcriptTail).toHaveBeenCalledOnce();
  await act(async () => { finish([]); });
  view.unmount();
});

it("exposes polling failures in compact controls while keeping recording controls usable", async () => {
  vi.useFakeTimers();
  const view = render(<VoiceCaptionWindow />);
  await act(() => vi.advanceTimersByTimeAsync(10));
  fireEvent.click(screen.getByRole("button", { name: "折叠字幕" }));
  await act(() => vi.advanceTimersByTimeAsync(10));
  mocks.snapshotGet.mockRejectedValue(new Error("snapshot offline"));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByRole("img", { name: "语音状态更新失败" })).toHaveAttribute("title", "Error: snapshot offline");
  expect(screen.getByRole("button", { name: "暂停录音" })).toBeEnabled();
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("toggles inference without pausing and blocks repeated clicks while the change is pending", async () => {
  let finish!: (value: unknown) => void;
  mocks.liveTranscriptionSet.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<VoiceCaptionWindow />);
  const toggle = await screen.findByRole("button", { name: "关闭实时转写" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(toggle).toBeDisabled();
  expect(mocks.liveTranscriptionSet).toHaveBeenCalledTimes(1);
  expect(mocks.liveTranscriptionSet).toHaveBeenCalledWith({ sessionId: "s1", expectedRevision: 3, enabled: false });
  await act(async () => finish({ ...liveFields, sessionId: "s1", revision: 4, phase: "recording", activeMs: 1234, liveTranscriptionEnabled: false }));
  expect(await screen.findByRole("button", { name: "开启实时转写" })).toBeEnabled();
  expect(mocks.pause).not.toHaveBeenCalled();
  mocks.liveTranscriptionSet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 5, phase: "recording", activeMs: 1234, liveTranscriptionEnabled: true });
  fireEvent.click(screen.getByRole("button", { name: "开启实时转写" }));
  expect(await screen.findByRole("button", { name: "关闭实时转写" })).toBeEnabled();
  expect(mocks.liveTranscriptionSet).toHaveBeenLastCalledWith({ sessionId: "s1", expectedRevision: 4, enabled: true });
  view.unmount();
});

it("keeps inference disabled when an older in-flight poll completes after the manual toggle", async () => {
  vi.useFakeTimers();
  const view = render(<VoiceCaptionWindow />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  let finishOld!: (value: unknown) => void;
  mocks.snapshotGet.mockImplementation(() => new Promise(resolve => { finishOld = resolve; }));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  mocks.liveTranscriptionSet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 4, phase: "recording", activeMs: 2234, liveTranscriptionEnabled: false });
  fireEvent.click(screen.getByRole("button", { name: "关闭实时转写" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("button", { name: "开启实时转写" })).toBeEnabled();
  await act(async () => finishOld({ ...liveFields, sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234 }));
  expect(screen.getByRole("button", { name: "开启实时转写" })).toBeEnabled();
  expect(mocks.pause).not.toHaveBeenCalled();
  view.unmount();
});

it("updates the expanded inference control from a settings publication", async () => {
  const view = render(<VoiceCaptionWindow />);
  await screen.findByRole("button", { name: "关闭实时转写" });
  await act(async () => mocks.onLivePacket?.({ origin: "settings", type: "changed", packet: { session: { ...liveFields, sessionId: "s1", revision: 4, phase: "recording", activeMs: 1234, liveTranscriptionEnabled: false }, captions: null } }));
  expect(screen.getByRole("button", { name: "开启实时转写" })).toBeEnabled();
  expect(mocks.liveTranscriptionSet).not.toHaveBeenCalled();
  view.unmount();
});

it("discards a toggle result belonging to the previous recording", async () => {
  let finish!: (value: unknown) => void;
  mocks.liveTranscriptionSet.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "关闭实时转写" }));
  await act(async () => mocks.onLivePacket?.({ origin: "main", type: "changed", packet: { session: { ...liveFields, sessionId: "s2", revision: 1, phase: "recording", activeMs: 9000 }, captions: null } }));
  await act(async () => finish({ ...liveFields, sessionId: "s1", revision: 4, phase: "recording", activeMs: 1234, liveTranscriptionEnabled: false }));
  expect(screen.getByLabelText("录音时间")).toHaveTextContent("0:09");
  expect(screen.getByRole("button", { name: "关闭实时转写" })).toBeEnabled();
  view.unmount();
});

it("opens the saved record before publishing stop or closing the external window", async () => {
  const ended = { ...liveFields, sessionId: "s1", revision: 4, phase: "ended", activeMs: 1234, projectId: 7, projectNoteId: 42 };
  mocks.end.mockResolvedValue(ended);
  let finishOpen!: () => void;
  mocks.openRecord.mockImplementation(() => new Promise<void>(resolve => { finishOpen = resolve; }));
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));
  await waitFor(() => expect(mocks.openRecord).toHaveBeenCalledWith(ended));
  await act(async () => mocks.onLivePacket?.({ origin: "main", type: "changed", packet: { session: null, captions: null } }));
  expect(mocks.close).not.toHaveBeenCalled();
  await act(async () => finishOpen());
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.openRecord.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
  view.unmount();
});

it("keeps the recording controls and does not open a saved record if stopping fails", async () => {
  mocks.end.mockRejectedValue(new Error("audio save failed"));
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("audio save failed");
  expect(mocks.openRecord).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("retains a saved record and retries navigation without stopping again when main focus fails", async () => {
  const ended = { ...liveFields, sessionId: "s1", revision: 4, phase: "ended", activeMs: 1234, projectId: 7, projectNoteId: 42 };
  mocks.end.mockResolvedValue(ended);
  mocks.openRecord.mockRejectedValueOnce(new Error("main focus failed")).mockResolvedValue(undefined);
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("main focus failed");
  expect(screen.getByText("录音已保存")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "结束录音" })).toBeDisabled();
  await act(async () => mocks.onLivePacket?.({ origin: "main", type: "changed", packet: { session: null, captions: null } }));
  expect(mocks.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开记录" }));
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.openRecord).toHaveBeenNthCalledWith(2, ended);
  view.unmount();
});

it("shows pending audio save accurately and disables all recording and inference commands", async () => {
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 9, phase: "ending", activeMs: 1234, pauseReason: "保存待重试：磁盘空间不足" });
  const view = render(<VoiceCaptionWindow />);
  expect(await screen.findByText("音频待保存")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("保存待重试：磁盘空间不足");
  expect(screen.getByRole("button", { name: "暂停录音" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "结束录音" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "关闭实时转写" })).toBeDisabled();
  expect(screen.queryByText("正在录音")).not.toBeInTheDocument();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.openRecord).not.toHaveBeenCalled();
  view.unmount();
});

it("refreshes ending authority after save failure so another stop cannot be submitted", async () => {
  mocks.end.mockRejectedValue(new Error("audio save failed"));
  const view = render(<VoiceCaptionWindow />);
  const stop = await screen.findByRole("button", { name: "结束录音" });
  mocks.snapshotGet.mockResolvedValue({ ...liveFields, sessionId: "s1", revision: 9, phase: "ending", activeMs: 1234, pauseReason: "保存待重试" });
  fireEvent.click(stop);
  expect(await screen.findByText("音频待保存")).toBeInTheDocument();
  expect(stop).toBeDisabled();
  fireEvent.click(stop);
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.openRecord).not.toHaveBeenCalled();
  view.unmount();
});
