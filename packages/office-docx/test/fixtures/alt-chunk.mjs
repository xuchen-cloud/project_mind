import {readFile} from 'node:fs/promises';
import JSZip from 'jszip';
export const altChunkHtml='<!doctype html><html><body><p><strong>HTML 导入片段：格式与原件保留</strong></p></body></html>';
export const richAltChunkHtml=`<!doctype html><html><body><p><strong>HTML 导入片段：格式与原件保留</strong></p><p><em>转换器真实斜体</em></p><ul><li>导入列表第一项</li><li>导入列表第二项</li></ul><table style="border-collapse:collapse;width:320px"><tr><td style="border:1px solid black">转换表格甲</td><td style="border:1px solid black">转换表格乙</td></tr><tr><td style="border:1px solid black">转换表格丙</td><td style="border:1px solid black">转换表格丁</td></tr></table><p><img width="10" height="10" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR4nGP4z8DwnxjMMKqQvgoBksPHOas6/LEAAAAASUVORK5CYII=" alt="导入图片"></p></body></html>`;
export async function altChunkFixture(html=altChunkHtml){
 const zip=await JSZip.loadAsync(await readFile(new URL('complex.original.docx',import.meta.url)));
 zip.file('word/altChunk1.html',html);
 const rels=await zip.file('word/_rels/document.xml.rels').async('string');zip.file('word/_rels/document.xml.rels',rels.replace('</Relationships>','<Relationship Id="rAltChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="altChunk1.html"/></Relationships>'));
 const types=await zip.file('[Content_Types].xml').async('string');zip.file('[Content_Types].xml',types.replace('</Types>','<Override PartName="/word/altChunk1.html" ContentType="text/html"/></Types>'));
 const xml=await zip.file('word/document.xml').async('string'),at=xml.lastIndexOf('<w:sectPr');zip.file('word/document.xml',xml.slice(0,at)+'<w:altChunk r:id="rAltChunk"/>'+xml.slice(at));
 return zip.generateAsync({type:'uint8array'});
}
/** Genuine DOCX conversion receipt fixture, not an HTML-as-DOCX byte substitute. */
export async function convertedAltChunkFixture(){
 const zip=await JSZip.loadAsync(await readFile(new URL('complex.original.docx',import.meta.url)));
 const xml=await zip.file('word/document.xml').async('string');zip.file('word/document.xml',xml.replace(/<w:body>[\s\S]*<\/w:body>/,'<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>HTML 导入片段：格式与原件保留</w:t></w:r></w:p></w:body>'));
 return zip.generateAsync({type:'uint8array'});
}
