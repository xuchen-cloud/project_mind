import {changedParts,CANDIDATE_MAX_BYTES,CANDIDATE_ZIP_LIMITS} from './parity-candidate';
import {assertZipInflatesWithinLimits} from './vendor/packages/zip-gate/src';
import {sameArchive} from './parity-history';
import { createParitySession } from './parity-session';
import { openPptx, elementSpid, type OpenedPptx, type SlideElement, type TextElement } from '@genoffice/pptx-engine';
import { buildRenderSlide } from '@genoffice/pptx-render';
import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import type { PptxModel, PptxEdit } from './types';
import { validateEdits, validateXmlCharacters } from './validate';

const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf' };
const targetId = (slideIndex: number, cNvPrId: string) => `slide-${slideIndex}:shape-${cNvPrId}`;

function nonVisualId(el: SlideElement): string | null {
  return el.nvId ?? (elementSpid(el) == null ? null : String(elementSpid(el)));
}

export async function inspect(bytes: Uint8Array): Promise<PptxModel> {
  return { ...modelOf(await openValidated(bytes)), sourceBase64: Buffer.from(bytes).toString('base64') };
}

async function openValidated(bytes: Uint8Array): Promise<OpenedPptx> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Invalid PPTX bytes: expected nonempty Uint8Array');
  const opened = await openPptx(bytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [path, content] of opened.archive.entries) if (/\.(?:xml|rels)$/.test(path)) {
    let xml: string;
    try { xml = decoder.decode(content); } catch { throw new Error(`Invalid UTF-8 XML part: ${path}`); }
    validateXmlCharacters(xml);
    const encoding = /<\?xml\b[^>]*\bencoding=["']([^"']+)["']/.exec(xml)?.[1];
    if (encoding && !/^utf-8$/i.test(encoding)) throw new Error(`Unsupported XML encoding ${encoding}: ${path}`);
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw new Error(`Invalid XML part ${path}: ${valid.err.msg}`);
  }
  return opened;
}

