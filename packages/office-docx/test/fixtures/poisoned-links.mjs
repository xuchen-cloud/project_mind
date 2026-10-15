import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

export const poisonedHref = 'javascript:window.__officePoisonedLink=1';

/** Copy the real existing relationship/link; include its protected field-result path. */
export async function poisonedLinksFixture() {
  const zip = await JSZip.loadAsync(await readFile(new URL('complex.original.docx', import.meta.url)));
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  zip.file('word/_rels/document.xml.rels', rels.replace('Target="https://example.com/docx-validation"', `Target="${poisonedHref}"`));
  const xml = await zip.file('word/document.xml').async('string');
  const existingLink = xml.match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>/)[0];
  const protectedParagraph = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> SEQ preserved </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + existingLink +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const at = xml.lastIndexOf('<w:sectPr');
  zip.file('word/document.xml', xml.slice(0, at) + protectedParagraph + xml.slice(at));
  return zip.generateAsync({ type: 'uint8array' });
}
