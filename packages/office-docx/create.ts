import { buildBlankDocx, BLANK_BULLET_NUM_ID, BLANK_ORDERED_NUM_ID, parseDocx, saveDocx } from './upstream/packages/docx-engine/src/index';
import { parseHtmlFragment } from './upstream/apps/docs/src/renderer/ai/protocol';
import { pmDocToSavePlan } from './upstream/apps/docs/src/renderer/editor/convert';
import { DOMParser } from './create-dom';
import { normalizeDocument } from './schema';
import { DocxError, type PmJSON } from './types';

export const MAX_CREATE_BYTES = 2 * 1024 * 1024;
const inline = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'span', 'br']);
const blocks = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'ul', 'ol', 'table', 'pre', 'blockquote']);
const allowed = new Set([...inline, ...blocks, 'li', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
const invalid = (message: string): never => { throw new DocxError('INVALID_ARGUMENT', message); };

/** Restricted GenOffice AI HTML; attributes, images, links and active content are refused. */
export async function create(content: string): Promise<Uint8Array> {
  if (typeof content !== 'string') invalid('DOCX creation expects restricted HTML text');
  if (Buffer.byteLength(content, 'utf8') > MAX_CREATE_BYTES) throw new DocxError('BUDGET_EXCEEDED', 'DOCX creation content exceeds 2 MiB');
  let html = content.trim();
  const fence = /^```(?:html)?\s*([\s\S]*?)```$/.exec(html);
  if (fence) html = fence[1].trim();
  else if (html.includes('```')) invalid('Only a complete HTML code fence is supported');
  if (!html) invalid('DOCX creation requires nonempty content');
  // Check the source too: HTML parsers may relocate or discard document tags.
  for (const match of html.matchAll(/<\/?\s*([a-z][a-z0-9:-]*)\b/gi)) {
    if (!allowed.has(match[1].toLowerCase())) invalid(`Unsupported DOCX HTML element: ${match[1]}`);
  }
  if (/<!|<\?/.test(html)) invalid('HTML declarations and comments are unsupported');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const stack = Array.from(document.body.childNodes).map(node => ({ node, parent: 'body', depth: 1, lists: 0, cell: false }));
  let count = 0;
  while (stack.length) {
    const { node, parent, depth, lists, cell } = stack.pop()!;
    if (++count > 50000 || depth > 64) throw new DocxError('BUDGET_EXCEEDED', 'DOCX creation HTML exceeds 50000 nodes or 64 nesting levels');
    if (node.nodeType === 3) {
      if (node.textContent?.trim() && ['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol'].includes(parent)) invalid(`Text is not supported directly within ${parent}`);
      continue;
    }
    if (node.nodeType !== 1) invalid('Unsupported HTML node');
    const element = node as unknown as Element;
    const tag = element.tagName.toLowerCase();
    if (!allowed.has(tag) || element.attributes.length) invalid(`Unsupported DOCX HTML element or attributes: ${tag}`);
    const valid = parent === 'body' ? blocks.has(tag)
      : parent === 'table' ? ['thead', 'tbody', 'tfoot', 'tr'].includes(tag)
      : ['thead', 'tbody', 'tfoot'].includes(parent) ? tag === 'tr'
      : parent === 'tr' ? ['td', 'th'].includes(tag)
      : ['ul', 'ol'].includes(parent) ? tag === 'li'
      : parent === 'li' ? inline.has(tag) || tag === 'ul' || tag === 'ol'
      : ['td', 'th'].includes(parent) ? ['p', 'div', 'br', 'span'].includes(tag)
      : inline.has(tag);
    if (!valid || cell && !['p', 'div', 'br', 'span'].includes(tag)) invalid(`Unsupported ${tag} inside ${parent}`);
    const nextLists = lists + Number(tag === 'ul' || tag === 'ol');
    if (nextLists > 5) invalid('DOCX lists support at most five nesting levels');
    for (const child of Array.from(node.childNodes)) stack.push({ node: child, parent: tag, depth: depth + 1, lists: nextLists, cell: cell || tag === 'td' || tag === 'th' });
  }
  if (!document.body.textContent?.trim()) invalid('DOCX creation requires convertible text');
  const nodes = parseHtmlFragment(html, { bullet: BLANK_BULLET_NUM_ID, ordered: BLANK_ORDERED_NUM_ID });
  if (!nodes.length) invalid('DOCX creation produced no convertible content');
  const normalized = normalizeDocument({ type: 'doc', content: nodes } as PmJSON);
  const blank = await parseDocx(await buildBlankDocx());
  const plan = pmDocToSavePlan(normalized, blank.blocks);
  return new Uint8Array(await saveDocx(blank, plan.saveBlocks));
}
