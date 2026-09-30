import { writeFile } from 'node:fs/promises';
import { handleRecordDocumentRequest } from '../packages/agent-host/dist/record-document-worker.mjs';

const response = await handleRecordDocumentRequest({ requestId: 'schema-contract', method: 'record.schema' });
if (!response.ok) throw new Error('Cannot obtain the editor schema contract');
await writeFile(new URL('../src-tauri/src/record_document_schema.json', import.meta.url), `${JSON.stringify(response.data, null, 2)}\n`);
const id = (value) => value.repeat(32);
const document = { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: id('1') }, content: [{ type: 'text', text: 'Fixture 正文', marks: [{ type: 'bold' }] }] },
  { type: 'table', attrs: { blockId: id('2') }, content: [{ type: 'tableRow', attrs: { blockId: id('3') }, content: [
    { type: 'tableCell', attrs: { blockId: id('4'), colwidth: [120] }, content: [{ type: 'paragraph', attrs: { blockId: id('5') } }] },
  ] }] },
  { type: 'image', attrs: { blockId: id('6'), path: 'assets/图片.png', width: 120, annotationState: '{"shape":"rect"}' } },
  { type: 'attachment', attrs: { blockId: id('7'), path: 'assets/文件.pdf', title: '文件', meta: 'PDF' } },
] };
const fixture = await handleRecordDocumentRequest({ requestId: 'projection-contract', method: 'record.validate', data: { document, codeLanguage: 'typescript' } });
if (!fixture.ok) throw new Error('Cannot obtain document projection fixture');
await writeFile(new URL('../src-tauri/src/record_document_projection.fixture.json', import.meta.url), `${JSON.stringify(fixture.data, null, 2)}\n`);
