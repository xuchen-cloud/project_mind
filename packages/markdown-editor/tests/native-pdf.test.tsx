import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function exportPdf() {
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button', { name: '导出 PDF (.pdf)' }));
}

it('delivers physical Markdown pages with their own 20mm margins to a zero-margin native printer', async () => {
  const printed = vi.fn(async (_document: { html: string }) => {});
  const changed = vi.fn();
  render(<MarkdownEditor value={'\uFEFF# 纸面标题\r\n\r\n正文保留在纸张内。\r\n'} onChange={changed} onPrint={printed} readOnly />);
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button', { name: '打印…' }));
  await waitFor(() => expect(printed).toHaveBeenCalledOnce());
  const doc = new DOMParser().parseFromString(printed.mock.calls[0][0].html, 'text/html');
  const page = doc.body.querySelector<HTMLElement>('.md-print-page');
  expect(page).not.toBeNull();
  expect(page?.style.width).toBe('210mm');
  expect(page?.style.height).toBe('297mm');
  expect(page?.style.padding).toBe('20mm');
  expect(page?.querySelector('h1')?.textContent).toBe('纸面标题');
  expect(page?.querySelector('.md-print-content')?.textContent).toContain('正文保留在纸张内。');
  expect(doc.body.children).toHaveLength(1);
  expect(doc.querySelector('script,base,[contenteditable]')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(document.querySelector('iframe[data-markdown-pagination]')).toBeNull();
});

it('uses the latest native PDF renderer with embedded print assets and exports its bytes unchanged after completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-native-pdf-'));
  const renderComplete = deferred(), writeComplete = deferred();
  const nativePdf = await PDFDocument.create();
  nativePdf.addPage([595.28, 841.89]).drawText('Native PDF selectable text', { font: await nativePdf.embedFont(StandardFonts.Helvetica) });
  const bytes = await nativePdf.save();
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe(location.origin);
    const font = await readFile(join(process.cwd(), '../../node_modules/katex/dist/fonts', url.pathname.split('/').pop()!));
    return new Response(new Uint8Array(font));
  });
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR4AeyTsQkAAAzCgv//bOkNDi4Krg7ByOCkIswGYAzG4DXq/+AAAAD//xTgAbwAAAAGSURBVAMAwoMgAWvW/A4AAAAASUVORK5CYII=';
  const previous = vi.fn();
  const renderPdf = vi.fn(async (_document: { html: string; title?: string }) => { await renderComplete.promise; return bytes; });
  const write = vi.fn(async (file: { name: string; mime: string; bytes: Uint8Array }) => {
    await writeFile(join(directory, file.name), file.bytes);
    await writeComplete.promise;
    return true;
  });
  const changed = vi.fn();
  const { rerender } = render(<MarkdownEditor value="# 旧内容" onChange={changed} onRenderPdf={previous} onExport={write} />);
  const value = '\uFEFF---\r\ntitle: private\r\n---\r\n\r\n# 原生 PDF\r\n\r\n$x^2$\r\n\r\n![图](pixel.png)\r\n';
  rerender(<MarkdownEditor value={value} onChange={changed} resources={{ 'pixel.png': image }} onRenderPdf={renderPdf} onExport={write} readOnly />);
  try {
    exportPdf();
    await waitFor(() => expect(renderPdf).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
    const prepared = renderPdf.mock.calls[0][0];
    expect(prepared).toMatchObject({ pageSize: { widthPt: 210 * 72 / 25.4, heightPt: 297 * 72 / 25.4 } });
    const doc = new DOMParser().parseFromString(prepared.html, 'text/html');
    expect(Array.from(doc.querySelectorAll('style')).some(style => /@page\s*\{\s*size:\s*210mm 297mm;/u.test(style.textContent ?? ''))).toBe(true);
    expect(prepared.title).toBe('原生 PDF');
    expect(doc.querySelector('h1')?.textContent).toBe('原生 PDF');
    expect(doc.querySelector('.katex')).not.toBeNull();
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(image);
    expect(prepared.html).toContain('data:font/woff2;base64,');
    expect(doc.querySelector('script,base,[contenteditable]')).toBeNull();
    expect(doc.body.textContent).not.toContain('title: private');
    expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
    renderComplete.resolve();
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(screen.queryByText('已导出 PDF 文档。')).toBeNull();
    expect(write.mock.calls[0][0]).toMatchObject({ name: '原生 PDF.pdf', mime: 'application/pdf' });
    expect(write.mock.calls[0][0].bytes).toBe(bytes);
    await waitFor(async () => expect(await readFile(join(directory, '原生 PDF.pdf'))).toEqual(Buffer.from(bytes)));
    expect((await PDFDocument.load(new Uint8Array(await readFile(join(directory, '原生 PDF.pdf'))))).getPageCount()).toBe(1);
    writeComplete.resolve();
    await screen.findByText('已导出 PDF 文档。');
    expect(previous).not.toHaveBeenCalled();
    expect(anchor).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    renderComplete.resolve(); writeComplete.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['render failure', 'save cancellation'] as const)('reports native PDF %s without raster or download fallback', async outcome => {
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const write = vi.fn(async () => false);
  const renderPdf = vi.fn(async () => {
    if (outcome === 'render failure') throw '原生 PDF 排版失败';
    return new Uint8Array([37, 80, 68, 70]);
  });
  render(<MarkdownEditor value="# PDF" onChange={() => {}} onRenderPdf={renderPdf} onExport={write} />);
  exportPdf();
  if (outcome === 'render failure') {
    expect(await screen.findByRole('alert')).toHaveTextContent('原生 PDF 排版失败');
    expect(write).not.toHaveBeenCalled();
  } else {
    await screen.findByText('已取消导出。');
    expect(write).toHaveBeenCalledOnce();
  }
  expect(screen.queryByText('已导出 PDF 文档。')).toBeNull();
  expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
  expect(anchor).not.toHaveBeenCalled();
});

it('discards a native PDF result after the external document baseline changes', async () => {
  const completed = deferred();
  const renderPdf = vi.fn(async () => { await completed.promise; return new Uint8Array([37, 80, 68, 70]); });
  const write = vi.fn(async () => true);
  const { rerender } = render(<MarkdownEditor documentKey="old" value="# 旧版本" onChange={() => {}} onRenderPdf={renderPdf} onExport={write} />);
  exportPdf();
  await waitFor(() => expect(renderPdf).toHaveBeenCalledOnce());
  rerender(<MarkdownEditor documentKey="new" value="# 新版本" onChange={() => {}} onRenderPdf={renderPdf} onExport={write} />);
  await act(async () => { completed.resolve(); await renderPdf.mock.results[0].value; });
  expect(write).not.toHaveBeenCalled();
  expect(screen.queryByText('已导出 PDF 文档。')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Markdown 源码' })).toHaveTextContent('新版本');
});
