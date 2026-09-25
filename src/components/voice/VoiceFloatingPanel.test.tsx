import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
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
vi.mock('../../services/desktopApi', () => ({ desktopApi: { openVoiceCaptionWindow: mocks.openVoiceCaptionWindow, closeVoiceCaptionWindow: mocks.closeVoiceCaptionWindow } }));

beforeEach(() => {
  mocks.settingsGet.mockReset().mockResolvedValue({ captionLines: 4, speechProfile: { kind: 'paraformer' } });
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

it('opens the new recording only after the record cache has refreshed', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue(null);
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
  mocks.openVoiceCaptionWindow.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockResolvedValue({ sessionId: 'new-session', revision: 1, phase: 'recording', activeMs: 0, workspaceNoteId: 42 });
  mocks.pushToast.mockReset();
  let finishRefresh!: () => void;
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  const onChanged = vi.fn(() => refresh);
  const onOpenRecord = vi.fn();
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={onChanged} onOpenRecord={onOpenRecord} />);
  fireEvent.click(await screen.findByRole('button', { name: '开始语音记录' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(onOpenRecord).not.toHaveBeenCalled();
  finishRefresh();
  await waitFor(() => expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ workspaceNoteId: 42 })));
  await waitFor(() => expect(mocks.openVoiceCaptionWindow).toHaveBeenCalledOnce());
  view.unmount();
});

it('recovers the existing recording instead of reporting another owner when the floating control has stale state', async () => {
  const active = { sessionId: 'already-recording', revision: 3, phase: 'recording', activeMs: 30_000, workspaceNoteId: 17 };
  mocks.snapshotGet.mockReset().mockImplementation(async () => mocks.start.mock.calls.length ? active : null);
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
  mocks.start.mockReset().mockRejectedValue(new Error('another recording session already owns audio capture'));
  mocks.pushToast.mockReset();
  mocks.openVoiceCaptionWindow.mockReset().mockResolvedValue(undefined);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '开始语音记录' }));
  expect(await screen.findByRole('button', { name: '结束' })).toBeInTheDocument();
  expect(mocks.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '语音记录操作失败' }));
  await waitFor(() => expect(mocks.openVoiceCaptionWindow).toHaveBeenCalledOnce());
  view.unmount();
});

it('shows the latest stable caption lines for the active session', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 1000 });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: 'segment-one', startMs: 0, endMs: 1000, text: '会议开始', language: 'zh' }]);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByText('会议开始')).toBeInTheDocument();
  expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: 'session-one', limit: 4 });
  view.unmount();
});

it('shows provisional text separately from saved captions', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue({ sessionId: 'session-one', revision: 1, phase: 'recording', activeMs: 2000, interimText: '正在讲话' });
  mocks.transcriptTail.mockReset().mockResolvedValue([{ id: 'final-one', startMs: 0, endMs: 1000, text: '已确认。', language: 'zh' }]);
  const view = render(<VoiceFloatingPanel target={{ scope: 'workspace' }} targetLabel="Workspace" onChanged={vi.fn()} onOpenRecord={vi.fn()} />);
  expect(await screen.findByLabelText('临时字幕')).toHaveTextContent('正在讲话');
  expect(screen.getByText('已确认。')).toBeInTheDocument();
  expect(mocks.transcriptTail).toHaveBeenCalledWith({ sessionId: 'session-one', limit: 3 });
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
