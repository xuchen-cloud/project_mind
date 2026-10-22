import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ProcessActivitySummary } from './upstream/client/ui-chat/src/client/contract/process-groups';
import type { ComponentProps } from 'react';
import { ChatGroupSeat } from './upstream/client/ui-chat/src/client/chat/ChatGroupSeat';
import { presentationPolicyFor } from './upstream/client/ui-chat/src/client/presentation-policy';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

// Real group, node seats, disclosure and scroll hooks; only the slot's business body is a fixture.
function fixture(mode: 'standard' | 'detailed' | 'verbose' = 'detailed') {
  const turn = { turn: 1, status: 'open', data: {} };
  const group = { members: [{ kind: 'node', key: 'reasoning' }, { kind: 'node', key: 'tool' }], data: {
    turn: 1, closed: false, summary: { counts: [], running: undefined, runningDetail: 'First thought' } as ProcessActivitySummary,
  } };
  const nodes = Object.fromEntries(['reasoning', 'tool', 'new-tool'].map((key, index) => [key, {
    key, kind: 'assistant-step', anchorSeq: index + 1,
    location: { kind: 'step', turn }, data: { step: index + 1 },
  }]));
  const props = {
    groupKey: 'process',
    useChatGroup: (_key: string, select: (value: typeof group) => unknown) => select(group),
    useChatNode: (key: string, select?: (value: unknown) => unknown) => select ? select(nodes[key]) : nodes[key],
    useChatNodeProcess: () => ({ turnClosed: turn.status === 'closed' }),
    usePresentation: (select: (policy: ReturnType<typeof presentationPolicyFor>) => unknown) => select(presentationPolicyFor(mode)),
    useStore: () => undefined,
    actions: { setTurnProcessOpen: vi.fn() },
    renderSlot: (_slot: string, owner: { node: { key: string } }) => <div>{owner.node.key} body</div>,
    t: (key: string) => key,
  } as unknown as ComponentProps<typeof ChatGroupSeat>;
  return { group, turn, props };
}

it.each(['standard', 'detailed'] as const)('%s: live process defaults to one latest-activity row', mode => {
  const { props } = fixture(mode);
  const view = render(<ChatGroupSeat {...props} />);
  expect(view.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  expect(view.container.querySelector('[data-step-process-body]')).toHaveAttribute('hidden');
  expect(view.getByRole('button')).toHaveTextContent('First thought');
  expect(view.getByText('reasoning body')).not.toBeVisible();
  expect(view.getByText('tool body')).not.toBeVisible();
});

it('retains explicit toggles across streaming activities and folds on completion', () => {
  vi.useFakeTimers();
  const { props, group, turn } = fixture();
  const view = render(<ChatGroupSeat {...props} />);
  const body = view.container.querySelector('[data-step-process-body]')!;
  const button = () => view.getByRole('button');
  fireEvent.click(button());
  expect(button()).toHaveAttribute('aria-expanded', 'true');
  expect(body).not.toHaveAttribute('hidden');
  group.data.summary = { ...group.data.summary, running: 'commands', runningDetail: 'Newest tool' };
  group.members = [...group.members, { kind: 'node', key: 'new-tool' }];
  view.rerender(<ChatGroupSeat {...props} useChatGroup={(...args) => props.useChatGroup(...args)} />);
  act(() => vi.advanceTimersByTime(150));
  expect(button()).toHaveTextContent('Newest tool');
  expect(button()).toHaveAttribute('data-process-activity', 'commands');
  expect(view.getByText('new-tool body')).toBeVisible();
  expect(button()).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(button());
  expect(body).toHaveAttribute('hidden');
  group.data.summary.runningDetail = 'Another thought';
  view.rerender(<ChatGroupSeat {...props} useChatGroup={(...args) => props.useChatGroup(...args)} />);
  act(() => vi.advanceTimersByTime(150));
  expect(button()).toHaveTextContent('Another thought');
  expect(button()).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button());
  turn.status = 'closed'; group.data.closed = true;
  view.rerender(<ChatGroupSeat {...props} useChatGroup={(...args) => props.useChatGroup(...args)} />);
  expect(button()).toHaveAttribute('aria-expanded', 'false');
  expect(body).toHaveAttribute('hidden');
  fireEvent.click(button());
  expect(button()).toHaveAttribute('aria-expanded', 'true');
  expect(body).not.toHaveAttribute('hidden');
});

it('retains the explicit verbose presentation', () => {
  const { props } = fixture('verbose');
  const view = render(<ChatGroupSeat {...props} />);
  expect(view.queryByRole('button')).toBeNull();
  expect(view.getByText('reasoning body')).toBeVisible();
});

it.each([false, true])('opened live group follows growth; reduced motion=%s', reduced => {
  const observers = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.add(callback); }
    observe() {}
    disconnect() { observers.clear(); }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  const { props } = fixture();
  const view = render(<ChatGroupSeat {...props} />);
  const body = view.container.querySelector<HTMLDivElement>('[data-step-process-body]')!;
  let height = 600;
  Object.defineProperties(body, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => height },
  });
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => { body.scrollTop = top!; });
  body.scrollTo = scrollTo;
  fireEvent.click(view.getByRole('button'));
  act(() => observers.forEach(callback => callback()));
  expect(body.scrollTop).toBe(500);
  expect(body).toHaveAttribute('data-scroll-up');
  expect(body).not.toHaveAttribute('data-scroll-down');
  height = 700;
  act(() => observers.forEach(callback => callback()));
  expect(body.scrollTop).toBe(600);
  if (reduced) expect(scrollTo).not.toHaveBeenCalled();
  else expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' });
  fireEvent.scroll(body);
  fireEvent.wheel(body);
  body.scrollTop = 200;
  fireEvent.scroll(body);
  height = 800;
  act(() => observers.forEach(callback => callback()));
  expect(body.scrollTop).toBe(200);
  expect(body).toHaveAttribute('data-scroll-down');
});
