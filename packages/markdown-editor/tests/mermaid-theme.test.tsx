import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { renderSafeDiagram } from '../src/adapters/diagramPreviewSafety';
import { PreviewDiagram } from '../src/adapters/PreviewDiagram';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';
import { fenced, flowchart, sequence, gantt } from './fixtures/mermaid';

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 24 }) });
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 80 });
});
afterEach(() => { delete document.documentElement.dataset.theme; vi.restoreAllMocks(); });

it('embeds independent light and dark themes in concurrent real flow/sequence renders and retains full Mermaid syntax', async () => {
  const outputs = await Promise.all([
    renderSafeDiagram('mermaid', flowchart, 'dark'),
    renderSafeDiagram('mermaid', sequence, 'light'),
    renderSafeDiagram('mermaid', gantt, 'dark'),
  ]);
  for (const result of outputs) {
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg).not.toContain('<foreignObject');
  }
  expect(outputs[0]).toMatchObject({ ok: true, svg: expect.stringContaining('#eeece6') });
  if (outputs[0].ok) expect(outputs[0].svg).toContain('background-color: rgb(32, 33, 36)');
  expect(outputs[1]).toMatchObject({ ok: true, svg: expect.stringContaining('#37352f') });
  expect(outputs[2]).toMatchObject({ ok: true, svg: expect.stringContaining('项目交付安排') });
});

it('hides an old preview synchronously while theme replacement is pending', async () => {
  document.documentElement.dataset.theme = 'light';
  const { container } = render(<PreviewDiagram language="mermaid" source={flowchart} fallback={<pre>{flowchart}</pre>} />);
  await screen.findByRole('img', { name: 'Mermaid 图表' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const realRender = mermaid.render.bind(mermaid);
  vi.spyOn(mermaid, 'render').mockImplementation(async (...args) => { await held; return realRender(...args); });
  await act(async () => { document.documentElement.dataset.theme = 'dark'; });
  expect(screen.queryByRole('img', { name: 'Mermaid 图表' })).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(container.querySelector('svg')?.textContent).toContain('#eeece6'));
});

it('keeps the rich editor source exact across rendering, editing and reopen', async () => {
  const source = fenced(flowchart), changed = vi.fn();
  const first = render(<MarkdownEditor value={source} onChange={changed} initialView={{ mode: 'rich' }} />);
  await waitFor(() => expect(first.container.querySelector('.md-diagram-preview svg')).not.toBeNull());
  expect(first.container.querySelector('.md-codeblock code')?.textContent).toBe(flowchart);
  expect(changed).not.toHaveBeenCalled();
  first.unmount();
  const reopened = render(<MarkdownEditor value={source} onChange={changed} initialView={{ mode: 'rich' }} />);
  await waitFor(() => expect(reopened.container.querySelector('.md-diagram-preview svg')).not.toBeNull());
  expect(reopened.container.querySelector('.md-codeblock code')?.textContent).toBe(flowchart);
  expect(changed).not.toHaveBeenCalled();
});

it('does not flash the preceding rich SVG while a new source render is pending', async () => {
  const first = fenced('flowchart LR\nA[旧源码] --> B');
  const { container, rerender } = render(<MarkdownEditor value={first} onChange={() => {}} documentKey="rich-a" initialView={{ mode: 'rich' }} />);
  await waitFor(() => expect(container.querySelector('.md-diagram-preview svg')).not.toBeNull());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const realRender = mermaid.render.bind(mermaid);
  vi.spyOn(mermaid, 'render').mockImplementation(async (...args) => { await held; return realRender(...args); });
  rerender(<MarkdownEditor value={fenced('flowchart LR\nA[当前源码] --> B')} onChange={() => {}} documentKey="rich-b" initialView={{ mode: 'rich' }} />);
  await waitFor(() => expect(container.querySelector('.md-codeblock code')?.textContent).toContain('当前源码'));
  expect(container.querySelector('.md-diagram-preview svg')).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(container.querySelector('.md-diagram-preview svg')?.textContent).toContain('当前源码'));
});


it('blocks active Mermaid source before the real Word export renderer and preserves readable code', async () => {
  const { prepareExportDocument } = await import('../src/export/document');
  const { deliverMarkdownExport } = await import('../src/export/browser');
  const { default: JSZip } = await import('jszip');
  const source = 'flowchart LR\nA@{img:"https://untrusted.invalid/tracker"}';
  const spy = vi.spyOn(mermaid, 'render');
  const document = await prepareExportDocument(fenced(source), {});
  let saved: Uint8Array | undefined;
  await deliverMarkdownExport(document, 'docx', new AbortController().signal, () => {}, async file => { saved = file.bytes; return true; });
  expect(spy).not.toHaveBeenCalled();
  const zip = await JSZip.loadAsync(saved!);
  expect(await zip.file('word/document.xml')!.async('string')).toContain('untrusted.invalid/tracker');
  expect(Object.keys(zip.files).some(path => path.startsWith('word/media/'))).toBe(false);
});
