import React, { useState } from 'react';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactSvgSlide, previewSlides } from '../browser';
import { inspect } from '../dist/engine.mjs';
import type { PptxEdit, PptxModel, PptxTextElement } from '../types';
import type { GlyphRun, RenderSlide, ShapeRenderNode, TextLine } from '../vendor/packages/pptx-render/src/render-tree';

afterEach(cleanup);
const target: PptxTextElement = { slideIndex: 0, cNvPrId: '5', text: '原始文字', editable: true,
  originalRichText: { paragraphs: [{ runs: [{ text: '首行后半跨到次行', bold: true, italic: true }, { text: '相邻' }, { text: '' }] }, { runs: [{ text: '' }] }] } };
const glyph = (text: string, srcRunIdx: number, x: number, baselineY: number, widthPx: number): GlyphRun => ({
  text, srcRunIdx, x, baselineY, widthPx, ascentPx: 16, fontSizePx: 20, fontFamily: 'Test Font', color: '#123456', bold: true, italic: true, underline: true,
});
function slide(lines: TextLine[] = [
  { paraStart: true, top: 0, height: 24, runs: [glyph('首行后半', 0, 80, 16, 100)] },
  { top: 24, height: 24, runs: [glyph('跨到次行', 0, 0, 40, 80), glyph('相邻', 1, 80, 40, 40)] },
  { paraStart: true, top: 48, height: 24, runs: [] },
]): RenderSlide {
  const node: ShapeRenderNode = { type: 'text', id: 'shape-5', sourceId: 'slide-0:shape-5',
    box: { x: 30, y: 40, w: 240, h: 100, rotationDeg: 15, flipH: true, flipV: false }, fill: { kind: 'none' },
    text: { lines, insets: { l: 4, t: 5, r: 4, b: 5 }, anchor: 'top', fontScale: 1, contentHeight: 72, wrap: true } };
  return { widthPx: 960, heightPx: 540, scale: 1, background: { kind: 'solid', color: 'white' }, nodes: [node] };
}

test('all source runs including empty paragraphs have inline inputs with formatting and shape transforms', () => {
  const { container } = render(<ReactSvgSlide slide={slide()} label="预览" textTarget={target} onTextChange={vi.fn()} />);
  expect(screen.getAllByRole('textbox')).toHaveLength(4);
  const input = screen.getByRole('textbox', { name: '第 1 段第 1 片段' }) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  expect(input.style.color).toBe('rgb(18, 52, 86)');
  expect(input.style.fontWeight).toBe('700');
  expect(input.style.fontStyle).toBe('italic');
  expect(input.parentElement?.localName).toBe('foreignObject');
  expect(input.closest('[data-source-id]')?.getAttribute('transform')).toContain('rotate(15');
  expect(input.closest('[data-source-id]')?.getAttribute('transform')).toContain('scale(-1,1)');
  expect(container.querySelector('svg')?.getAttribute('role')).toBe('group');
  expect(screen.getByRole('textbox', { name: '第 2 段第 1 片段' }).getAttribute('title')).toContain('不支持新增换行');
  // Only the active source run is replaced; neighbouring SVG glyphs still draw.
  expect(container.querySelector('text')?.parentElement?.getAttribute('visibility')).toBe('hidden');
  expect(Array.from(container.querySelectorAll('text')).find(t => t.textContent === '相邻')?.parentElement?.getAttribute('visibility')).toBeNull();
  const foreign = input.parentElement!;
  expect(foreign.getAttribute('x')).toBe('0');
  expect(foreign.getAttribute('width')).toBe('180');
  const clipId = foreign.parentElement!.getAttribute('clip-path')!.slice(5, -1);
  const clip = Array.from(container.querySelectorAll('clipPath')).find(c => c.id === clipId)!;
  expect(Array.from(clip.children).map(r => [r.getAttribute('x'), r.getAttribute('width')])).toEqual([['80', '100'], ['0', '80']]);
});

