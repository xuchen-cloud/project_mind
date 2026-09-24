import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { VoiceFloatingPanel } from './VoiceFloatingPanel';

const mocks = vi.hoisted(() => ({ snapshotGet: vi.fn(), transcriptTail: vi.fn() }));
vi.mock('../../services/voiceApi', () => ({ voiceApi: {
  availabilityGet: async () => ({ implemented: true }),
  settingsGet: async () => ({ captionLines: 4 }),
  snapshotGet: mocks.snapshotGet,
  transcriptTail: mocks.transcriptTail,
  start: async () => ({ phase: 'recording', activeMs: 0, workspaceNoteId: 42 }),
} }));
vi.mock('../../state/feedback-store', () => ({ useFeedbackStore: () => ({ pushToast: vi.fn() }) }));

it('opens the new recording only after the record cache has refreshed', async () => {
  mocks.snapshotGet.mockReset().mockResolvedValue(null);
  mocks.transcriptTail.mockReset().mockResolvedValue([]);
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
