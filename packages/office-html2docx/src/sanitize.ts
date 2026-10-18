import createDOMPurify from 'dompurify';

export const MAX_BYTES = 64 * 1024 * 1024;
export const CSP = "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; worker-src 'none'";

function imageSource(source: string): string {
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source);
  if (!match || !match[1]) throw new Error('altChunk images must be base64 PNG, JPEG, GIF or WebP data URLs');
  let bytes: string;
  try { bytes = atob(match[1]); } catch { throw new Error('Invalid altChunk image base64'); }
  if (btoa(bytes) !== match[1] || bytes.length > MAX_BYTES) throw new Error('Invalid or oversized altChunk image');
  return source;
}
function declarations(style: CSSStyleDeclaration,images: Set<string>): string {
  for (const property of Array.from(style)) {
    const value = style.getPropertyValue(property);
    if (/image-set\s*\(|expression\s*\(|\\/i.test(value)) throw new Error('Unsupported altChunk CSS image or escaped declaration');
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      images.add(imageSource((match[1]??match[2]??match[3]).trim()));
    }
  }
  return style.cssText;
}
function cleanRules(rules: CSSRuleList,images: Set<string>): string {
  return Array.from(rules).map(rule => {
    if (rule.type === CSSRule.STYLE_RULE) {
      const r = rule as CSSStyleRule;
      return `${r.selectorText}{${declarations(r.style,images)}}`;
    }
    if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
      const r = rule as CSSMediaRule;
      return `@${rule.type===CSSRule.MEDIA_RULE?'media':'supports'} ${r.conditionText}{${cleanRules(r.cssRules,images)}}`;
    }
    if (rule.type === CSSRule.PAGE_RULE) {
      const r = rule as CSSPageRule;
      return `@page ${r.selectorText}{${declarations(r.style,images)}}`;
    }
    throw new Error('Unsupported altChunk CSS rule: '+rule.cssText.slice(0,80));
  }).join('\n');
}
function allowedHref(value: string): boolean {
  if(value.startsWith('#'))return true;
  if(!/^(?:https?:\/\/|mailto:)/i.test(value) || /[\u0000-\u0020\u007f]/.test(value))return false;
  try {return ['http:','https:','mailto:'].includes(new URL(value).protocol);}catch{return false;}
}

/** Parse only within the already CSP-constrained iframe realm, never the host DOM. */
export function sanitizedDocument(html: string, realm: Window & typeof globalThis): {document: Document; images: Set<string>} {
  const purify = createDOMPurify(realm);
  const root = purify.sanitize(html, {
    WHOLE_DOCUMENT: true, RETURN_DOM: true, SANITIZE_NAMED_PROPS: true,
    USE_PROFILES: { html: true },
    ADD_TAGS: ['title','meta'],
    ADD_ATTR: ['content'],
    FORBID_TAGS: ['script','iframe','frame','frameset','object','embed','link','base','audio','video','source','track','template'],
    FORBID_ATTR: ['http-equiv','srcset','sizes','xlink:href','action','formaction','ping','poster','background','autofocus','autoplay','is'],
  });
  const document = root.ownerDocument!,images = new Set<string>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if(el.tagName==='META'){
      if(!['author','description','keywords'].includes(el.getAttribute('name')?.toLowerCase()||'')){el.remove();continue;}
      for(const attr of Array.from(el.attributes))if(!['name','content'].includes(attr.name))el.removeAttribute(attr.name);
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') || attr.name.startsWith('data-h2d-') || attr.name === 'contenteditable') el.removeAttribute(attr.name);
      if (['src','data','codebase','cite','longdesc','manifest','profile'].includes(attr.name) && el.tagName !== 'IMG') el.removeAttribute(attr.name);
    }
    if(el.hasAttribute('href')) {
      const href=el.getAttribute('href')!;
      if(el.tagName!=='A'||!allowedHref(href))el.removeAttribute('href');
      else if(href.startsWith('#')&&(document.getElementById('user-content-'+href.slice(1))||document.getElementsByName('user-content-'+href.slice(1)).length))el.setAttribute('href','#user-content-'+href.slice(1));
    }
    if (el.hasAttribute('style')) el.setAttribute('style', declarations(el.style,images));
    if (el.tagName === 'STYLE') {
      const source = el.textContent || '';
      if(/@import\b/i.test(source))throw new Error('External altChunk CSS imports are not supported');
      const sheet = new realm.CSSStyleSheet();
      sheet.replaceSync(source);
      el.textContent = cleanRules(sheet.cssRules,images);
    }
    if (el.tagName === 'IMG') {
      images.add(imageSource(el.getAttribute('src') || ''));
      el.setAttribute('loading','eager');
    }
  }
  return {document,images};
}
