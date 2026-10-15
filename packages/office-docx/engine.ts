import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DEFAULT_SECTION, parseDocx, readSections, saveDocx } from './upstream/packages/docx-engine/src/index';
import { assertZipInflatesWithinLimits } from './upstream/packages/docx-engine/src/zip-load';
import { blocksToPmDoc, pmDocOptions, pmDocToSavePlan } from './upstream/apps/docs/src/renderer/editor/convert';
import { normalizeDocument } from './schema';
import { docStyleCss } from './upstream/apps/docs/src/renderer/doc-style-css';
import { applyEdits, assertContentEdit, assets, textNodes } from './model';
import { DocxError, type Context, type DocxModel, type Edit, type PmJSON } from './types';
export { DocxError } from './types';

async function open(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array)) throw new DocxError('INVALID_EDIT', 'DOCX must be Uint8Array');
  // GenOffice's ZIP gate enforces the archive/inflation budgets before decoding.
  await assertZipInflatesWithinLimits(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const part of Object.values(zip.files)) {
    if (!part.dir && /\.(xml|rels)$/i.test(part.name)) {
      try { decoder.decode(await part.async('uint8array')); }
      catch (error) { if (error instanceof TypeError) throw new DocxError('INVALID_UTF', `Invalid UTF-8 in ${part.name}`); throw error; }
    }
  }
  const parsed = await parseDocx(bytes);
  const document = normalizeDocument(blocksToPmDoc(parsed.blocks, readSections(parsed), pmDocOptions(parsed)) as PmJSON);
  return { parsed, document };
}
export async function inspect(bytes: Uint8Array, _context?: Context): Promise<DocxModel> {
  const { parsed, document } = await open(bytes);
  const section = readSections(parsed)[0]?.settings ?? DEFAULT_SECTION;
  const px = (twips: number) => twips / 15;
  return { format: 'docx', baselineHash: createHash('sha256').update(bytes).digest('hex'), document,
    documentCss: docStyleCss(parsed),
    nodes: textNodes(document), assets: assets(document), readOnly: !!parsed.protection?.enforced || !!parsed.writeProtection?.hash,
    page: { width: px(section.pageWidth), height: px(section.pageHeight),
      margins: { top: px(section.marginTop), right: px(section.marginRight), bottom: px(section.marginBottom), left: px(section.marginLeft) },
      fontFamily: parsed.docDefaults?.asciiFont ?? null, eastAsianFontFamily: parsed.docDefaults?.eastAsiaFont ?? null,
      fontSizePt: parsed.docDefaults?.sizeHalfPoints ? parsed.docDefaults.sizeHalfPoints / 2 : null } };
}
export async function edit(bytes: Uint8Array, edits: Edit[], _context?: Context): Promise<Uint8Array> {
  const { parsed, document: baseline } = await open(bytes);
  const document = applyEdits(baseline, edits);
  const normalized = normalizeDocument(document);
  assertContentEdit(baseline, normalized);
  const plan = pmDocToSavePlan(normalized, parsed.blocks);
  if (plan.chartPatches.length) throw new DocxError('UNSUPPORTED_EDIT', 'Chart editing is not supported');
  if ((parsed.protection?.enforced || parsed.writeProtection?.hash) && plan.changedCount)
    throw new DocxError('READ_ONLY', 'This document is protected');
  return new Uint8Array(await saveDocx(parsed, plan.saveBlocks));
}
