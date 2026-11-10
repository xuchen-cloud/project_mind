import type JSZip from 'jszip';
import type {ParsedDoc} from './upstream/packages/docx-engine/src/types';
import type {Block} from './upstream/packages/docx-engine/src/types';

export interface ViewReader {
  readonly complete: boolean;
  readonly sectionBlocks: {type: 'passthrough'; docxIndex: number; originalXml: string}[];
  read(count: number): Promise<number>;
}
const readers = new WeakMap<ParsedDoc, ViewReader>();
export function registerViewReader(parsed: ParsedDoc, reader: ViewReader) { readers.set(parsed, reader); }
export function viewReader(parsed: ParsedDoc) { return readers.get(parsed); }

/** Derive stable relative ranks from raw anchor metadata before any block is
 * normalized. Future batches must never sort raw heights against old ranks. */
export function createViewZOrderNormalizer(xml: string) {
  const heights = [...xml.matchAll(/<wp:anchor\b[^>]*\brelativeHeight\s*=\s*["'](\d+)["'][^>]*>/g)]
    .map(match => Number(match[1]) - 251658240).filter(height => height !== 0);
  const needed = heights.some(height => Math.abs(height) > 10000);
  const ranks = new Map([...new Set(heights)].sort((a, b) => a - b).map((height, rank) => [height, rank]));
  const original = new WeakMap<object, number>();
  return (blocks: Block[]) => {
    if (!needed) return;
    for (const block of blocks) {
      if (!original.has(block) && block.imageZOrder !== undefined) original.set(block, block.imageZOrder);
      const height = original.get(block);
      if (height !== undefined && ranks.has(height)) {
        const rank = ranks.get(height)!;
        if (rank === 0) delete block.imageZOrder; else block.imageZOrder = rank;
        block.imageZOrderNormalized = true;
      }
      for (const box of block.textboxes ?? []) {
        if (!original.has(box) && box.z !== undefined) original.set(box, box.z);
        const height = original.get(box);
        if (height !== undefined && ranks.has(height)) box.z = ranks.get(height)!;
      }
    }
  };
}

/** The parser has already passed the complete metered ZIP gate in this realm. */
export async function validateViewXml(zip: JSZip) {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.(xml|rels)$/i.test(file.name)) continue;
    try { decoder.decode(await file.async('uint8array')); }
    catch (error) {
      if (error instanceof TypeError) throw Object.assign(new Error(`Invalid UTF-8 in ${file.name}`), {code: 'INVALID_UTF'});
      throw error;
    }
  }
}