test('IME Enter stays in the input; ordinary Enter is blocked and multiline paste reaches host validation', () => {
  const onTextChange = vi.fn();
  const onSelect = vi.fn();
  render(<ReactSvgSlide slide={slide()} label="预览" textTarget={target} onSelect={onSelect} onTextChange={onTextChange} />);
  const input = screen.getByRole('textbox', { name: '第 1 段第 1 片段' });
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
  fireEvent.change(input, { target: { value: '中文输入' } });
  expect(onTextChange).toHaveBeenLastCalledWith(0, 0, '中文输入');
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: '中\n文\r\n粘贴\u2028结束' } });
  expect(onTextChange).toHaveBeenLastCalledWith(0, 0, '中\n文\n粘贴\u2028结束');
  fireEvent.click(input);
  expect(onSelect).not.toHaveBeenCalled();
});

test('Escape and global undo shortcuts reach the host without moving the native caret', () => {
  const onKeyDown = vi.fn();
  render(<div onKeyDown={onKeyDown}><ReactSvgSlide slide={slide()} label="预览" textTarget={target} onTextChange={vi.fn()} /></div>);
  const input = screen.getByRole('textbox', { name: '第 1 段第 1 片段' });
  fireEvent.keyDown(input, { key: 'Escape' });
  fireEvent.keyDown(input, { key: 'z', metaKey: true });
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
  expect(onKeyDown.mock.calls.map(([event]) => event.key)).toEqual(['Escape', 'z', 'z']);
  expect(document.activeElement).toBe(input);
});

test('readonly, unsupported and unselected objects do not expose writable text', () => {
  const props = { slide: slide(), label: '预览', onTextChange: vi.fn() };
  const { rerender, container } = render(<ReactSvgSlide {...props} textTarget={target} readOnly />);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  rerender(<ReactSvgSlide {...props} textTarget={{ ...target, editable: false }} />);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  rerender(<ReactSvgSlide {...props} textTarget={{ ...target, cNvPrId: 'other' }} />);
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(container.querySelector('text')?.parentElement?.getAttribute('visibility')).toBeNull();
});

test('selectable shapes expose keyboard selection without an image ancestor role', () => {
  const onSelect = vi.fn();
  render(<ReactSvgSlide slide={slide()} label="预览" onSelect={onSelect} />);
  const button = screen.getByRole('button', { name: /文字：首行后半/ });
  expect(button.getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(button, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith('slide-0:shape-5');
  expect(button.closest('svg')?.getAttribute('role')).toBe('group');
});

test('an empty text object remains editable even without a render text layout', () => {
  const payload = slide([]);
  delete (payload.nodes[0] as ShapeRenderNode).text;
  const onTextChange = vi.fn();
  render(<ReactSvgSlide slide={payload} label="空文字" textTarget={{ ...target, originalRichText: { paragraphs: [{ runs: [{ text: '' }] }] } }} onTextChange={onTextChange} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '重新输入' } });
  expect(onTextChange).toHaveBeenCalledWith(0, 0, '重新输入');
});

const model: PptxModel = await inspect(new Uint8Array(await readFile(`${process.cwd()}/test/fixtures/complex.pptx`)));
test('real previewSlides rebuilds preserve the input, caret, composition and deletion-to-empty recovery', () => {
  const textTarget = model.textElements.find(t => t.editable && t.cNvPrId === '5')!;
  function Host() {
    const [edits, setEdits] = useState<PptxEdit[]>([]);
    return <ReactSvgSlide label="真实预览" slide={previewSlides(model, edits)[0]} textTarget={textTarget} edits={edits}
      onTextChange={(paragraphIndex, runIndex, text) => setEdits([{ ...textTarget, kind: 'text', paragraphIndex, runIndex, text }])} />;
  }
  render(<Host />);
  const input = screen.getByRole('textbox', { name: '第 1 段第 1 片段' }) as HTMLTextAreaElement;
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '中间输入位置', selectionStart: 2, selectionEnd: 2 } });
  expect(screen.getByRole('textbox', { name: '第 1 段第 1 片段' })).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
  fireEvent.compositionEnd(input);
  fireEvent.change(input, { target: { value: '' } });
  expect(screen.getByRole('textbox', { name: '第 1 段第 1 片段' })).toBe(input);
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: '恢复中文' } });
  expect(input.value).toBe('恢复中文');
  expect(document.activeElement).toBe(input);
});
