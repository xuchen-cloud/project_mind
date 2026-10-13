import type { PptxEdit } from './types';

export function validateEdits(value: unknown): asserts value is PptxEdit[] {
  if (!Array.isArray(value)) throw new Error('Invalid JSON edits: expected array');
  for (const e of value) {
    if (!e || Object.getPrototypeOf(e) !== Object.prototype) throw new Error('Invalid JSON edit object');
    const keys = e.kind === 'text' ? ['kind', 'slideIndex', 'cNvPrId', 'paragraphIndex', 'runIndex', 'text'] : e.kind === 'move-image' ? ['kind', 'slideIndex', 'cNvPrId', 'x', 'y'] : [];
    if (keys.length === 0 || Object.keys(e).length !== keys.length || Object.keys(e).some(k => !keys.includes(k))) throw new Error('Unsupported or invalid JSON edit fields');
    if (!Number.isSafeInteger(e.slideIndex) || e.slideIndex < 0 || typeof e.cNvPrId !== 'string' || !/^\d+$/.test(e.cNvPrId) || Number(e.cNvPrId) > 4294967295) throw new Error('Invalid slideIndex/cNvPrId target');
    if (e.kind === 'text') {
      if (!Number.isSafeInteger(e.paragraphIndex) || e.paragraphIndex < 0 || !Number.isSafeInteger(e.runIndex) || e.runIndex < 0 || typeof e.text !== 'string') throw new Error('Invalid JSON text edit');
      validateText(e.text);
      if (/[\r\n]/.test(e.text)) throw new Error('Structural line breaks are not supported');
    } else if (![e.x, e.y].every(v => Number.isSafeInteger(v) && Math.abs(v) <= 27273042316900)) throw new Error('Invalid XML image coordinate');
  }
}

export function validateText(text: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error('Invalid XML text character');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Unicode surrogate');
  }
}

export function validateXmlCharacters(xml: string) {
  validateText(xml);
  const content = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const match of content.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
    const code = match[1].startsWith('x') ? parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) throw new Error('Invalid XML character reference');
  }
}
