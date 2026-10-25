import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { DEFAULT_SECTION, parseDocx, readSections, saveDocx, patchChartPartXml, findChartWorkbookPath, readDocxPartBase64, parseChartPartXml, patchChartWorkbookXlsxBase64 } from './upstream/packages/docx-engine/src/index';
import { assertZipInflatesWithinLimits } from './upstream/packages/docx-engine/src/zip-load';
import { blocksToPmDoc, pmDocOptions, pmDocToSavePlan } from './upstream/apps/docs/src/renderer/editor/convert';
import { normalizeDocument } from './schema';
import { docStyleCss } from './upstream/apps/docs/src/renderer/doc-style-css';
import { applyEdits, assertContentEdit, assertJson, assets, textNodes } from './model';
import { DocxError, type Context, type DocxModel, type Edit, type PmJSON } from './types';
export { DocxError } from './types';
export { create } from './create';
export { catalog } from './authoring';
import { editOperations, summary } from './authoring';

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
  return { format: 'docx', authoring:await summary(bytes), sourceBase64: Buffer.from(bytes).toString('base64'), baselineHash: createHash('sha256').update(bytes).digest('hex'), document,
    documentCss: docStyleCss(parsed),
    nodes: textNodes(document), assets: assets(document), readOnly: !!parsed.protection?.enforced || !!parsed.writeProtection?.hash,
    page: { width: px(section.pageWidth), height: px(section.pageHeight),
      margins: { top: px(section.marginTop), right: px(section.marginRight), bottom: px(section.marginBottom), left: px(section.marginLeft) },
      fontFamily: parsed.docDefaults?.asciiFont ?? null, eastAsianFontFamily: parsed.docDefaults?.eastAsiaFont ?? null,
      fontSizePt: parsed.docDefaults?.sizeHalfPoints ? parsed.docDefaults.sizeHalfPoints / 2 : null } };
}
export async function edit(bytes: Uint8Array, edits: Edit[], _context?: Context): Promise<Uint8Array> {
  assertJson(edits);
  if (Array.isArray(edits) && edits.some(edit=>edit?.type==='operations')) {
    if(edits.length!==1||edits[0].type!=='operations'||Object.keys(edits[0]).some(k=>!['type','ops'].includes(k)))throw new DocxError('INVALID_EDIT','Operations must be the sole Word edit');
    await open(bytes);return editOperations(bytes,edits[0].ops);
  }
  const { parsed, document: baseline } = await open(bytes);
  if (Array.isArray(edits) && edits.some(edit => edit?.type === 'snapshot')) {
    if (edits.length !== 1 || edits[0].type !== 'snapshot' || typeof edits[0].base64 !== 'string' ||
        Object.keys(edits[0]).some(key => !['type', 'baselineHash', 'base64'].includes(key)))
      throw new DocxError('INVALID_EDIT', 'A snapshot must be the sole edit');
    if (edits[0].baselineHash !== createHash('sha256').update(bytes).digest('hex'))
      throw new DocxError('INVALID_EDIT', 'The Word draft belongs to a different file baseline');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(edits[0].base64))
      throw new DocxError('INVALID_EDIT', 'Invalid DOCX snapshot encoding');
    if (parsed.protection?.enforced || parsed.writeProtection?.hash)
      throw new DocxError('READ_ONLY', 'This document is protected');
    const output = new Uint8Array(Buffer.from(edits[0].base64, 'base64'));
    await open(output);
    return output;
  }

  const document = applyEdits(baseline, edits);
  const normalized = normalizeDocument(document);
  assertContentEdit(baseline, normalized);
  const plan = pmDocToSavePlan(normalized, parsed.blocks);
  const partXml: Record<string,string> = {}, partBinary: Record<string,string> = {};
  for (const {partPath,patch} of plan.chartPatches) {
    const originalPart=parsed.extras.chartParts[partPath];
    if (!originalPart) throw new DocxError('UNSUPPORTED_EDIT','Original chart part is missing');
    const xml=patchChartPartXml(originalPart,patch);partXml[partPath]=xml;
    const workbookPath=await findChartWorkbookPath(bytes,partPath);
    if (workbookPath) {
      const originalWorkbook=await readDocxPartBase64(bytes,workbookPath),display=parseChartPartXml(xml,partPath);
      if (!originalWorkbook||!display) throw new DocxError('UNSUPPORTED_EDIT','Cannot preserve the chart workbook');
      const updated=await patchChartWorkbookXlsxBase64(originalWorkbook,display.categories,display.series.map((series,i)=>({name:series.name??`Series${i+1}`,values:series.values})));
      if (!updated) throw new DocxError('UNSUPPORTED_EDIT','Cannot save the chart workbook');
      partBinary[workbookPath]=updated;
    }
  }
  if ((parsed.protection?.enforced || parsed.writeProtection?.hash) && plan.changedCount)
    throw new DocxError('READ_ONLY', 'This document is protected');
  return new Uint8Array(await saveDocx(parsed, plan.saveBlocks, {partXml,partBinary}));
}
