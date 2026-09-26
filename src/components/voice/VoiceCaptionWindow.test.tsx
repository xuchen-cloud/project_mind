import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshotGet: vi.fn(),
  transcriptTail: vi.fn(),
  settingsGet: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  end: vi.fn(),
  setSize: vi.fn(),
  close: vi.fn(),
  onCloseRequested: vi.fn(),
}));
vi.mock("../../services/voiceApi", () => ({ voiceApi: {
  snapshotGet: mocks.snapshotGet,
  transcriptTail: mocks.transcriptTail,
  settingsGet: mocks.settingsGet,
  pause: mocks.pause,
  resume: mocks.resume,
  end: mocks.end,
} }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: {
  captionWindowTrackPosition: vi.fn(async () => () => undefined),
  captionWindowSetSize: mocks.setSize,
  captionWindowClose: mocks.close,
  captionWindowOnCloseRequested: mocks.onCloseRequested,
} }));

import { VoiceCaptionWindow } from "./VoiceCaptionWindow";

beforeEach(() => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: "讨论中" });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: "one", text: "已确认。", startMs: 0, endMs: 500 }]);
  mocks.settingsGet.mockReset().mockResolvedValue({ captionLines: 4, speechProfile: { kind: "paraformer" } });
  mocks.pause.mockReset().mockResolvedValue({ sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234 });
  mocks.resume.mockReset();
  mocks.end.mockReset();
  mocks.setSize.mockReset().mockResolvedValue(undefined);
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
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  const view = render(<VoiceCaptionWindow />);
  expect(await screen.findByText("已暂停")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始录音" })).toBeInTheDocument();
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("closes itself when the recording has ended", async () => {
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 5, phase: "ended", activeMs: 1234, interimText: null });
  const view = render(<VoiceCaptionWindow />);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("closes when ending a paused recording from the floating controls", async () => {
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  mocks.end.mockResolvedValue({ sessionId: "s1", revision: 5, phase: "ended", activeMs: 1234 });
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "结束录音" }));
  await waitFor(() => expect(mocks.end).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 4 })));
  await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  view.unmount();
});

it("closes after ending from the floating controls even when the next status refresh stalls", async () => {
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: null });
  mocks.end.mockResolvedValue({ sessionId: "s1", revision: 4, phase: "ended", activeMs: 1234 });
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
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 4, phase: "paused", activeMs: 1234, interimText: null });
  mocks.resume.mockResolvedValue({ sessionId: "s1", revision: 5, phase: "recording", activeMs: 1234 });
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "开始录音" }));
  await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 4 })));
  view.unmount();
});

it("keeps audio-only recording in the compact control window", async () => {
  mocks.settingsGet.mockResolvedValue({ captionLines: 4, speechProfile: null });
  mocks.transcriptTail.mockResolvedValue([]);
  mocks.snapshotGet.mockResolvedValue({ sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: null });
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
  await waitFor(() => expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: "s1", limit: 4 }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  view.unmount();
});
