import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import JSZip from 'jszip';

export const APPENDED_BLOCKS = 320;
export const INITIAL_BLOCKS = 12;
export const NEXT_BLOCKS = 9;
export const ADDED_PREFIX = '渐进追加段落 #303 / ';
export const TAIL_WITNESS = 'DOCX_PROGRESSIVE_TAIL_WITNESS_303';
export const FIRST_ORIGINAL = '待修改中文段落：春风拂面。';
export const SECOND_ORIGINAL = '图片后未修改段落。';
export const FIRST_EDIT = '渐进首屏第一笔编辑：秋风拂面。';
export const SECOND_EDIT = '同一原始 source 上的第二笔编辑：冬雪纷飞。';
export const OPAQUE_PATH = 'customXml/progressive-opaque.xml';
export const MEDIA_PATH = 'word/media/progressive-untouched.png';
export const OPAQUE_RELS_PATH = 'customXml/_rels/progressive-opaque.xml.rels';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const text = node => node.type === 'text' ? node.text : (node.content ?? []).map(text).join('');

export async function largeFixture() {
  const zip = await JSZip.loadAsync(await readFile(new URL('simple.original.docx', import.meta.url)));
  const paragraphs = Array.from({ length: APPENDED_BLOCKS }, (_, index) =>
    `${ADDED_PREFIX}${String(index + 1).padStart(3, '0')}${index === APPENDED_BLOCKS - 1 ? ` / ${TAIL_WITNESS}` : ''}`);
  const xml = await zip.file('word/document.xml').async('string');
  assert.equal((xml.match(/<w:sectPr\b/g) ?? []).length, 1, 'Append before the simple fixture\'s trailing section');
  zip.file('word/document.xml', xml.replace('<w:sectPr',
    paragraphs.map(value => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`).join('') + '<w:sectPr'));

  // These parts are deliberately outside the edited paragraphs. Whitespace,
  // comments, relationship ordering and media bytes must survive both saves.
  zip.file(OPAQUE_PATH, '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<opaque:payload xmlns:opaque="urn:project-mind:progressive:opaque" keep="  原样  ">\n' +
    '  <!-- #303 untouched opaque witness -->\n  <opaque:value><![CDATA[opaque <&> bytes]]></opaque:value>\n' +
    '</opaque:payload>\n');
  zip.file(MEDIA_PATH, await zip.file('word/media/image1.png').async('uint8array'));
  zip.file(OPAQUE_RELS_PATH, `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="${RELS_NS}">\n` +
    `  <Relationship Id="rIdOpaqueMedia303" Type="${IMAGE_REL}" Target="../word/media/progressive-untouched.png"/>\n` +
    '</Relationships>\n');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdProgressiveOpaque303" Type="urn:project-mind:progressive:opaque" Target="../customXml/progressive-opaque.xml"/>' +
    `<Relationship Id="rIdProgressiveMedia303" Type="${IMAGE_REL}" Target="media/progressive-untouched.png"/>` +
    '</Relationships>'));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace('</Types>',
    `<Override PartName="/${OPAQUE_PATH}" ContentType="application/xml"/></Types>`));
  return { bytes: await zip.generateAsync({ type: 'uint8array' }), paragraphs };
}
