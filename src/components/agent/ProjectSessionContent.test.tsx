import { useEffect } from 'react';
import type { DshConversationHostProps } from '@project-mind/dsh-ui/adapters';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor, screen, fireEvent } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectSessionContent } from './ProjectSessionContent';
import { requestDshFileReference, setDshWorkspaceRoot, useDshFileReferences } from '../../lib/dsh-host-events';
import type { AgentSourceRef } from '../../lib/agent-types';
import { useProjectFileNavigation } from '../../lib/project-file-navigation';
import { useUiStore } from '../../state/ui-store';
import { queryKeys } from '../../lib/queryKeys';
import { useAgentPanelStore } from '../../state/agent-panel-store';
const fixture = vi.hoisted(() => ({ command: vi.fn(), insert: vi.fn(), hosts: [] as DshConversationHostProps[] }));
vi.mock('../../services/desktopApi', () => ({ desktopApi: { command: fixture.command } }));
vi.mock('@project-mind/dsh-ui/adapters', () => ({
  insertDshFileReference: fixture.insert,
  DshConversationHost: (props: DshConversationHostProps) => {
    fixture.hosts.push(props);
    useEffect(() => { props.onReady?.(); }, []);
    return <div data-testid={props.sessionId} data-focused={props.focused}><input aria-label={`draft-${props.sessionId}`} /></div>;
  },
}));
beforeEach(() => {
  useAgentPanelStore.getState().clearWorkspace();
  fixture.command.mockReset().mockImplementation(async (command, args) => command === 'dsh_assistant_select_session' ? args.sessionId : undefined);
  fixture.insert.mockReset().mockResolvedValue(undefined); fixture.hosts = [];
  setDshWorkspaceRoot(null); setDshWorkspaceRoot('/workspace');
});
it('opens two explicit Sessions, drains only addressed references, and retains hidden UI without stopping', async () => {
  const client = new QueryClient();
  const shell = (visible = true) => <QueryClientProvider client={client}>
    <ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="a" visible={visible} focused={false} />
    <ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="b" visible focused />
  </QueryClientProvider>;
  const view = render(shell());
  await screen.findByTestId('a'); await screen.findByTestId('b');
  expect(fixture.command.mock.calls.some(([name]) => name === 'dsh_assistant_start')).toBe(false);
  expect(screen.getByTestId('a')).toHaveAttribute('data-focused', 'false');
  act(() => requestDshFileReference(1, 'a.md', 'a'));
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(1, 'a', 'a.md', undefined));
  expect(fixture.insert).toHaveBeenCalledTimes(1);
  view.rerender(shell(false));
  expect(screen.getByTestId('a')).not.toBeVisible();
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
  expect(useProjectFileNavigation.getState().request).toEqual({ workspaceRoot: '/workspace', projectId: 1, path: 'old.md', line: 2, originSessionId: 'fixed-session', sourceRef });
  view.unmount();
});

it('delivers a reference queued before the new Session page mounts', async () => {
  act(() => requestDshFileReference(1, 'initial.md', 'initial-session'));
  const view = render(<QueryClientProvider client={new QueryClient()}><ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="initial-session" visible focused /></QueryClientProvider>);
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(1, 'initial-session', 'initial.md', undefined));
  expect(useDshFileReferences.getState().pending).toHaveLength(0);
  view.unmount();
});

it('opens shared model settings from the addressed composer and has no separate model footer', async () => {
  const view = render(<QueryClientProvider client={new QueryClient()}><ProjectSessionContent workspaceRoot="/workspace" projectId={1} sessionId="model-session" visible focused /></QueryClientProvider>);
  await screen.findByTestId('model-session');
  expect(screen.queryByLabelText('会话模型')).toBeNull();
  expect(screen.queryByRole('button', { name: '模型设置' })).toBeNull();
  act(() => fixture.hosts.at(-1)!.onModelSettings?.());
  expect(useUiStore.getState().settingsSection).toBe('ai-models');
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

it('opens the Workspace Session seat with its null owner and current file references', async () => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProjectSessionContent workspaceRoot="/workspace" projectId={null} sessionId="workspace-session" visible focused /></QueryClientProvider>);
  await screen.findByTestId('workspace-session');
  expect(fixture.hosts.at(-1)?.projectId).toBeNull();
  act(() => requestDshFileReference(null, 'workspace.md', 'workspace-session'));
  await waitFor(() => expect(fixture.insert).toHaveBeenCalledWith(null, 'workspace-session', 'workspace.md', undefined));
  expect(fixture.command).toHaveBeenCalledWith('dsh_assistant_select_session', expect.objectContaining({ projectId: null, sessionId: 'workspace-session' }));
});


