import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ModelPicker } from './model-picker.jsx';

const catalog = { default: { provider: 'mind-main', model: 'alpha' }, groups: [
  { id: 'mind-main', name: '默认配置', models: [{ id: 'alpha', name: 'Alpha' }] },
  { id: 'mind-profile-2', name: '备用配置', models: [{ id: 'beta', name: 'Beta' }] },
], failures: [] };
function props(sessionId = 'one', running = false) {
  return { sessionId, locked: false, useSession: (selector: (v: { running: boolean }) => unknown) => selector({ running }),
    useProjection: () => ({ next: catalog.default, lastUsed: catalog.default }),
    loadCatalog: vi.fn().mockResolvedValue(catalog), selectModel: vi.fn().mockResolvedValue({ ok: true }), openModelSettings: vi.fn() };
}
it('places the selection in the composer seat and submits the complete model to the addressed Session', async () => {
  const input = props(); render(<ModelPicker {...input} />);
  await screen.findByRole('button', { name: '选择模型：Alpha' });
  fireEvent.click(screen.getByRole('button', { name: '选择模型：Alpha' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
  await waitFor(() => expect(input.selectModel).toHaveBeenCalledWith({ sessionId: 'one', provider: 'mind-profile-2', model: 'beta' }));
  expect(input.openModelSettings).not.toHaveBeenCalled();
});
it('allows switching during a run and shows only the selected model without timing badges', async () => {
  const input = props('running-session', true);
  input.useProjection = () => ({ next: catalog.groups[1] && { provider: 'mind-profile-2', model: 'beta' }, lastUsed: catalog.default });
  render(<ModelPicker {...input} />);
  const trigger = await screen.findByRole('button', { name: '选择模型：Beta' });
  expect(trigger).toBeEnabled(); expect(trigger).toHaveAttribute('title', '备用配置 · Beta');
  fireEvent.click(trigger);
  expect(screen.queryByText('切换后用于下一次模型调用')).toBeNull();
  expect(screen.queryByText('下一次')).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
  await waitFor(() => expect(input.selectModel).toHaveBeenCalledWith({ sessionId: 'running-session', provider: 'mind-main', model: 'alpha' }));
});
it('surfaces rejected changes and retains the confirmed selection', async () => {
  const input = props(); input.selectModel.mockResolvedValue({ ok: false, error: { message: '模型已停用' } });
  render(<ModelPicker {...input} />); await screen.findByRole('button', { name: '选择模型：Alpha' });
  fireEvent.click(screen.getByRole('button', { name: '选择模型：Alpha' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('模型已停用');
  expect(screen.getByRole('button', { name: '选择模型：Alpha' })).toBeEnabled();
});
it('keeps the model menu scoped to each Session and offers shared configuration only as a menu action', async () => {
  const first = props('one'); const second = props('two');
  const view = render(<ModelPicker {...first} />); await screen.findByRole('button', { name: '选择模型：Alpha' });
  view.rerender(<ModelPicker {...second} />);
  await screen.findByRole('button', { name: '选择模型：Alpha' });
  fireEvent.click(screen.getByRole('button', { name: '选择模型：Alpha' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
  await waitFor(() => expect(second.selectModel).toHaveBeenCalledWith({ sessionId: 'two', provider: 'mind-profile-2', model: 'beta' }));
  expect(first.selectModel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '选择模型：Alpha' })); fireEvent.click(screen.getByRole('menuitem', { name: '管理模型…' }));
  expect(second.openModelSettings).toHaveBeenCalledWith('two');
});
it('keeps model management accessible if the catalog fails and supports explicit retry', async () => {
  const input = props(); input.loadCatalog.mockRejectedValueOnce(new Error('读取模型失败'));
  render(<ModelPicker {...input} />); await screen.findByRole('button', { name: '选择模型：alpha' });
  fireEvent.click(screen.getByRole('button', { name: '选择模型：alpha' }));
  expect(screen.getByRole('alert')).toHaveTextContent('读取模型失败');
  fireEvent.click(screen.getByRole('menuitem', { name: '重试' }));
  await screen.findByRole('button', { name: '选择模型：Alpha' });
});

it('dismisses with Escape and returns keyboard focus to the trigger', async () => {
  const input = props(); render(<ModelPicker {...input} />);
  const trigger = await screen.findByRole('button', { name: '选择模型：Alpha' });
  trigger.focus(); fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(trigger).toHaveFocus();
});
it('closes the menu when the Session loses its interactive seat', async () => {
  const input = props(); const view = render(<ModelPicker {...input} />);
  const trigger = await screen.findByRole('button', { name: '选择模型：Alpha' });
  fireEvent.click(trigger); expect(screen.getByRole('menu')).toBeVisible();
  view.rerender(<ModelPicker {...input} locked />);
  expect(screen.queryByRole('menu')).toBeNull(); expect(trigger).toBeDisabled();
});
it('ignores a previous Session catalog response after switching tabs', async () => {
  let resolve!: (value: typeof catalog) => void;
  const first = props('one'); first.loadCatalog.mockImplementation(() => new Promise(done => { resolve = done; }));
  const second = props('two'); const view = render(<ModelPicker {...first} />);
  view.rerender(<ModelPicker {...second} />);
  await screen.findByRole('button', { name: '选择模型：Alpha' });
  await act(async () => resolve({ ...catalog, groups: [{ id: 'mind-main', name: '旧会话', models: [{ id: 'alpha', name: 'Stale' }] }] }));
  expect(screen.queryByRole('button', { name: '选择模型：Stale' })).toBeNull();
});

it('keeps a removed model visible and lets the user select a replacement in the same composer', async () => {
  const input = props(); input.useProjection = () => ({ next: { provider: 'removed', model: 'old-model' }, lastUsed: catalog.default });
  render(<ModelPicker {...input} />);
  const trigger = await screen.findByRole('button', { name: '选择模型：old-model' }); fireEvent.click(trigger);
  expect(screen.getByRole('alert')).toHaveTextContent('当前模型已不可用');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Beta' }));
  await waitFor(() => expect(input.selectModel).toHaveBeenCalledWith({ sessionId: 'one', provider: 'mind-profile-2', model: 'beta' }));
});
