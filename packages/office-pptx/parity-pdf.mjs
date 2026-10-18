// Generated from pinned slides/src/main/pdf-export.ts; Apache-2.0.
const PDF_EXPORT_HEIGHT_IN = 7.5;
function escapeAttr(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function pct(v) {
    return Number.isFinite(v) ? `${Math.round(v * 100000) / 1000}%` : null;
}
export function buildPdfLinkOverlays(links) {
    if (!links?.length)
        return '';
    return links
        .map((l) => {
        const [x, y, w, h] = [pct(l.x), pct(l.y), pct(l.w), pct(l.h)];
        if (x == null || y == null || w == null || h == null || !l.href)
            return '';
        return `<a href="${escapeAttr(l.href)}" style="left:${x};top:${y};width:${w};height:${h}"></a>`;
    })
        .join('');
}
function safeCss(css) {
    return css ? css.replace(/<\/style/gi, '') : '';
}
function pageMarkup(page) {
    return 'svg' in page ? page.svg : `<img src="data:image/png;base64,${page.png}">`;
}
export function buildPdfExportHtml(pages, widthIn, heightIn, links, fontCss) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
${safeCss(fontCss)}
@page { size: ${widthIn}in ${heightIn}in; margin: 0; }
html, body { margin: 0; padding: 0; }
.page { position: relative; width: ${widthIn}in; height: ${heightIn}in; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }
.page img, .page > svg { display: block; width: 100%; height: 100%; }
.page a { position: absolute; display: block; }
</style></head><body>${pages
        .map((page, i) => `<div class="page" id="pg${i + 1}">${pageMarkup(page)}${buildPdfLinkOverlays(links?.[i])}</div>`)
        .join('')}</body></html>`;
}
export function exportPageWidthIn(widthPx, heightPx) {
    const ratio = Number.isFinite(widthPx) && Number.isFinite(heightPx) && heightPx > 0
        ? widthPx / heightPx
        : 16 / 9;
    const safe = Number.isFinite(ratio) && ratio > 0 ? Math.min(Math.max(ratio, 0.2), 5) : 16 / 9;
    return Math.round(safe * PDF_EXPORT_HEIGHT_IN * 1000) / 1000;
}