function modelOf(opened: OpenedPptx): PptxModel {
  const media: Record<string, string> = {};
  for (const [part, bytes] of opened.archive.entries) if (part.startsWith('ppt/media/')) {
    const ext = part.split('.').pop()!.toLowerCase();
    media[part] = `data:${mime[ext] ?? 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  const textElements: PptxModel['textElements'] = [];
  const pictureElements: PptxModel['pictureElements'] = [];
  const slides = structuredClone(opened.deck.slides);
  slides.forEach((slide, slideIndex) => {
    const visit = (el: SlideElement, grouped = false) => {
      const cNvPrId = nonVisualId(el);
      el.id = cNvPrId == null ? `slide-${slideIndex}:readonly-${el.anchor.spIndex}` : targetId(slideIndex, cNvPrId);
      if (cNvPrId != null && (el.type === 'text' || el.type === 'shape') && el.text) {
        const unsupportedReason = textUnsupported(el, grouped);
        textElements.push({ slideIndex, cNvPrId, text: el.text.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n'), originalRichText: el.text, editable: !unsupportedReason, ...(unsupportedReason ? { unsupportedReason } : {}) });
      }
      if (cNvPrId != null && el.type === 'picture') {
        const unsupportedReason = grouped ? '暂不支持移动组合内图片' : imageUnsupported(el);
        pictureElements.push({ slideIndex, cNvPrId, transform: el.transform, editable: !unsupportedReason, ...(unsupportedReason ? { unsupportedReason } : {}) });
      }
      if (el.type === 'group') el.children.forEach(child => visit(child, true));
    };
    slide.elements.forEach(el => visit(el));
    const decorate = (el: SlideElement, prefix: string) => { el.id = prefix; if (el.type === 'group') el.children.forEach((child, i) => decorate(child, `${prefix}:${i}`)); };
    slide.decorations?.forEach((el, i) => decorate(el, `slide-${slideIndex}:decoration-${i}`));
  });
  const renderSlides = slides.map((slide, i) => buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 960, slideNo: i + 1, media: ref => media[ref] }));
  return { format: 'pptx', originalHash: opened.deck.originalHash, size: opened.deck.size, slides, renderSlides, media, textElements, pictureElements, limitations: ['完整上游 renderer 与 ops 编辑会话；未修改部件沿用原件。二进制 .ppt 不受上游引擎支持。', '字体依赖系统回退与估算度量；导入图表编辑采用上游图表模板，可能丢失未建模的格式。'] };
}

function textUnsupported(el: TextElement, grouped: boolean): string | undefined {
  if (grouped) return '暂不支持编辑组合内文字';
  if (el.text?.paragraphs.some(p => p.runs.some(r => r.field))) return '动态字段只能预览，不能编辑';
  if (el.text?.paragraphs.some(p => p.runs.some(r => r.rawXml))) return '数学公式及扩展文字只能预览，不能编辑';
  return undefined;
}

function imageUnsupported(el: SlideElement): string | undefined {
  const offset = /<a:off\b[^>]*\/>/.exec(el.anchor.originalXml)?.[0];
  return offset && /\bx=["']-?\d+["']/.test(offset) && /\by=["']-?\d+["']/.test(offset) ? undefined : '图片没有可编辑的原始位置';
}

export async function edit(bytes: Uint8Array, edits: PptxEdit[]): Promise<Uint8Array> {
  validateEdits(edits);
  const opened = await openValidated(bytes);
  const candidate=edits[0];
  if(candidate?.kind==='candidate'){
    if(candidate.sourceHash!==opened.deck.originalHash)throw new Error('PPTX candidate source baseline mismatch');
    const result=new Uint8Array(Buffer.from(candidate.base64,'base64'));
    if(!result.length||result.length>CANDIDATE_MAX_BYTES||Buffer.from(result).toString('base64')!==candidate.base64)throw new Error('Invalid or over-budget PPTX candidate bytes');
    await assertZipInflatesWithinLimits(result,CANDIDATE_ZIP_LIMITS);
    const final=await openValidated(result),actual=changedParts(opened,final);
    if(JSON.stringify(actual)!==JSON.stringify([...candidate.changedParts].sort()))throw new Error('PPTX candidate changed-parts manifest mismatch');
    // Every omitted part was compared byte-for-byte above. Native CAS still owns the final write.
    return result;
  }
  if (edits.some(e => e.kind === 'command')) {
    if (edits.some(e => e.kind !== 'command')) throw new Error('Cannot mix legacy and command edit sessions');
    // Browser has already confirmed imported-chart template replacement before journaling.
    let session = createParitySession(opened,{confirmChart:async()=>true});
    for (const [index,e] of edits.entries()) if (e.kind === 'command') {
      if(e.name==='slides:rebase-history'){
        if(index!==0)throw new Error('History checkpoint must be first');
        const checkpoint=e.args[0] as unknown as {sourceBase64:string;commands:PptxEdit[]};
        if(!checkpoint||typeof checkpoint.sourceBase64!=='string')throw new Error('Invalid history checkpoint');
        validateEdits(checkpoint.commands);
        session=createParitySession(await openValidated(new Uint8Array(Buffer.from(checkpoint.sourceBase64,'base64'))),{confirmChart:async()=>true});
        for(const prior of checkpoint.commands){if(prior.kind!=='command'||prior.name==='slides:rebase-history')throw new Error('Invalid history checkpoint command');await session.invoke(prior.name,prior.args)}
        // A checkpoint is an acknowledgment of this exact native baseline, never a file replacement.
        if(!sameArchive(await openValidated(await session.save()),opened))throw new Error('History checkpoint differs from current original');
      }else await session.invoke(e.name,e.args);
    }
    return session.save();
  }
  const pending = new Map<SlideElement, string>();
  for (const e of edits) {
    if (e.kind === 'command'||e.kind==='candidate') continue;
    const slide = opened.deck.slides[e.slideIndex];
    if (!slide) throw new Error('Slide not found');
    const el = slide.elements.find(el => nonVisualId(el) === e.cNvPrId);
    if (!el) throw new Error('Top-level cNvPr target not found');
    const xml = pending.get(el) ?? el.anchor.originalXml;
    if (e.kind === 'move-image') {
      if (el.type !== 'picture') throw new Error('Target is not an image');
      const reason = imageUnsupported(el);
      if (reason) throw new Error(reason);
      pending.set(el, xml.replace(/<a:off\b[^>]*\/>/, offset => offset.replace(/(\bx=["'])-?\d+(["'])/, (_m, start, end) => `${start}${e.x}${end}`).replace(/(\by=["'])-?\d+(["'])/, (_m, start, end) => `${start}${e.y}${end}`)));
      continue;
    }
    if (e.kind !== 'text' || (el.type !== 'text' && el.type !== 'shape') || !el.text) throw new Error('Unsupported text target');
    const reason = textUnsupported(el, false);
    if (reason) throw new Error(reason);
    const run = el.text.paragraphs[e.paragraphIndex]?.runs[e.runIndex];
    if (!run || run.text === '\n') throw new Error('Existing plain text run not found');
    if (e.text.includes('\n') || e.text.includes('\r')) throw new Error('Structural line breaks are not supported');
    const body = /<p:txBody\b[^>]*>[\s\S]*?<\/p:txBody>/.exec(xml);
    if (!body) throw new Error('Original text body not found');
    const paragraphs = [...body[0].matchAll(/<a:p\b[^>]*\/>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)];
    const paragraph = paragraphs[e.paragraphIndex];
    if (!paragraph) throw new Error('Original paragraph not found');
    const runs = [...paragraph[0].matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>|<a:br\b[^>]*\/>|<a:br\b[^>]*>[\s\S]*?<\/a:br>/g)];
    const span = runs[e.runIndex];
    if (!span || !span[0].startsWith('<a:r') || runs.length !== el.text.paragraphs[e.paragraphIndex].runs.length) throw new Error('Text structure cannot be edited losslessly');
    if (!/<a:t\b[^>]*>[\s\S]*?<\/a:t>|<a:t\b[^>]*\/>/.test(span[0])) throw new Error('Original run has no text payload');
    const changed = span[0].replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)|<a:t\b[^>]*\/>/, (match, start, end) => `${start ?? `${match.slice(0, -2)}>`}${escapeText(e.text)}${end ?? '</a:t>'}`);
    const start = body.index + paragraph.index! + span.index!;
    pending.set(el, xml.slice(0, start) + changed + xml.slice(start + span[0].length));
  }
  if (pending.size === 0) return bytes.slice();
  const zip = await JSZip.loadAsync(bytes);
  for (const slide of opened.deck.slides) {
    const patches = slide.elements.filter(el => pending.has(el)).sort((a, b) => b.anchor.range[0] - a.anchor.range[0]);
    if (!patches.length) continue;
    let xml = opened.archive.readText(slide.path)!;
    for (const el of patches) {
      const [start, end] = el.anchor.range;
      xml = xml.slice(0, start) + pending.get(el)! + xml.slice(end);
    }
    zip.file(slide.path, xml);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
