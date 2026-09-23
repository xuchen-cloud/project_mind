import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { VoiceFloatingPanel } from './VoiceFloatingPanel';

vi.mock('../../services/voiceApi', () => ({ voiceApi: {
  availabilityGet: async () => ({ implemented: true }),
  snapshotGet: async () => null,
  start: async () => ({ phase: 'recording', activeMs: 0, workspaceNoteId: 42 }),
} }));
vi.mock('../../state/feedback-store', () => ({ useFeedbackStore: () => ({ pushToast: vi.fn() }) }));

it('opens the new recording only after the record cache has refreshed', async () => {
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
