import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MarkdownEditor } from '../../../src/components/markdown/MarkdownEditor';
import { exportEditorFile } from '../../../src/services/editorExport';
import { printEditorHtml, renderEditorPdf } from '../../../src/services/editorPrint';

// Keep both services and desktopApi real. Only Tauri's native IPC boundary is
// replaced: this verifies the connected path, not an operating-system dialog.
afterEach(() => { clearMocks(); vi.restoreAllMocks(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function exportWord() {
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button', { name: '导出 Word (.docx)' }));
}

it('exports editable DOCX through the connected desktop service and waits for the actual write result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-desktop-export-'));
  const completed = deferred();
  const written = deferred();
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const source = '\uFEFF---\r\ntitle: metadata\r\n---\r\n\r\n# 原生副本\r\n\r\n**中文正文**\r\n\r\n| 列 |\r\n| --- |\r\n| 值 |\r\n';
  const changed = vi.fn();
  mockIPC(async (command, args) => {
    if (command === 'plugin:dialog|save') {
      expect(args).toMatchObject({ options: { defaultPath: '原生副本.docx', filters: [{ extensions: ['docx'] }] } });
      return join(directory, '副本');
    }
    if (command === 'desktop_write_export_file') {
      const input = (args as { input: { targetPath: string; dataBase64: string; overwrite: boolean } }).input;
      expect(input.targetPath).toBe(join(directory, '副本.docx'));
      expect(input.overwrite).toBe(false);
      await writeFile(input.targetPath, Buffer.from(input.dataBase64, 'base64'), { flag: 'wx' });
      written.resolve();
      await completed.promise;
      return input.targetPath;
    }
    throw Error(`Unexpected IPC: ${command}`);
  });
  try {
    render(<MarkdownEditor value={source} onChange={changed} onExport={exportEditorFile} readOnly />);
    exportWord();
    await written.promise;
    expect(screen.queryByText('已导出 Word 文档。')).toBeNull();
    const docx = await JSZip.loadAsync(await readFile(join(directory, '副本.docx')));
    const xml = await docx.file('word/document.xml')!.async('string');
    expect(xml).toContain('原生副本');
    expect(xml).toContain('中文正文');
    expect(xml).toContain('<w:b');
    expect(xml).toContain('<w:tbl>');
    expect(xml).not.toContain('metadata');
    completed.resolve();
    await screen.findByText('已导出 Word 文档。');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Markdown 源码' })).toHaveTextContent('中文正文');
    expect(anchor).not.toHaveBeenCalled();
  } finally {
    completed.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['cancel', 'write failure'] as const)('reports native export %s without an anchor fallback', async outcome => {
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const writes = vi.fn();
  mockIPC(async command => {
    if (command === 'plugin:dialog|save') return outcome === 'cancel' ? null : '/tmp/副本.docx';
    if (command === 'desktop_write_export_file') {
      writes();
      throw '目标文件已存在';
    }
    throw Error(`Unexpected IPC: ${command}`);
  });
  render(<MarkdownEditor value="# 原生导出" onChange={() => {}} onExport={exportEditorFile} />);
  exportWord();
  if (outcome === 'cancel') {
    await screen.findByText('已取消导出。');
    expect(writes).not.toHaveBeenCalled();
  } else {
    expect(await screen.findByRole('alert')).toHaveTextContent('目标文件已存在');
    expect(screen.queryByText('已导出 Word 文档。')).toBeNull();
  }
  expect(anchor).not.toHaveBeenCalled();
});

it('hands a self-contained current print document to native IPC and awaits native completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-desktop-print-'));
  const completed = deferred();
  const prepared = deferred();
  const browserPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
  const changed = vi.fn();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR4AeyTsQkAAAzCgv//bOkNDi4Krg7ByOCkIswGYAzG4DXq/+AAAAD//xTgAbwAAAAGSURBVAMAwoMgAWvW/A4AAAAASUVORK5CYII=';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe(location.origin);
    const bytes = await readFile(join(process.cwd(), '../../node_modules/katex/dist/fonts', url.pathname.split('/').pop()!));
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'font/woff2' } });
  });
  mockIPC(async (command, args) => {
    if (command !== 'desktop_print_editor_html') throw Error(`Unexpected IPC: ${command}`);
    const input = (args as { input: { html: string; title?: string } }).input;
    expect(input.title).toBe('原生打印');
    expect(input).toMatchObject({ pageSize: { widthPt: 210 * 72 / 25.4, heightPt: 297 * 72 / 25.4 } });
    expect(input.html).toContain('@page { size: 210mm 297mm; }');
    await writeFile(join(directory, 'print.html'), input.html);
    prepared.resolve();
    await completed.promise;
  });
  try {
    render(<MarkdownEditor value={'\uFEFF---\r\ntitle: private\r\n---\r\n\r\n# 原生打印\r\n\r\n$x^2$\r\n\r\n![内嵌图](pixel.png)\r\n'} onChange={changed} resources={{ 'pixel.png': image }} onPrint={printEditorHtml} readOnly />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Markdown 源码' }), { key: 'p', ctrlKey: true });
    await prepared.promise;
    expect(screen.queryByText('已提交系统打印。')).toBeNull();
    const html = await readFile(join(directory, 'print.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('h1')?.textContent).toBe('原生打印');
    expect(doc.querySelector('.katex')).not.toBeNull();
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(image);
    expect(doc.querySelector('script,base,[contenteditable],.md-block-gutter')).toBeNull();
    expect(doc.body.textContent).not.toContain('title: private');
    const fonts = Array.from(html.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/gu));
    expect(fonts).toHaveLength(20);
    for (const font of fonts) expect(Buffer.from(font[1], 'base64').subarray(0, 4).toString()).toBe('wOF2');
    expect(html).not.toMatch(/url\(["']?(?:https?:|\/|fonts\/)/u);
    completed.resolve();
    await screen.findByText('已提交系统打印。');
    expect(browserPrint).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    completed.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

it('surfaces native print cancellation/failure without reporting completion or printing in the browser', async () => {
  const browserPrint = vi.spyOn(window, 'print').mockImplementation(() => {});
  mockIPC(async command => {
    if (command !== 'desktop_print_editor_html') throw Error(`Unexpected IPC: ${command}`);
    throw '打印已取消或系统打印失败';
  });
  render(<MarkdownEditor value="# 打印" onChange={() => {}} onPrint={printEditorHtml} />);
  fireEvent.click(screen.getByText('导出与打印'));
  fireEvent.click(screen.getByRole('button', { name: '打印…' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('打印已取消或系统打印失败');
  await waitFor(() => expect(screen.queryByText('已提交系统打印。')).toBeNull());
  expect(browserPrint).not.toHaveBeenCalled();
  expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
});

it('round-trips native PDF base64 through the connected services to exact on-disk PDF bytes', async () => {
  const output = join(process.cwd(), 'output');
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'desktop-pdf-contract-'));
  const renderComplete = deferred(), writeComplete = deferred();
  const fixture = await PDFDocument.create();
  fixture.addPage([595.28, 841.89]).drawText('Native PDF output contract', { font: await fixture.embedFont(StandardFonts.Helvetica) });
  const bytes = await fixture.save();
  const rendering = vi.fn(), selecting = vi.fn(), written = vi.fn(), changed = vi.fn();
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mockIPC(async (command, args) => {
    if (command === 'desktop_render_editor_pdf') {
      const input = (args as { input: { html: string; title?: string } }).input;
      rendering(input);
      await renderComplete.promise;
      return Buffer.from(bytes).toString('base64');
    }
    if (command === 'plugin:dialog|save') {
      selecting(args);
      return join(directory, '原生链路');
    }
    if (command === 'desktop_write_export_file') {
      const input = (args as { input: { targetPath: string; dataBase64: string; overwrite: boolean } }).input;
      expect(input.targetPath).toBe(join(directory, '原生链路.pdf'));
      expect(input.overwrite).toBe(false);
      await writeFile(input.targetPath, Buffer.from(input.dataBase64, 'base64'), { flag: 'wx' });
      written();
      await writeComplete.promise;
      return input.targetPath;
    }
    throw Error(`Unexpected IPC: ${command}`);
  });
  try {
    render(<MarkdownEditor value={'\uFEFF---\r\ntitle: private\r\n---\r\n\r\n# 原生链路\r\n\r\n正文\r\n'} onChange={changed} onRenderPdf={renderEditorPdf} onExport={exportEditorFile} readOnly />);
    fireEvent.click(screen.getByText('导出与打印'));
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF (.pdf)' }));
    await waitFor(() => expect(rendering).toHaveBeenCalledOnce());
    expect(selecting).not.toHaveBeenCalled();
    const prepared = rendering.mock.calls[0][0] as { html: string; title?: string };
    const doc = new DOMParser().parseFromString(prepared.html, 'text/html');
    expect(prepared.title).toBe('原生链路');
    expect(doc.querySelector('h1')?.textContent).toBe('原生链路');
    expect(doc.body.textContent).not.toContain('title: private');
    expect(doc.querySelector('base,script,[contenteditable]')).toBeNull();
    renderComplete.resolve();
    await waitFor(() => expect(written).toHaveBeenCalledOnce());
    expect(selecting).toHaveBeenCalledOnce();
    expect(screen.queryByText('已导出 PDF 文档。')).toBeNull();
    const saved = await readFile(join(directory, '原生链路.pdf'));
    expect(saved).toEqual(Buffer.from(bytes));
    const reopened = await PDFDocument.load(new Uint8Array(saved));
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
    writeComplete.resolve();
    await screen.findByText('已导出 PDF 文档。');
    expect(changed).not.toHaveBeenCalled();
    expect(anchor).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[data-markdown-print]')).toBeNull();
  } finally {
    renderComplete.resolve(); writeComplete.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});
