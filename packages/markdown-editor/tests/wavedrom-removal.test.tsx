import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {EditorView} from '@codemirror/view';
import {expect, it, vi} from 'vitest';
import JSZip from 'jszip';
import {MarkdownEditor} from '../../../src/components/markdown/MarkdownEditor';
import {SafeMarkdownPreview} from '../src/adapters/SafeMarkdownPreview';
import {DIAGRAM_LANGUAGES, diagramLanguage} from '../src/genoffice/editor/diagrams';
import {buildSlashItems} from '../src/genoffice/editor/slashCommand';
import {diagramLanguage as exportLanguage} from '../src/export/diagram-language';
import {prepareExportDocument} from '../src/export/document';
import {deliverMarkdownExport} from '../src/export/browser';

const sources = ["{signal:[{name:'clk',wave:'p..'}]}", "{reg:[{bits:8,name:'DATA'}]}", "{assign:[['out',['&','a','b']]]}"];
const fence = (source: string) => `\`\`\`wavedrom\n${source}\n\`\`\``;
const allCode = sources.map(fence).join('\n\n');

it('offers only Mermaid diagrams while retaining math and ordinary code insertion', () => {
  expect(DIAGRAM_LANGUAGES).toEqual(['mermaid']);
  expect(diagramLanguage('wavedrom')).toBeNull();
  expect(exportLanguage('wavedrom')).toBeNull();
  const items = buildSlashItems();
  expect(items.some(item => item.id === 'waveform' || item.keywords.includes('wavedrom'))).toBe(false);
  expect(items.map(item => item.id)).toEqual(expect.arrayContaining(['diagram', 'math', 'code']));
  render(<MarkdownEditor value="" onChange={() => {}} />);
  expect(screen.queryByRole('button', {name: /WaveDrom|波形|时序图/u})).toBeNull();
  expect(screen.getByRole('button', {name: /Mermaid/u})).toBeInTheDocument();
  expect(screen.getByRole('button', {name: '公式'})).toBeInTheDocument();
});

it.each([...sources, '{signal: nope}', ''])('previews WaveDrom fences as plain code without parsing: %s', source => {
  const {container} = render(<SafeMarkdownPreview text={fence(source)} resources={{}} />);
  expect(container.querySelector('[data-diagram-language]')).toBeNull();
  expect(container.querySelector('pre code')?.textContent?.trimEnd()).toBe(source);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps original fences and BOM/CRLF through rich view, source edits and reopen', async () => {
  const original = '\uFEFF# Code\r\n\r\n' + allCode.replaceAll('\n', '\r\n') + '\r\n';
  let current = original;
  const changed = vi.fn((value: string) => {current = value;});
  const result = render(<MarkdownEditor value={original} onChange={changed} initialView={{mode: 'rich'}} />);
  expect(result.container.querySelector('.md-diagram-preview')).toBeNull();
  expect([...result.container.querySelectorAll('pre code')].map(code => code.textContent)).toEqual(sources);
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: '源码'}));
  const source = await screen.findByRole('textbox', {name: 'Markdown 源码'});
  const view = EditorView.findFromDOM(source)!;
  const from = view.state.doc.toString().indexOf('clk');
  act(() => view.dispatch({changes: {from, to: from + 3, insert: 'clock'}}));
  expect(current).toBe(original.replace('clk', 'clock'));
  result.unmount();
  const reopened = render(<MarkdownEditor value={current} onChange={changed} readOnly initialView={{mode: 'rich'}} />);
  expect(reopened.container.querySelector('pre code')?.textContent).toBe(sources[0].replace('clk', 'clock'));
  expect(reopened.container.querySelector('.md-diagram-preview')).toBeNull();
});

it('exports former WaveDrom blocks as text in real HTML and DOCX without a diagram callback', async () => {
  const document = await prepareExportDocument(allCode, {});
  const html = new DOMParser().parseFromString(document.html, 'text/html');
  expect([...html.querySelectorAll('pre code')].map(code => code.textContent)).toEqual(sources);
  expect(html.querySelector('svg')).toBeNull();
  expect(document.warnings).toEqual([]);
  let bytes: Uint8Array | undefined;
  await deliverMarkdownExport(document, 'docx', new AbortController().signal, () => {}, async file => {bytes = file.bytes; return true;});
  const zip = await JSZip.loadAsync(bytes!);
  const xml = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
  for (const source of sources) expect(xml.documentElement.textContent).toContain(source);
  expect(Object.keys(zip.files).some(file => file.startsWith('word/media/'))).toBe(false);
});

it('hands plain WaveDrom code to the real print callback without modifying source', async () => {
  const printed = vi.fn(async (_document: {html: string}) => {}), changed = vi.fn();
  render(<MarkdownEditor value={allCode} onChange={changed} onPrint={printed} readOnly />);
  fireEvent.click(screen.getByRole('button', {name: '文件菜单'}));
  fireEvent.click(screen.getByRole('menuitem', {name: '打印…'}));
  await waitFor(() => expect(printed).toHaveBeenCalledOnce());
  const html = new DOMParser().parseFromString(printed.mock.calls[0][0].html, 'text/html');
  expect([...html.querySelectorAll('pre code')].map(code => code.textContent)).toEqual(sources);
  expect(html.querySelector('svg')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
