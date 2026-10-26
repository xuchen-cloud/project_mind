import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceFloatingPanel } from './VoiceFloatingPanel';

const mocks = vi.hoisted(() => ({ snapshotGet: vi.fn(), transcriptTail: vi.fn(), settingsGet: vi.fn(), start: vi.fn(), end: vi.fn(), pushToast: vi.fn(), openVoiceCaptionWindow: vi.fn(), closeVoiceCaptionWindow: vi.fn() }));
vi.mock('../../services/voiceApi', () => ({ voiceApi: {
  availabilityGet: async () => ({ implemented: true }),
  settingsGet: mocks.settingsGet,
  snapshotGet: mocks.snapshotGet,
  transcriptTail: mocks.transcriptTail,
  start: mocks.start,
  end: mocks.end,
} }));
vi.mock('../../state/feedback-store', () => ({ useFeedbackStore: () => ({ pushToast: mocks.pushToast }) }));
vi.mock('../../services/desktopApi', () => ({ desktopApi: { listenEvent: vi.fn(async () => () => {}), emitEvent: vi.fn(async () => {}), openVoiceCaptionWindow: mocks.openVoiceCaptionWindow, closeVoiceCaptionWindow: mocks.closeVoiceCaptionWindow } }));

beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.settingsGet.mockReset().mockResolvedValue({ captionLines: 4, speechProfile: { kind: 'paraformer' } });
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
  mocks.closeVoiceCaptionWindow.mockReset().mockResolvedValue(undefined);
});

it('closes the caption window as soon as ending succeeds, before record refresh completes', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 2, phase: 'recording', activeMs: 1000 });
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
  mocks.end.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 3, phase: 'ended', activeMs: 1000 });
  let finishRefresh!: () => void;
  const onChanged = vi.fn(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={onChanged} onOpenRecord={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '结束' }));
  await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(mocks.closeVoiceCaptionWindow).toHaveBeenCalledOnce();
  finishRefresh();
  view.unmount();
});

it('hides the idle start control without starting a recording', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue(null);
  mocks.start.mockReset();
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  await waitFor(() => expect(mocks.snapshotGet).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: '开始语音记录' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '语音录制控制' })).not.toBeInTheDocument();
  expect(mocks.start).not.toHaveBeenCalled();
  view.unmount();
});

it('shows the latest stable caption lines for the active session', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 1000 });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: 'segment-one', startMs: 0, endMs: 1000, text: '会议开始', language: 'zh' }]);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByText('会议开始')).toBeInTheDocument();
  expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: 'session-one', limit: 8 });
  view.unmount();
});

it('shows provisional text separately from saved captions', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 2000, interimText: '正在讲话' });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: 'final-one', startMs: 0, endMs: 1000, text: '已确认。', language: 'zh' }]);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByLabelText('临时字幕')).toHaveTextContent('正在讲话');
  expect(screen.getByText('已确认。')).toBeInTheDocument();
  expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: 'session-one', limit: 8 });
  view.unmount();
});

it('does not request captions in audio-only mode', async () => {
  mocks.settingsGet.mockResolvedValue({ captionLines: 4, speechProfile: null });
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 2000 });
  mocks.transcriptTail.mockReset();
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByText('录音中')).toBeInTheDocument();
  expect(mocks.transcriptTail).not.toHaveBeenCalled();
  view.unmount();
});

it('shows local recognition failure while audio recording continues', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 2000, recognitionError: 'local inference failed' });
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('实时转写已中断，录音继续保存。local inference failed');
  expect(screen.getByText('录音中')).toBeInTheDocument();
  view.unmount();
});


afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('does not overlap a slow snapshot poll and slows hidden polling to five seconds', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  let finish!: (value: unknown) => void;
  mocks.snapshotGet.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  await act(() => vi.advanceTimersByTimeAsync(10));
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.snapshotGet).toHaveBeenCalledOnce();
  await act(async () => { finish({ sessionId: 's', revision: 1, phase: 'recording', activeMs: 1000 }); });
  mocks.snapshotGet.mockResolvedValue({ sessionId: 's', revision: 1, phase: 'recording', activeMs: 1000 });
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.snapshotGet).toHaveBeenCalledOnce();
  expect(mocks.transcriptTail).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(mocks.snapshotGet).toHaveBeenCalledTimes(2);
  view.unmount();
});

it('reports a repeated caption failure once until a successful refresh clears it', async () => {
  vi.useFakeTimers();
  mocks.pushToast.mockClear();
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 's', revision: 1, phase: 'recording', activeMs: 1000 });
  mocks.transcriptTail.mockRejectedValue(new Error('tail offline'));
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  await act(() => vi.advanceTimersByTimeAsync(10));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByText('录音中')).toBeInTheDocument();
  expect(mocks.pushToast).toHaveBeenCalledOnce();
  mocks.transcriptTail.mockResolvedValue([]);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  mocks.transcriptTail.mockRejectedValue(new Error('tail offline'));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(mocks.pushToast).toHaveBeenCalledTimes(2);
  view.unmount();
});
