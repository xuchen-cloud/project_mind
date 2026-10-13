import { readFile } from 'node:fs/promises';
import React, { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PptxEditor, type PptxModel, type PptxEdit } from '../../../src/components/office/PptxEditor';
import { inspect, edit } from '../dist/engine.mjs';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const bytes = new Uint8Array(await readFile(`${process.cwd()}/test/fixtures/complex.pptx`));
const model: PptxModel = await inspect(bytes);
const selectText = (text: string) => fireEvent.change(screen.getByRole('combobox', { name: '选择对象' }), { target: { value: (screen.getByRole('option', { name: `文字：${text}` }) as HTMLOptionElement).value } });

test('actual render tree shows Chinese, pictures, table and chart SVG, and edits the existing run', () => {
  let received: PptxEdit[] = [];
  function Host() {
    const [edits, change] = useState<PptxEdit[]>([]);
    return <PptxEditor model={model} edits={edits} onChange={e => { received = e; change(e); }} readOnly={false} />;
  }
  const { container } = render(<Host />);
  expect(container.querySelector('svg[aria-label="第 1 页预览"] image')).not.toBeNull();
  selectText('项目进展正常');
  const input = screen.getByRole('textbox', { name: '第 1 段第 1 片段' });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '中文输入进行中' } });
  fireEvent.compositionEnd(input, { data: '中文输入进行中' });
  expect(received).toEqual([{ kind: 'text', slideIndex: 0, cNvPrId: '5', paragraphIndex: 0, runIndex: 0, text: '中文输入进行中' }]);
  expect(container.querySelector('svg[aria-label="第 1 页预览"]')?.textContent).toContain('中文输入进行中');
  const inspector = container.querySelector('.pptx-editor__inspector')!;
  // jsdom does not evaluate the narrow container query that reveals this button.
  const toggle = screen.getByText('对象属性', { selector: 'button' });
  fireEvent.click(toggle);
  expect(inspector.getAttribute('data-collapsed')).toBe('true');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(inspector.querySelector('textarea')).toBe(input);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(inspector.querySelector('textarea')).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('中文输入进行中');
  fireEvent.click(screen.getByRole('button', { name: '第 2 页' }));
  expect(container.querySelector('svg[aria-label="第 2 页预览"] [data-node-type="table"]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '第 3 页' }));
  expect(container.querySelector('svg[aria-label="第 3 页预览"] [data-node-type="chart"]')).not.toBeNull();
});

test('picture controls generate stable moves and saving/readOnly prevents edits', () => {
  let received: PptxEdit[] = [];
  const onChange = (e: PptxEdit[]) => { received = e; };
  const { rerender } = render(<PptxEditor model={model} edits={[]} onChange={onChange} readOnly={false} />);
  fireEvent.change(screen.getByRole('combobox', { name: '选择对象' }), { target: { value: 'picture:7' } });
  fireEvent.click(screen.getByRole('button', { name: '图片右移' }));
  expect(received).toEqual([{ kind: 'move-image', slideIndex: 0, cNvPrId: '7', x: 960120, y: 2560320 }]);
  rerender(<PptxEditor model={model} edits={received} onChange={onChange} readOnly />);
  expect(screen.getByRole('button', { name: '图片右移' }).hasAttribute('disabled')).toBe(true);
  selectText('项目进展正常');
  expect(screen.getByRole('textbox', { name: '第 1 段第 1 片段' }).hasAttribute('readonly')).toBe(true);
});

test('new committed model becomes the baseline, with the host clearing edits', async () => {
  const pending: PptxEdit[] = [{ kind: 'text', slideIndex: 0, cNvPrId: '5', paragraphIndex: 0, runIndex: 0, text: '第一次提交' }];
  const committed: PptxModel = await inspect(await edit(bytes, pending));
  let result: PptxEdit[] = [];
  const { rerender } = render(<PptxEditor model={model} edits={pending} onChange={e => { result = e; }} readOnly={false} />);
  rerender(<PptxEditor model={committed} edits={[]} onChange={e => { result = e; }} readOnly={false} />);
  selectText('第一次提交');
  fireEvent.change(screen.getByRole('textbox', { name: '第 1 段第 1 片段' }), { target: { value: '第二次提交' } });
  expect(result).toEqual([{ ...pending[0], text: '第二次提交' }]);
  rerender(<PptxEditor model={committed} edits={result} onChange={e => { result = e; }} readOnly={false} />);
  fireEvent.change(screen.getByRole('textbox', { name: '第 1 段第 1 片段' }), { target: { value: '第一次提交' } });
  expect(result).toEqual([]);
});

test('undo and redo restore controlled edits and are frozen while saving', () => {
  let received: PptxEdit[] = [];
  function Host({ readOnly = false }: { readOnly?: boolean }) {
    const [edits, change] = useState<PptxEdit[]>([]);
    return <PptxEditor model={model} edits={edits} onChange={e => { received = e; change(e); }} readOnly={readOnly} />;
  }
  const { rerender } = render(<Host />);
  selectText('项目进展正常');
  fireEvent.change(screen.getByRole('textbox', { name: '第 1 段第 1 片段' }), { target: { value: '可以撤销' } });
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(received).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '重做' }));
  expect(received[0]).toMatchObject({ text: '可以撤销' });
  rerender(<Host readOnly />);
  expect(screen.getByRole('button', { name: '撤销' }).hasAttribute('disabled')).toBe(true);
});

test('page list fades follow scroll distance in both directions and update after resizing', () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  render(<PptxEditor model={model} edits={[]} onChange={() => {}} readOnly />);
  const region = screen.getByRole('region', { name: '选择幻灯片' });
  const frame = region.parentElement!;
  let height = 300, viewport = 100;
  Object.defineProperties(region, { scrollHeight: { get: () => height }, clientHeight: { get: () => viewport } });
  const fade = (side: string) => frame.style.getPropertyValue(`--scroll-fade-${side}-opacity`);
  fireEvent.scroll(region, { target: { scrollTop: 0 } });
  expect([fade('top'), fade('bottom')]).toEqual(['0', '1']);
  fireEvent.scroll(region, { target: { scrollTop: 32 } });
  expect([fade('top'), fade('bottom')]).toEqual(['0.5', '1']);
  fireEvent.scroll(region, { target: { scrollTop: 200 } });
  expect([fade('top'), fade('bottom')]).toEqual(['1', '0']);
  fireEvent.scroll(region, { target: { scrollTop: 168 } });
  expect([fade('top'), fade('bottom')]).toEqual(['1', '0.5']);
  height = 124;
  fireEvent.scroll(region, { target: { scrollTop: 0 } });
  expect([fade('top'), fade('bottom')]).toEqual(['0', '1']);
  viewport = 150;
  // Content and viewport observers use the same baseline measurement.
  fireEvent.scroll(region);
  expect([fade('top'), fade('bottom')]).toEqual(['0', '0']);
  expect(callbacks.length).toBe(3);
});
