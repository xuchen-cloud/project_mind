import { Editor } from '@tiptap/core';
import { afterEach, expect, it, vi } from 'vitest';
import { buildRichEditorExtensions, recordDocumentSchema } from './extensions';
import { initializeRecordDocument, validateRecordDocument } from '../../lib/record-document';
import { serializeRecordDocument } from '../../lib/record-document-format';
import { parseRecordHtml } from '../../lib/record-document-html';
import { projectRecordExportDocument } from '../../features/record-export/recordExportModel';
import { generateMarkdown } from '../../features/record-export/markdownGenerator';
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from '../../lib/richTextStyle';

const { renderSafeDiagram } = vi.hoisted(() => ({ renderSafeDiagram: vi.fn(async () => ({ ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>canonical</text></svg>' })) }));
vi.mock('../../../packages/markdown-editor/src/adapters/diagramPreviewSafety', () => ({ renderSafeDiagram }));
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); renderSafeDiagram.mockClear(); });

it.each(['workspace', 'project'] as const)('keeps %s Record Mermaid language and source across canonical save, HTML projection, reopen, edit and Markdown export', async recordKind => {
  const source = 'flowchart LR\n\n  A["中文长标签与已确认正文"] --> B[完成]\n';
  const canonical = initializeRecordDocument({ type: 'doc', content: [
    { type: 'codeBlock', attrs: { language: 'mermaid', languageExplicit: true }, content: [{ type: 'text', text: source }] },
    { type: 'paragraph' },
  ] }, recordDocumentSchema);
  const saved = serializeRecordDocument(canonical, recordDocumentSchema);
  const restored = parseRecordHtml(saved.html, recordDocumentSchema);
  // G01 owns this language/HTML contract. A lossy parser must fail here.
  expect(restored).toEqual(canonical);
  const editor = new Editor({ extensions: buildRichEditorExtensions('', { stableBlocks: true, recordKey: recordKind }), content: restored });
  editors.push(editor);
  await vi.waitFor(() => expect(editor.view.dom.querySelector('.rich-editor__mermaid-preview svg')).not.toBeNull());
  expect(renderSafeDiagram).toHaveBeenCalledWith('mermaid', source, 'light');
  expect(editor.getHTML()).not.toContain('<svg');
  editor.commands.insertContentAt(1, '%% 已修改\n');
  const edited = validateRecordDocument(editor.getJSON(), recordDocumentSchema);
  const projection = serializeRecordDocument(edited, recordDocumentSchema);
  expect(parseRecordHtml(projection.html, recordDocumentSchema)).toEqual(edited);
  const exported = projectRecordExportDocument({ recordKind, tags: [], committedHtml: projection.html, style: DEFAULT_RICH_TEXT_STYLE_SETTINGS });
  expect(generateMarkdown(exported)).toContain('```mermaid\n%% 已修改\n' + source + '\n```');
});
