// @vitest-environment node
import { expect, it } from 'vitest';
import { createCanvas, DOMMatrix, Path2D } from '@napi-rs/canvas';
import { pdfFixture } from './fixtures/pdf-fixture';
import { renderPdfPage } from '../upstream/client/ui-sidebar-documentpreview/src/client/pdf/document';
import { createPdfBinaryDataFactory } from '../upstream/client/ui-sidebar-documentpreview/src/client/pdf/assets';

it('renders two real fixture PDF pages through the pinned DSH canvas renderer and bundled font assets', async () => {
  Object.assign(globalThis, { DOMMatrix, Path2D });
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const input = pdfFixture(); const original = input.slice();
  const loading = getDocument({ data: input.slice(), BinaryDataFactory: createPdfBinaryDataFactory(), useWorkerFetch: false, enableXfa: false });
  try {
    const document = await loading.promise;
    expect(document.numPages).toBe(2);
    for (const number of [1, 2]) {
      const canvas = createCanvas(1, 1);
      Object.assign(canvas, { style: { setProperty() {} } });
      const size = await renderPdfPage(document, number, canvas as unknown as HTMLCanvasElement, new AbortController().signal, 1);
      expect(size.width).toBe(160); expect(size.height).toBeCloseTo(100 * 96 / 72, 10);
      const pixel = canvas.getContext('2d').getImageData(20, 30, 1, 1).data;
      expect(pixel[number === 1 ? 0 : 2]).toBeGreaterThan(150);
    }
    expect(input).toEqual(original);
  } finally { await loading.destroy(); }
});
it('refuses late getPage writes after cancellation and cleans the page proxy', async () => {
  let finish!: (value: unknown) => void; let cleaned = false;
  const doc = { numPages: 1, getPage: () => new Promise(resolve => { finish = resolve; }) };
  const canvas = { width: 1, height: 1 };
  const lifetime = new AbortController();
  const result = renderPdfPage(doc as never, 1, canvas as HTMLCanvasElement, lifetime.signal, 1);
  lifetime.abort();
  finish({ cleanup() { cleaned = true; } });
  await expect(result).rejects.toThrow();
  expect(canvas).toEqual({ width: 1, height: 1 }); expect(cleaned).toBe(true);
});
it('decodes the representative PNG bytes using a real image decoder', async () => {
  const { loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64'));
  expect([image.width, image.height]).toEqual([1, 1]);
});
