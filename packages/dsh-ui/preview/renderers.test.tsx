import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DshFilePreview } from './index.jsx';
const pdf = vi.hoisted(() => ({ dispose: vi.fn(async () => {}), open: vi.fn(), render: vi.fn(async () => ({ width: 120, height: 100 })) }));
vi.mock('../upstream/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts', () => ({ openPdf: pdf.open }));
vi.mock('../upstream/client/ui-sidebar-documentpreview/src/client/pdf/document.ts', () => ({ renderPdfPage: pdf.render }));
vi.mock('../upstream/client/ui-sidebar-documentpreview/src/client/pdf/text.ts', () => ({ pdfTextRenderer: () => ({ promise: Promise.resolve(), cancel() {} }) }));
beforeEach(() => {
  vi.clearAllMocks();
  pdf.open.mockReturnValue({ document: Promise.resolve({ numPages: 2 }), dispose: pdf.dispose });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', undefined);
  URL.createObjectURL = vi.fn(() => 'blob:sample-image');
  URL.revokeObjectURL = vi.fn();
});
const base = () => ({ name: 'sample.txt', signal: new AbortController().signal });
it('uses pinned TextBody source lines with version-relative line targets', () => {
  const { container } = render(<DshFilePreview {...base()} kind="text" text={'first\nsecond\n最后'} line={2} />);
  expect(container.querySelector('[data-textpreview-target="2"]')).toHaveTextContent('second');
  expect(container.querySelectorAll('[data-textpreview-line]')).toHaveLength(3);
});
it('uses the real CodeBody and Shiki CodeBlock for a TypeScript fixture', async () => {
  const { container } = render(<DshFilePreview {...base()} name="sample.ts" kind="code" text={'const answer: number = 42;'} line={1} />);
  expect(container.querySelector('[data-code-preview]')).not.toBeNull();
  await waitFor(() => expect(container.querySelector('pre')).toHaveTextContent('const answer: number = 42;'));
  expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
});
it('does not rerender the preview when renderer mutations leave scroll edges unchanged', async () => {
  const committed = vi.fn();
  const view = render(<Profiler id="file" onRender={committed}><DshFilePreview {...base()} name="sample.ts" kind="code" text="const stable = 1;" /></Profiler>);
  await waitFor(() => expect(view.container.querySelector('pre')).toHaveTextContent('const stable = 1;'));
  await act(async () => {});
  const before = committed.mock.calls.length;
  await act(async () => { view.container.querySelector('pre')!.setAttribute('data-layout', 'changed'); });
  expect(committed).toHaveBeenCalledTimes(before);
});
it('uses MarkdownBody tables, lists and source code without interpreting raw HTML; relative resources are absent', () => {
  const text = '# 样例\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- item\n\n![local](images/a.png)\n\n![mutable](https://example.com/current.png)\n\n<script>window.attack=1</script>';
  const { container } = render(<DshFilePreview {...base()} kind="markdown" text={text} />);
  expect(screen.getByRole('heading', { name: '样例' })).toBeInTheDocument();
  expect(container.querySelector('table')).toHaveTextContent('12');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('mutable')).toBeInTheDocument();
});
it('uses ImageBody Blob image and zoom; revokes the resource on unmount', async () => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const view = render(<DshFilePreview {...base()} name="sample.png" kind="image" bytes={bytes} />);
  const image = await screen.findByRole('img', { hidden: true });
  expect(image).toHaveAttribute('src', 'blob:sample-image');
  Object.defineProperty(image, 'naturalWidth', { value: 1 });
  fireEvent.load(image);
  expect(view.container.querySelector('[data-document-zoom-controls]')).not.toBeNull();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sample-image');
});
it('uses PdfBody actual pages and requested page state; disposes owned PDF session', async () => {
  const view = render(<DshFilePreview {...base()} name="sample.pdf" kind="pdf" bytes={new TextEncoder().encode('%PDF-1.7')} page={2} />);
  await screen.findByRole('img', { name: 'PDF 第 2 页' });
  await waitFor(() => expect(pdf.render).toHaveBeenCalled());
  expect(view.container.querySelectorAll('[data-pdf-page]')).toHaveLength(2);
  view.unmount(); expect(pdf.dispose).toHaveBeenCalledOnce();
  expect(pdf.open.mock.calls[0][1].aborted).toBe(true);
});
it('ignores a delayed PDF document after unmount', async () => {
  let complete!: (value: unknown) => void;
  pdf.open.mockReturnValue({ document: new Promise(resolve => { complete = resolve; }), dispose: pdf.dispose });
  const view = render(<DshFilePreview {...base()} kind="pdf" bytes={new Uint8Array([1])} />);
  await waitFor(() => expect(pdf.open).toHaveBeenCalled());
  view.unmount();
  await act(async () => complete({ numPages: 3 }));
  expect(pdf.render).not.toHaveBeenCalled(); expect(pdf.dispose).toHaveBeenCalledOnce();
});
it('reports page or line locators outside the requested version instead of silently landing elsewhere', async () => {
  const view = render(<DshFilePreview {...base()} kind="pdf" bytes={new Uint8Array([1])} page={99} />);
  await screen.findByText('第 99 页不在此版本的 2 页内');
  view.unmount();
  render(<DshFilePreview {...base()} kind="text" text="one line" line={99} />);
  expect(screen.getByText('请求行不在此版本的源码范围内。')).toBeInTheDocument();
});

