import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from '../../lib/richTextStyle';
import { generateDocxInCurrentThread } from './docxGenerator';
import { generatePdfInCurrentThread } from './pdfGenerator';
import type { RecordExportDocument } from './recordExportModel';

it('fits tall diagram images inside DOCX/PDF printable areas without changing their aspect', async () => {
  const canvas = createCanvas(100, 1400);
  const context = canvas.getContext('2d');
  context.fillStyle = '#77736b'; context.fillRect(5, 5, 90, 1390);
  const images = new Map([['long', { kind: 'resolved' as const, bytes: new Uint8Array(canvas.toBuffer('image/png')), extension: 'png', mimeType: 'image/png', widthPx: 100, heightPx: 1400 }]]);
  const document: RecordExportDocument = { tags: [], style: DEFAULT_RICH_TEXT_STYLE_SETTINGS, blocks: [{ type: 'image', id: 'long', source: '', widthPx: 620, alt: '长时序图' }] };
  const docx = unzipSync(await generateDocxInCurrentThread(document, images));
  const xml = new TextDecoder().decode(docx['word/document.xml']);
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/u.exec(xml)!;
  expect(Number(extent[1]) / Number(extent[2])).toBeCloseTo(1 / 14, 2);
  expect(Number(extent[2]) / 9525).toBeLessThan(950);

  const [sans, mono] = await Promise.all(['NotoSansCJKsc-Regular.otf', 'NotoSansMonoCJKsc-Regular.otf'].map(name => readFile(new URL('../../assets/fonts/' + name, import.meta.url))));
  const bytes = await generatePdfInCurrentThread(document, images, { sans: new Uint8Array(sans), mono: new Uint8Array(mono) });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
  const pdf = await loading.promise;
  try {
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const operators = await page.getOperatorList();
    const imageTransform = operators.argsArray.find((args, index) => operators.fnArray[index] === pdfjs.OPS.transform && args[0] > 1 && args[3] < -100);
    expect(imageTransform).toBeDefined();
    expect(Math.abs(imageTransform[0] / imageTransform[3])).toBeCloseTo(1 / 14, 5);
    const margin20mm = 20 / 25.4 * 72;
    expect(Math.abs(imageTransform[3])).toBeLessThan(page.view[3] - page.view[1] - margin20mm * 2 - 24);
    const caption = (await page.getTextContent()).items.find(item => 'str' in item && item.str.includes('长时序图'));
    expect(caption && 'transform' in caption ? caption.transform[5] : 0).toBeGreaterThan(margin20mm);
  } finally { await loading.destroy(); }
});