it.each([null, 7])('retains visited Session draft and reading DOM for owner %s without starting hidden scopes', async projectId => {
  const client = new QueryClient();
  const shell = (visible: boolean, root = '/workspace', owner = projectId) => <QueryClientProvider client={client}>
    <input aria-label="other editor" />
    <ProjectSessionContent workspaceRoot={root} projectId={owner} sessionId="retained" visible={visible} focused />
  </QueryClientProvider>;
  const view = render(shell(false));
  expect(fixture.command).not.toHaveBeenCalled();
  expect(screen.queryByTestId('retained')).toBeNull();
  view.rerender(shell(true));
  const host = await screen.findByTestId('retained');
  const draft = screen.getByLabelText('draft-retained');
  fireEvent.change(draft, { target: { value: 'unfinished shared Session draft' } });
  host.scrollTop = 125;
  const calls = fixture.command.mock.calls.length;
  const other = screen.getByLabelText('other editor');other.focus();
  view.rerender(shell(false));
  expect(host.isConnected).toBe(true);
  expect(host).not.toBeVisible();
  expect(host).toHaveAttribute('data-focused', 'false');
  expect(document.activeElement).toBe(other);
  view.rerender(shell(true));
  expect(screen.getByTestId('retained')).toBe(host);
  expect(screen.getByLabelText('draft-retained')).toBe(draft);
  expect(draft).toHaveValue('unfinished shared Session draft');
  expect(host.scrollTop).toBe(125);
  expect(fixture.command.mock.calls).toHaveLength(calls);
  view.rerender(shell(false, '/workspace', projectId === null ? 7 : null));
  expect(host.isConnected).toBe(false);
  expect(fixture.command.mock.calls).toHaveLength(calls);
  view.rerender(shell(false, '/different-workspace'));
  expect(host.isConnected).toBe(false);
  expect(fixture.command.mock.calls).toHaveLength(calls);
  view.unmount();
  expect(fixture.command.mock.calls.some(([name]) => /stop|disconnect|delete/.test(name))).toBe(false);
});


it.each([false, true])('rechecks changed model configuration after initial selection, deferring while busy=%s', async initiallyBusy => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.aiSettings, { network: { proxy: 'initial' } });
  const shell = (projectId = 7) => <QueryClientProvider client={client}><ProjectSessionContent workspaceRoot="/workspace" projectId={projectId} sessionId="config-session" visible focused /></QueryClientProvider>;
  const view = render(shell());
  await screen.findByTestId('config-session');
  const starts = () => fixture.command.mock.calls.filter(([name]) => name === 'dsh_assistant_start');
  expect(starts()).toHaveLength(0);
  if (initiallyBusy) act(() => useAgentPanelStore.getState().setRunBusy('/workspace', 7, true));
  act(() => client.setQueryData(queryKeys.aiSettings, { network: { proxy: 'changed' } }));
  if (initiallyBusy) {
    expect(starts()).toHaveLength(0);
    act(() => useAgentPanelStore.getState().setRunBusy('/workspace', 7, false));
  }
  await waitFor(() => expect(starts()).toHaveLength(1));
  await waitFor(() => expect(fixture.command.mock.calls.filter(([name]) => name === 'dsh_assistant_select_session')).toHaveLength(2));
  view.rerender(shell(8));
  await waitFor(() => expect(fixture.command).toHaveBeenCalledWith('dsh_assistant_select_session', expect.objectContaining({projectId:8})));
  expect(starts()).toHaveLength(1);
});