it('restores scroll after asynchronous renderer layout grows and stops restoring after user input', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
  let maximum = 0; const positions = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true,
    get() { return positions.get(this) ?? 0; },
    set(value: number) { positions.set(this, Math.min(maximum, value)); }
  });
  try {
    const changed = vi.fn();
    const view = render(<DshFilePreview {...base()} kind="text" text="delayed layout" initialView={{ scrollTop: 88 }} onViewChange={changed} />);
    const scroll = view.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
    expect(scroll.scrollTop).toBe(0);
    maximum = 200;
    await act(async () => { scroll.firstElementChild!.setAttribute('data-layout-ready', 'true'); });
    expect(scroll.scrollTop).toBe(88);
    fireEvent.wheel(scroll); scroll.scrollTop = 25; fireEvent.scroll(scroll);
    await act(async () => { scroll.firstElementChild!.setAttribute('data-layout-ready', 'changed'); });
    expect(scroll.scrollTop).toBe(25);
    expect(changed).toHaveBeenLastCalledWith({ scrollTop: 25 });
    view.unmount();
  } finally { Object.defineProperty(Element.prototype, 'scrollTop', descriptor); }
});

it('restores PDF zoom and late initial scroll with a saved page, then retains user view', async () => {
  const changed = vi.fn(); const props = { ...base(), kind: 'pdf' as const, bytes: new Uint8Array([1]), page: 2, onViewChange: changed };
  const view = render(<DshFilePreview {...props} />);
  await screen.findByRole('img', { name: 'PDF 第 2 页' });
  view.rerender(<DshFilePreview {...props} initialView={{ zoom: 1.75, scrollTop: 384 }} />);
  const frame = view.container.querySelector('[data-document-zoom-frame]') as HTMLElement;
  expect(frame).toHaveAttribute('data-document-zoom-mode', 'fixed');
  expect(frame.style.getPropertyValue('--document-zoom')).toBe('1.75');
  const scroll = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLElement;
  expect(scroll.scrollTop).toBe(384);
  fireEvent.wheel(scroll); scroll.scrollTop = 410; fireEvent.scroll(scroll);
  expect(changed).toHaveBeenCalledWith({ scrollTop: 410 });
  view.rerender(<DshFilePreview {...props} initialView={{ zoom: 1.75, scrollTop: 400 }} />);
  expect(scroll.scrollTop).toBe(410);
  view.unmount(); expect(pdf.dispose).toHaveBeenCalledOnce();
});
it('restores a PDF page after asynchronous page sizes settle, and restores zoom on actual remount', async () => {
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('data-pdf-page') !== '2') return 0;
    const first = this.parentElement?.querySelector('[data-pdf-page="1"] [data-document-zoom-surface]') as HTMLElement | null;
    return first && !first.hidden ? 620 : 120;
  });
  try {
    const props = { ...base(), kind: 'pdf' as const, bytes: new Uint8Array([1]), page: 2, initialView: { zoom: 1.5 } };
    const view = render(<DshFilePreview {...props} />);
    await screen.findByRole('img', { name: 'PDF 第 2 页' });
    const scroll = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLElement;
    await waitFor(() => expect(scroll.scrollTop).toBe(620));
    expect((view.container.querySelector('[data-document-zoom-frame]') as HTMLElement).style.getPropertyValue('--document-zoom')).toBe('1.5');
    view.unmount();
    const reopened = render(<DshFilePreview {...props} initialView={{ zoom: 0 }} />);
    await screen.findByRole('img', { name: 'PDF 第 2 页' });
    await waitFor(() => expect((reopened.container.querySelector('[data-document-zoom-scrollport]') as HTMLElement).scrollTop).toBe(620));
    expect(reopened.container.querySelector('[data-document-zoom-frame]')).toHaveAttribute('data-document-zoom-mode', 'fit-width');
    reopened.unmount(); expect(pdf.dispose).toHaveBeenCalledTimes(2);
  } finally { offset.mockRestore(); }
});

it('does not report a preloaded adjacent PDF page as the restored visible page', async () => {
  const observers: Array<{node?: Element; fire: IntersectionObserverCallback}> = [];
  vi.stubGlobal('IntersectionObserver', class {
    entry: {node?: Element;fire: IntersectionObserverCallback};
    constructor(fire: IntersectionObserverCallback) { this.entry = {fire}; observers.push(this.entry); }
    observe(node: Element) { this.entry.node = node; } disconnect() {}
  });
  const changed = vi.fn();
  const view = render(<DshFilePreview {...base()} kind="pdf" bytes={new Uint8Array([1])} page={2} onViewChange={changed} />);
  await screen.findByRole('img', {name:'PDF 第 2 页'});
  await waitFor(() => expect(view.container.querySelector('[data-pdf-page="1"] [data-document-zoom-surface]')).not.toHaveAttribute('hidden'));
  const scroll = view.container.querySelector('[data-document-zoom-scrollport]') as HTMLElement;
  Object.defineProperty(scroll, 'clientHeight', {value:400});
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({top:100,bottom:500} as DOMRect);
  const first = view.container.querySelector('[data-pdf-page="1"]') as HTMLElement;
  const second = view.container.querySelector('[data-pdf-page="2"]') as HTMLElement;
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({top:-520,bottom:100} as DOMRect);
  vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({top:100,bottom:720} as DOMRect);
  changed.mockClear();
  await act(async () => {
    for (const entry of observers) entry.fire([{isIntersecting:true,target:entry.node!} as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  expect(changed).not.toHaveBeenCalledWith({page:1});
  expect(changed).toHaveBeenCalledWith({page:2});
  view.unmount();
});
