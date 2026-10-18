import DOMPurify from 'dompurify';
import { renderDiagram, type DiagramLanguage, type DiagramResult } from '../genoffice/editor/diagrams';

// Mermaid lays out a temporary DOM before returning SVG, so sanitizing only
// its result would be too late for an image node or a CSS resource request.
function unescapeSyntax(value: string): string {
  return value.replace(/\\u([\da-f]{4})/giu, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\([\da-f]{1,6})\s?/giu, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/\\\r?\n/gu, '').replace(/\\([^\da-f\r\n])/giu, '$1')
    .replace(/\/\*[\s\S]*?\*\//gu, '');
}
function resourceCss(value: string): boolean {
  const css = unescapeSyntax(value);
  return /@(?:import|font-face)\b/iu.test(css) || Array.from(css.matchAll(/url\(\s*["']?([^"')\s]*)/giu)).some(match => !match[1].startsWith('#'));
}
export function diagramPreviewError(source: string): string | undefined {
  const syntax = unescapeSyntax(source);
  if (/<\s*\/?\s*(?:script|style|iframe|img|image|object|embed|link|foreignObject)\b/iu.test(syntax) || /\bon\w+\s*=/iu.test(syntax)) {
    return '图表预览不允许脚本、活动 HTML 或内嵌资源标签。';
  }
  if (/(?:[,{]\s*|^\s*)["']?(?:img|image)["']?\s*:/imu.test(syntax) || resourceCss(syntax)) {
    return '图表预览不允许图片资源或外部资源样式；请使用宿主授权的 Markdown 图片。';
  }
  return undefined;
}

export function safeDiagramSvg(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ['use'], // WaveDrom's waveform shapes; href is restricted below.
    FORBID_TAGS: ['script', 'foreignObject', 'image', 'feImage', 'a', 'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['xml:base'],
  });
  // Retain only local fragment references (WaveDrom uses <use href="#…">).
  // CSS URLs and SVG paint/filter attributes need the same check as href.
  for (const node of fragment.querySelectorAll('*')) {
    for (const attribute of Array.from(node.attributes)) {
      if ((/^(?:href|xlink:href)$/iu.test(attribute.name) && !attribute.value.startsWith('#')) ||
        /^(?:src|on\w+)$/iu.test(attribute.name) || resourceCss(attribute.value)) node.removeAttribute(attribute.name);
    }
    if (node.localName === 'style' && resourceCss(node.textContent ?? '')) node.remove();
  }
  const root = fragment.querySelector('svg');
  if (!root) throw Error('图表渲染器未生成有效 SVG。');
  return root.outerHTML;
}

export async function renderSafeDiagram(language: DiagramLanguage, source: string): Promise<DiagramResult> {
  const error = diagramPreviewError(source);
  if (error) return { ok: false, error };
  try {
    const result = await renderDiagram(language, source);
    return result.ok ? { ok: true, svg: safeDiagramSvg(result.svg) } : result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
