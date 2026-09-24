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
  captionWindowSetSize: mocks.setSize,
  captionWindowClose: mocks.close,
  captionWindowOnCloseRequested: mocks.onCloseRequested,
} }));

import { VoiceCaptionWindow } from "./VoiceCaptionWindow";

beforeEach(() => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: "s1", revision: 3, phase: "recording", activeMs: 1234, interimText: "讨论中" });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: "one", text: "已确认。", startMs: 0, endMs: 500 }]);
  mocks.settingsGet.mockReset().mockResolvedValue({ captionLines: 4 });
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
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", expectedRevision: 3 })));
  view.unmount();
});

it("collapses the independent window while recording continues", async () => {
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "折叠字幕" }));
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(180, 72));
  await waitFor(() => expect(screen.queryByText("已确认。")).not.toBeInTheDocument());
  expect(mocks.pause).not.toHaveBeenCalled();
  view.unmount();
});

it("collapses when the window close control is used", async () => {
  const view = render(<VoiceCaptionWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "关闭浮窗" }));
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(180, 72));
  expect(mocks.close).not.toHaveBeenCalled();
  view.unmount();
});

it("treats an OS close request as a collapse while recording", async () => {
  const view = render(<VoiceCaptionWindow />);
  await screen.findByRole("button", { name: "折叠字幕" });
  const shouldClose = mocks.onCloseRequested.mock.calls[0][0] as () => boolean;
  act(() => { expect(shouldClose()).toBe(false); });
  await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(180, 72));
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
