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
