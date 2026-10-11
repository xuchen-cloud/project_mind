import { createBasicHtmlDocument } from '../upstream/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts';
import { decodeText } from '../upstream/client/ui-sidebar-documentpreview/src/client/html/bytes.ts';
import { localResourcePath } from './resources.mjs';
/** Inert parsing only; all related reads occur in the main service before DSH sanitization and sandboxing. */
export async function prepareStaticHtml(data, readRelated, signal) {
  const template = document.createElement('template');
  template.innerHTML = decodeText(data);
  const warnings = [];
  for (const element of template.content.querySelectorAll('[srcset]')) {
    warnings.push(`${element.getAttribute('srcset')}：静态预览尚不支持 srcset 资源选择`);
    element.removeAttribute('srcset');
  }
  for (const element of template.content.querySelectorAll('img[src],link[rel~="stylesheet" i][href]')) {
    signal.throwIfAborted();
    const image = element.localName === 'img';
    const reference = element.getAttribute(image ? 'src' : 'href');
    if (image && /^data:image\//iu.test(reference)) continue;
    try {
      const path = localResourcePath(reference);
      if (!path || !readRelated) throw new Error('此版本未保留关联资源');
      const resource = await readRelated(path, signal);
      signal.throwIfAborted();
      if (image) {
        if (!resource.mime.startsWith('image/')) throw new Error('关联资源不是图片');
        element.setAttribute('src', `data:${resource.mime};base64,${resource.base64}`);
      } else {
        if (resource.mime !== 'text/css') throw new Error('关联资源不是样式表');
        const style = document.createElement('style');
        style.textContent = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(resource.base64), c => c.charCodeAt(0)));
        element.replaceWith(style);
      }
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`${reference}：${error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)}`);
      element.removeAttribute(image ? 'src' : 'href');
    }
  }
  // Purify/CSP are still the fixed DSH implementation, preserving source bytes separately.
  return { data: new TextEncoder().encode(createBasicHtmlDocument(new TextEncoder().encode(template.innerHTML))), warnings };
}
