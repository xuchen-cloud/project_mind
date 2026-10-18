import type { PptxEdit } from './types';

export function validateEdits(value: unknown): asserts value is PptxEdit[] {
  if (!Array.isArray(value)) throw new Error('Invalid JSON edits: expected array');
  if(value.length>256)throw new Error('Expected at most 256 PPTX edits');
  for (const e of value) {
    if (!e || Object.getPrototypeOf(e) !== Object.prototype) throw new Error('Invalid JSON edit object');
    if(e.kind==='candidate'){
      if(Object.keys(e).sort().join(',')!=='base64,changedParts,kind,sourceHash'||typeof e.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(e.sourceHash)||typeof e.base64!=='string'||e.base64.length>Math.ceil(100*1024*1024/3)*4||!Array.isArray(e.changedParts)||e.changedParts.length>10000||new Set(e.changedParts).size!==e.changedParts.length||e.changedParts.some((p:unknown)=>typeof p!=='string'||!p||p.startsWith('/')||p.includes('\\')||p.split('/').includes('..')))throw new Error('Invalid or over-budget PPTX candidate');
      if(value.length!==1)throw new Error('PPTX candidate cannot mix with commands');
      continue;
    }
    if (e.kind === 'command') {
      if (Object.keys(e).sort().join(',') !== 'args,kind,name' || typeof e.name !== 'string' || !Array.isArray(e.args)) throw new Error('Invalid PPTX command');
      validateJson(e.args,{nodes:0,characters:0},0);
      if(e.name==='slides:rebase-history'){
        const prior=e.args[0]?.commands;
        if(!Array.isArray(prior)||prior.length+value.length>256||prior.some((p:any)=>p?.kind!=='command'||p?.name==='slides:rebase-history'))throw new Error('History checkpoint exceeds command budget');
        validateEdits(prior);
      }
      continue;
    }
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

function validateJson(value: unknown,budget:{nodes:number;characters:number},depth:number): void {
  if(++budget.nodes>100000||depth>32)throw new Error('PPTX command JSON budget exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { budget.characters+=value.length;if(budget.characters>16*1024*1024)throw new Error('PPTX command JSON budget exceeded');validateText(value); return; }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(v=>validateJson(v,budget,depth+1)); return; }
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) { Object.values(value).forEach(v=>validateJson(v,budget,depth+1)); return; }
  throw new Error('Invalid JSON command payload');
}
