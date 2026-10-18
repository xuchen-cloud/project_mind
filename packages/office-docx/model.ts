import { DocxError, type Edit, type JsonValue, type PmJSON, type PmNode, type TextNode } from './types';

export function assertUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new DocxError('INVALID_UTF', 'Unpaired Unicode surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new DocxError('INVALID_UTF', 'Unpaired Unicode surrogate');
  }
}
/** The public edit boundary accepts JSON values, not lossy JSON.stringify coercions. */
export function assertJson(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (typeof value === 'string') { assertUnicode(value); return; }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object') throw new DocxError('INVALID_JSON', 'Edit must contain only JSON values');
  if (seen.has(value)) throw new DocxError('INVALID_JSON', 'Cyclic JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new DocxError('INVALID_JSON', 'Edit must contain plain JSON objects');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string') throw new DocxError('INVALID_JSON', 'Symbol JSON key');
    assertUnicode(key);
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !('value' in property)) throw new DocxError('INVALID_JSON', 'Invalid JSON property');
    assertJson(property.value, seen);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new DocxError('INVALID_JSON', 'Sparse JSON array');
  seen.delete(value);
}

const paragraphs = new Set(['docParagraph', 'docHeading', 'docListItem']);
const plainMarks = new Set(['bold', 'italic', 'underline', 'strike', 'docTextStyle']);
export function isTextNode(node: PmNode): boolean {
  return paragraphs.has(node.type) && (node.content ?? []).every(n => n.type === 'text' &&
    (n.marks ?? []).every(m => plainMarks.has(m.type)));
}
export function textNodes(document: PmJSON): TextNode[] {
  const result: TextNode[] = [];
  function walk(node: PmNode, path: number[], docxIndex: number, suffix: string) {
    if (isTextNode(node)) result.push({ id: `docx:${docxIndex}${suffix}`, docxIndex, path, type: node.type,
      text: (node.content ?? []).map(n => n.text ?? '').join('') });
    else if (node.type === 'docTable' || node.type === 'docTableRow' || node.type === 'docTableCell' || node.type === 'docTableHeader')
      node.content?.forEach((child, i) => walk(child, [...path, i], docxIndex, `${suffix}/${i}`));
  }
  document.content.forEach((node, i) => {
    if (typeof node.attrs?.docxIndex === 'number') walk(node, [i], node.attrs.docxIndex, '');
  });
  return result;
}
export function assets(document: PmJSON): { id: string; dataUrl: string }[] {
  const result: { id: string; dataUrl: string }[] = [];
  function walk(value: unknown, id: string) {
    if (typeof value === 'string' && value.startsWith('data:image/')) result.push({ id, dataUrl: value });
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${id}/${i}`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, `${id}/${k}`));
  }
  walk(document, 'document');
  return result;
}

export function applyEdits(baseline: PmJSON, edits: Edit[]): PmJSON {
  assertJson(edits);
  if (!Array.isArray(edits)) throw new DocxError('INVALID_EDIT', 'edits must be an array');
  if (edits.some(e => !e || typeof e !== 'object' || Array.isArray(e))) throw new DocxError('INVALID_EDIT', 'Invalid edit');
  const documents = edits.filter(e => e.type === 'document');
  if (documents.length) {
    if (edits.length !== 1 || Object.keys(documents[0]).some(k => k !== 'type' && k !== 'document'))
      throw new DocxError('INVALID_EDIT', 'A document edit must be the sole edit');
    const document = documents[0].document;
    if (!document || document.type !== 'doc' || !Array.isArray(document.content)) throw new DocxError('INVALID_EDIT', 'Expected a ProseMirror document');
    return structuredClone(document);
  }
  const document = structuredClone(baseline);
  const nodes = new Map(textNodes(baseline).map(n => [n.id, n]));
  for (const edit of edits) {
    if (edit.type !== 'text' || typeof edit.nodeId !== 'string' || typeof edit.text !== 'string' ||
        (edit.expectedText !== undefined && typeof edit.expectedText !== 'string') ||
        Object.keys(edit).some(k => !['type', 'nodeId', 'text', 'expectedText'].includes(k)))
      throw new DocxError('INVALID_EDIT', 'Expected a text edit');
    const target = nodes.get(edit.nodeId);
    if (!target) throw new DocxError('INVALID_EDIT', `Unknown editable node: ${edit.nodeId}`);
    let node: PmNode = document;
    for (const index of target.path) node = node.content![index];
    const before = (node.content ?? []).map(n => n.text ?? '').join('');
    if (edit.expectedText !== undefined && edit.expectedText !== before)
      throw new DocxError('INVALID_EDIT', `Text precondition failed: ${edit.nodeId}`);
    const marks = node.content?.[0]?.marks;
    node.content = edit.text ? [{ type: 'text', text: edit.text, ...(marks ? { marks } : {}) }] : [];
  }
  return document;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && equal(value, (b as Record<string, unknown>)[key]));
}
/** Preserve source identity and opaque payloads while allowing upstream structural edits. */
export function assertContentEdit(baseline: PmJSON, document: PmJSON): void {
  const originals = new Map(baseline.content.filter(n => typeof n.attrs?.docxIndex === 'number').map(n => [n.attrs!.docxIndex, n]));
  for (const node of document.content) {
    const index = node.attrs?.docxIndex;
    if (index == null) continue;
    const original = originals.get(index);
    if (!original) throw new DocxError('UNSUPPORTED_EDIT', 'Unknown original block identity');
    if (node.type === 'docProtected' && original.type === 'docProtected') {
      for (const key of ['blockType', 'imageDataUrl', 'genXml', 'genImage', 'genChart'])
        if (!equal(node.attrs?.[key], original.attrs?.[key]))
          throw new DocxError('UNSUPPORTED_EDIT', `Use the upstream editing payload for ${key}`);
      const chart = node.attrs?.chartDisplay as any, previousChart = original.attrs?.chartDisplay as any;
      if (chart && previousChart && (chart.partPath !== previousChart.partPath || chart.series.length !== previousChart.series.length || chart.categories.length !== previousChart.categories.length || chart.series.some((series: any, i: number) => series.values.length !== previousChart.series[i].values.length)))
        throw new DocxError('UNSUPPORTED_EDIT', 'The upstream chart supports existing series and categories');
      if (!original.attrs?.chartDisplay && node.attrs?.chartDisplay)
        throw new DocxError('UNSUPPORTED_EDIT', 'Cannot attach a chart to a different original block');
    }
  }
}
