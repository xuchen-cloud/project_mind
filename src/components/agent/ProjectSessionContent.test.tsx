import { useEffect } from 'react';
import type { DshConversationHostProps } from '@project-mind/dsh-ui/adapters';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor, screen, fireEvent } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectSessionContent } from './ProjectSessionContent';
import { requestDshFileReference, setDshWorkspaceRoot, useDshFileReferences } from '../../lib/dsh-host-events';
import type { AgentSourceRef } from '../../lib/agent-types';
import { useProjectFileNavigation } from '../../lib/project-file-navigation';
const fixture = vi.hoisted(() => ({ command: vi.fn(), insert: vi.fn(), hosts: [] as DshConversationHostProps[] }));
vi.mock('../../services/desktopApi', () => ({ desktopApi: { command: fixture.command } }));
vi.mock('@project-mind/dsh-ui/adapters', () => ({
  insertDshFileReference: fixture.insert,
  DshConversationHost: (props: DshConversationHostProps) => {
    fixture.hosts.push(props);
    useEffect(() => { props.onReady?.(); }, []);
    return <div data-testid={props.sessionId} data-focused={props.focused} />;
  },
}));
beforeEach(() => {
  fixture.command.mockReset().mockImplementation(async (command, args) => command === 'dsh_assistant_select_session' ? args.sessionId : undefined);
  fixture.insert.mockReset().mockResolvedValue(undefined); fixture.hosts = [];
  setDshWorkspaceRoot(null); setDshWorkspaceRoot('/workspace');
});
it('opens two explicit Sessions, drains only addressed references, and unmounts hidden heavy UI without stopping', async () => {
  const client = new QueryClient();
  const shell = (visible = true) => <QueryClientProvider client={client}>
    <ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="a" visible={visible} focused={false} />
    <ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="b" visible focused />
  </QueryClientProvider>;
  const view = render(shell());
  await screen.findByTestId('a'); await screen.findByTestId('b');
  expect(screen.getByTestId('a')).toHaveAttribute('data-focused', 'false');
  act(() => requestDshFileReference(1, 'a.md', 'a'));
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(1, 'a', 'a.md', undefined));
  expect(fixture.insert).toHaveBeenCalledTimes(1);
  view.rerender(shell(false));
  expect(screen.queryByTestId('a')).toBeNull();
  act(() => requestDshFileReference(1, 'later.md', 'a'));
  expect(useDshFileReferences.getState().pending).toHaveLength(1);
  view.rerender(shell());
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(1, 'a', 'later.md', undefined));
  view.unmount();
  expect(fixture.command.mock.calls.some(([name]) => name.includes('stop') || name.includes('delete'))).toBe(false);
});

it('keeps fixed source and origin Session through insertion and message navigation', async () => {
  const sourceRef: AgentSourceRef = { object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 1 }, kind: 'file', id: '9' }, revision: 'sha256:old', fileVersion: 1, recordVersion: null, blockId: null, locator: { kind: 'line', start: 2, end: 3 }, title: 'old.md', excerpt: '' };
  const view = render(<QueryClientProvider client={new QueryClient()}><ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="fixed-session" visible focused /></QueryClientProvider>);
  await screen.findByTestId('fixed-session');
  act(() => requestDshFileReference(1, 'renamed.md', 'fixed-session', sourceRef));
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(1, 'fixed-session', 'renamed.md', sourceRef));
  act(() => fixture.hosts.at(-1)!.onFileOpen?.('old.md', 2, sourceRef));
  expect(useProjectFileNavigation.getState().request).toEqual({ projectId: 1, path: 'old.md', line: 2, originSessionId: 'fixed-session', sourceRef });
  view.unmount();
});

it('retains failed insertion and target until explicit retry succeeds, without retrying on visibility changes', async () => {
  let reject!: (error: Error) => void;
  fixture.insert.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const client = new QueryClient();
  const shell = (visible = true) => <QueryClientProvider client={client}><ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="retry-session" visible={visible} focused /></QueryClientProvider>;
  const view = render(shell());
  await screen.findByTestId('retry-session');
  act(() => requestDshFileReference(1, 'selected.md', 'retry-session'));
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledTimes(1));
  expect(useDshFileReferences.getState().pending).toHaveLength(1);
  await act(async () => reject(new Error('fixed snapshot unavailable')));
  expect(await screen.findByRole('alert')).toHaveTextContent('fixed snapshot unavailable');
  expect(useDshFileReferences.getState().pending[0]).toMatchObject({ path: 'selected.md', sessionId: 'retry-session' });
  view.rerender(shell(false)); view.rerender(shell());
  expect(fixture.insert).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重试引用' }));
  await waitFor(() => expect(useDshFileReferences.getState().pending).toHaveLength(0));
  expect(fixture.insert).toHaveBeenCalledTimes(2);
  expect(fixture.insert).toHaveBeenLastCalledWith(1, 'retry-session', 'selected.md', undefined);
  view.unmount();
});
