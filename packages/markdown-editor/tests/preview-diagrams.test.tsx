import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';
import mermaidRenderer from 'mermaid';

// jsdom has no SVG layout. The real renderers still parse and generate their
// SVG; the one headless browser round checks the actual geometry.
beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value() { return { x: 0, y: 0, width: 80, height: 24 }; } });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value() { return 80; } });
});
afterEach(() => vi.restoreAllMocks());

const mermaid = 'flowchart LR\n  A[开始] --> B[完成]';
const wave = "{ signal: [{ name: 'clk', wave: 'p..' }, { name: 'data', wave: '01.' }] }";
const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``;

it('renders both real diagrams when switching source to split and preview without changing readonly source', async () => {
  const value = '\uFEFF---\r\ntitle: private\r\n---\r\n\r\n# 图表\r\n\r\n' + [fence('mermaid', mermaid), fence('wavedrom', wave)].join('\n\n').replaceAll('\n', '\r\n') + '\r\n';
  const changed = vi.fn();
  const { container } = render(<MarkdownEditor value={value} onChange={changed} readOnly documentKey="history-1" initialView={{ mode: 'source' }} />);
  expect(container.querySelector('.mind-markdown__preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '分屏' }));
  const flow = await screen.findByRole('img', { name: 'Mermaid 图表' });
  const timing = await screen.findByRole('img', { name: 'WaveDrom 图表' });
  expect(flow.querySelector('svg')).not.toBeNull();
  expect(flow.querySelector('svg')?.textContent).toContain('开始');
  expect(timing.querySelector('svg.WaveDrom')).not.toBeNull();
  expect(timing.querySelector('svg')?.textContent).toContain('clk');
  expect(container.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'false');
  expect(container.querySelector('.cm-content')?.textContent).toContain(mermaid.split('\n')[0]);
  expect(container.querySelector('.mind-markdown__preview')?.textContent).not.toContain('title: private');
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  expect(screen.getByRole('img', { name: 'Mermaid 图表' }).querySelector('svg')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('keeps document references, footnotes, math and nested diagrams in the shared safe Markdown pipeline', async () => {
  const nested = '> ' + fence('mermaid', '%%{init:{"themeCSS":".node rect {stroke-width:3px;}"}}%%\nflowchart LR\nA["image: 说明"] --> B[完成]').replaceAll('\n', '\n> ');
  const value = `[说明][reference] 与脚注[^note]。 $x^2$\n\n${nested}\n\n| 项目 | 值 |\n| --- | --- |\n| 图表 | 有 |\n\n[reference]: https://example.com/docs\n[^note]: 脚注正文`;
  const { container } = render(<MarkdownEditor value={value} onChange={() => {}} initialView={{ mode: 'preview' }} />);
  const flow = await screen.findByRole('img', { name: 'Mermaid 图表' });
  expect(flow.closest('blockquote')).not.toBeNull();
  expect(flow.querySelector('svg')?.textContent).toContain('image: 说明');
  expect(flow.querySelector('style')?.textContent).toContain('stroke-width:3px');
  expect(screen.getByRole('link', { name: /说明/u })).toHaveAttribute('href', 'https://example.com/docs');
  expect(screen.getByText('脚注正文')).toBeInTheDocument();
  expect(container.querySelector('.katex')).not.toBeNull();
  expect(within(container.querySelector('.mind-markdown__preview')!).getByRole('table')).toBeInTheDocument();
});

it('shows renderer-specific errors and readable source for invalid and empty diagrams', async () => {
  const value = [fence('mermaid', 'flowchart LR\nA -->'), fence('wavedrom', '{signal: nope}'), fence('wavedrom', '')].join('\n\n');
  const changed = vi.fn();
  const { container } = render(<MarkdownEditor value={value} onChange={changed} readOnly initialView={{ mode: 'preview' }} />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3));
  const errors = screen.getAllByRole('alert').map(node => node.textContent).join('\n');
  expect(errors).toMatch(/Mermaid：[\s\S]*Parse error/iu);
  expect(errors).toMatch(/WaveDrom：[\s\S]*JSON5/iu);
  expect(errors).toContain('wavedrom source is empty');
  expect(container.querySelector('.mind-markdown__preview')?.textContent).toContain('A -->');
  expect(container.querySelector('.mind-markdown__preview')?.textContent).toContain('{signal: nope}');
  expect(screen.queryByRole('img', { name: /图表/u })).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it.each([false, true])('discards a pending old SVG after %s external baseline replacement', async external => {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = new Promise<void>(resolve => { started = resolve; });
  const realRender = mermaidRenderer.render.bind(mermaidRenderer);
  vi.spyOn(mermaidRenderer, 'render').mockImplementation(async (...args) => {
    const rendered = await realRender(...args);
    if (args[1].includes('旧异步')) { started(); await held; }
    return rendered;
  });
  const changed = vi.fn();
  const { rerender, container } = render(<MarkdownEditor value={fence('mermaid', 'flowchart LR\nA[旧异步] --> B')} onChange={changed} documentKey="a" initialView={{ mode: 'preview' }} />);
  await pending;
  rerender(<MarkdownEditor value={fence('mermaid', 'flowchart LR\nA[当前文档] --> B')} onChange={changed} documentKey={external ? 'b' : 'a'} readOnly />);
  const flow = await screen.findByRole('img', { name: 'Mermaid 图表' });
  expect(flow.querySelector('svg')?.textContent).toContain('当前文档');
  await act(async () => { release(); await held; });
  expect(container.querySelector('.mind-markdown__preview')?.textContent).not.toContain('旧异步');
  expect(screen.getByRole('img', { name: 'Mermaid 图表' }).querySelector('svg')?.textContent).toContain('当前文档');
  expect(changed).not.toHaveBeenCalled();
});

it('blocks Mermaid resource syntax before rendering and filters active SVG while keeping WaveDrom fragment uses', async () => {
  const realRender = mermaidRenderer.render.bind(mermaidRenderer);
  const renderSpy = vi.spyOn(mermaidRenderer, 'render').mockImplementation(async (...args) => {
    const result = await realRender(...args);
    return { ...result, svg: result.svg.replace('</svg>', '<script>window.pwned=1</script><foreignObject><iframe src="https://untrusted.invalid/frame"/></foreignObject><image href="https://untrusted.invalid/image"/><use href="https://untrusted.invalid/remote#x"/><rect style="fill:url(https://untrusted.invalid/paint)"/><style>@import "https://untrusted.invalid/style";</style></svg>') };
  });
  const changed = vi.fn();
  const { rerender, container } = render(<MarkdownEditor value={[fence('mermaid', mermaid), fence('wavedrom', wave)].join('\n\n')} onChange={changed} initialView={{ mode: 'preview' }} />);
  const flow = await screen.findByRole('img', { name: 'Mermaid 图表' });
  expect(flow.querySelector('script,foreignObject,image,iframe')).toBeNull();
  expect(flow.innerHTML).not.toContain('https://untrusted.invalid');
  const timing = await screen.findByRole('img', { name: 'WaveDrom 图表' });
  expect(timing.querySelector('use')?.getAttribute('xlink:href') ?? timing.querySelector('use')?.getAttribute('href')).toMatch(/^#/u);
  renderSpy.mockClear();
  const unsafe = [
    'flowchart LR\nA@{img:"https://untrusted.invalid/image"}',
    '%%{init:{"themeCSS":"@import url(https://untrusted.invalid/style);"}}%%\nflowchart LR\nA --> B',
    String.raw`%%{init:{"themeVariables":{"fontFamily":"x; background:u\72l(https://untrusted.invalid/font)"}}}%%` + '\nflowchart LR\nA --> B',
    String.raw`%%{init:{"themeVariables":{"fontFamily":"x; background:u\\r\\l(https://untrusted.invalid/font)"}}}%%` + '\nflowchart LR\nA --> B',
    'flowchart LR\nA[<script>alert(1)</script>]',
  ];
  rerender(<MarkdownEditor value={unsafe.map(source => fence('mermaid', source)).join('\n\n')} onChange={changed} readOnly documentKey="unsafe" />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(unsafe.length));
  // The wrapper may commit its preceding local draft once before syncing a
  // new external value; none of the untrusted new sources may reach Mermaid.
  expect(renderSpy.mock.calls.every(call => !unsafe.includes(call[1]))).toBe(true);
  expect(screen.queryByRole('img', { name: /图表/u })).toBeNull();
  expect(container.querySelector('.mind-markdown__preview')?.textContent).toContain('untrusted.invalid/image');
  expect(changed).not.toHaveBeenCalled();
});

it('keeps WaveDrom waveform geometry in rich view and the real print callback', async () => {
  const printed = vi.fn(async (_document: { html: string }) => {}), changed = vi.fn();
  const { container } = render(<MarkdownEditor value={fence('wavedrom', wave)} onChange={changed} readOnly onPrint={printed} initialView={{ mode: 'rich' }} />);
  await waitFor(() => expect(container.querySelector('.md-diagram-preview svg use')).not.toBeNull());
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button', { name: '打印…' }));
  await waitFor(() => expect(printed).toHaveBeenCalledOnce());
  const doc = new DOMParser().parseFromString(printed.mock.calls[0][0].html, 'text/html');
  // WK/AppKit's sandboxed srcdoc prints text/grid but drops local <use>
  // waveform instances. The prepared artifact must carry real vector paths.
  const svg = doc.querySelector('svg.WaveDrom')!;
  expect(svg.querySelector('use')).toBeNull();
  const lanes = svg.querySelectorAll('[id^="wavelane_draw_"]');
  expect(lanes).toHaveLength(2);
  for (const lane of lanes) expect(lane.querySelectorAll('path').length).toBeGreaterThan(0);
  expect(lanes[0].querySelector('path')?.getAttribute('d')).toBe('M0,20 0,0 20,0');
  expect(lanes[0].querySelector('[transform="translate(20)"] path')).not.toBeNull();
  expect(svg.querySelector('image')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
