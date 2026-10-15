import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, lazy, Suspense } from 'react';
import { TextBody } from '../upstream/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx';
import { CodeBody } from '../upstream/client/ui-sidebar-documentpreview/src/client/code/CodeBody.tsx';
import { MarkdownBody } from '../upstream/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx';
import { ImageBody } from '../upstream/client/ui-sidebar-documentpreview/src/client/image/ImageBody.tsx';
import { ZoomViewport, zoomSurfaceClass } from '../upstream/client/ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx';
import { scrollToLine } from '../upstream/client/ui-sidebar-documentpreview/src/client/text/lines.ts';
import { zh as imageZh } from '../upstream/client/ui-sidebar-documentpreview/src/client/image/locales.ts';
import { zh as pdfZh } from '../upstream/client/ui-sidebar-documentpreview/src/client/pdf/locales.ts';
import '../styles/scoped.css';
import './preview.css';
import { withResolvedMarkdownImages } from './resources.mjs';
import { HtmlBody } from '../upstream/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx';
import { zh as htmlZh } from '../upstream/client/ui-sidebar-documentpreview/src/client/html/locales.ts';
import { HostPortalProvider } from '@deepseek-ai/dsh-client-ui-primitives';
const PdfBody = lazy(() => import('../upstream/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx').then(module => ({ default: module.PdfBody })));
const words = { ...imageZh, ...pdfZh, ...htmlZh, copy: '复制', copied: '已复制', 'code.copy': '复制', 'code.copied': '已复制', footnotes: '脚注', 'codeBlock.title': '代码', 'codeBlock.wrap': '自动换行', 'codeBlock.unwrap': '取消换行' };
const translate = (dictionary, key, values = {}) => (dictionary[key] ?? words[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''));
const retainTab = () => {};
const useResource = () => ({ status: 'live' });

/** Presentation only. Main application owns identity, version, reads and tab membership. */
export function DshFilePreview({ kind, name, text = '', bytes, line, page, signal, initialView, resources = {}, onViewChange }) {
  const t = useMemo(() => (key, values) => translate(kind === 'image' ? imageZh : kind === 'pdf' ? pdfZh : kind === 'html' ? htmlZh : {}, key, values), [kind]);
  const host = useRef(null);
  const [portal, setPortal] = useState(null);
  useEffect(() => {
    const node = document.createElement('div'); node.className = 'dsh-ui-host dsh-file-preview-portals'; document.body.append(node); setPortal(node);
    const update = () => { const dark = document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.dataset.theme === 'dark'; node.toggleAttribute('data-ds-dark-theme', dark); host.current?.toggleAttribute('data-ds-dark-theme', dark); };
    update(); const observer = new MutationObserver(update); observer.observe(document.documentElement, {attributes:true,attributeFilter:['data-theme']}); observer.observe(document.body, {attributes:true,attributeFilter:['data-ds-dark-theme']});
    return () => { observer.disconnect(); node.remove(); };
  }, []);
  const [view, setView] = useState({ page: page ?? initialView?.page ?? 1, zoom: initialView?.zoom ? {kind:'fixed',scale:initialView.zoom} : undefined });
  const callback = useRef(onViewChange);
  callback.current = onViewChange;
  const scrollport = useRef(null);
  const scrollTop = useRef(initialView?.scrollTop ?? 0);
  const restoringTop = useRef(line === undefined ? initialView?.scrollTop : undefined);
  const restoringPage = useRef(kind === 'pdf' && initialView?.scrollTop === undefined ? page ?? initialView?.page : undefined);
  const appliedInitialView = useRef(initialView?.scrollTop !== undefined || initialView?.zoom !== undefined);
  const previousPage = useRef(page);
  const [scrollNode, setScrollNode] = useState(null);
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  const measure = useCallback(() => {
    const node = scrollport.current;
    if (!node) return;
    if (restoringTop.current !== undefined) {
      node.scrollTop = restoringTop.current;
      if (node.scrollTop === restoringTop.current) restoringTop.current = undefined;
    }
    if (restoringPage.current !== undefined) {
      const target = node.querySelector(`[data-pdf-page="${restoringPage.current}"]`);
      if (target) {
        node.scrollTop = Math.max(0, target.offsetTop);
        const surface = target.querySelector('[data-document-zoom-surface]');
        const first = node.querySelector('[data-pdf-page="1"] [data-document-zoom-surface]');
        if (surface && !surface.hidden && first && !first.hidden) restoringPage.current = undefined;
      }
    }
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const pos = Math.max(0, Math.min(max, node.scrollTop));
    const distance = Math.min(64, max / 2);
    const nextEdges = { top: distance ? Math.min(1, pos / distance) : 0, bottom: distance ? Math.min(1, (max - pos) / distance) : 0 };
    setEdges(previous => previous.top === nextEdges.top && previous.bottom === nextEdges.bottom ? previous : nextEdges);
  }, []);
  // The shell learns the actual version from sourceReady, so saved view can arrive after bytes.
  useLayoutEffect(() => {
    if (appliedInitialView.current || (initialView?.scrollTop === undefined && initialView?.zoom === undefined)) return;
    appliedInitialView.current = true;
    if (initialView.zoom !== undefined) setView(previous => ({ ...previous, zoom: initialView.zoom === 0 ? undefined : { kind: 'fixed', scale: initialView.zoom } }));
    if (initialView.scrollTop !== undefined && line === undefined) {
      scrollTop.current = initialView.scrollTop;
      restoringTop.current = initialView.scrollTop;
      restoringPage.current = undefined;
    } else if (kind === 'pdf') restoringPage.current = page ?? initialView.page;
    measure();
  }, [initialView, kind, line, page, measure]);
  const cancelRestoration = () => { restoringTop.current = undefined; restoringPage.current = undefined; appliedInitialView.current = true; };
  const bindScrollport = useCallback(node => {
    scrollport.current = node;
    setScrollNode(node);
    if (node) node.scrollTop = scrollTop.current;
    measure();
  }, [measure]);
  const actions = useMemo(() => ({
    page: (_, next) => {
      // Upstream preloads a viewport beyond the reader; preload callbacks must not overwrite the restored page.
      if (restoringTop.current !== undefined || restoringPage.current !== undefined) return;
      const node = scrollport.current;
      if (node?.clientHeight > 0) {
        const bounds = node.getBoundingClientRect();
        const firstVisible = Array.from(node.querySelectorAll('[data-pdf-page]')).find(target => {
          const pageBounds = target.getBoundingClientRect();
          return pageBounds.bottom > bounds.top && pageBounds.top < bounds.bottom;
        });
        if (firstVisible && Number(firstVisible.getAttribute('data-pdf-page')) !== next) return;
      }
      setView(previous => previous.page === next ? previous : { ...previous, page: next }); callback.current?.({ page: next });
    },
    zoom: (_, zoom) => { setView(previous => ({ ...previous, zoom })); callback.current?.({ zoom: zoom.kind === 'fixed' ? zoom.scale : 0 }); },
  }), []);
  const tab = useMemo(() => ({ id: 'file-body', signal, navigation: { params: { line, page } } }), [signal, line, page]);
  const useTabInfo = () => ({ tab });
  const useStore = selector => selector({ byTab: { 'file-body': kind === 'image' ? view.zoom ?? { kind: 'fit-width' } : view } });
  useEffect(() => {
    if (page === previousPage.current) return;
    previousPage.current = page;
    if (page !== undefined) {
      setView(previous => ({ ...previous, page }));
      restoringTop.current = undefined; restoringPage.current = page; measure();
    }
  }, [page, measure]);
  useEffect(() => {
    const node = scrollport.current;
    if (!node) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    for (const child of node.children) resize.observe(child);
    const mutation = new MutationObserver(measure);
    mutation.observe(node, { subtree: true, childList: true, attributes: true });
    return () => { resize.disconnect(); mutation.disconnect(); };
  }, [kind, text, bytes, scrollNode, measure]);
  useEffect(() => {
    const node = scrollport.current;
    if (!node) return;
    if (line !== undefined && (kind === 'text' || kind === 'code')) {
      const landed = scrollToLine(node, line);
      if (landed) { measure(); return; }
      const mutation = new MutationObserver(() => { if (scrollToLine(node, line)) mutation.disconnect(); });
      mutation.observe(node, { subtree: true, childList: true });
      measure();
      return () => mutation.disconnect();
    }
    if (kind === 'pdf') measure();
  }, [kind, line, page, text, bytes, scrollNode, measure]);
  const content = bytes ? { kind: 'bytes', data: bytes } : { kind: 'text', text, eof: true, pages: [{ offset: 1, text, lines: text.split('\n').length }] };
  const presentationContent = useMemo(() => kind === 'markdown' ? { ...content, text: withResolvedMarkdownImages(text, resources) } : content, [kind, text, bytes, resources]);
  const props = { useInteractivePreview: selector => selector(false), addResource: retainTab, setResources: retainTab, content: presentationContent, resourceAddress: name, wrap: true, useTabInfo, useStore, useResource, actions, retainTab, t, scrollportRef: bindScrollport, ZoomViewport, zoomSurfaceClass };
  const body = kind === 'html' ? <HtmlBody {...props} /> : kind === 'code' ? <CodeBody {...props} /> : kind === 'markdown' ? <MarkdownBody {...props} /> : kind === 'image' ? <ImageBody {...props} /> : kind === 'pdf' ? <Suspense fallback={<p role="status">文档渲染中…</p>}><PdfBody {...props} loading={<p role="status">文档渲染中…</p>} /></Suspense> : <TextBody {...props} />;
  return <div ref={host} className="dsh-ui-host dsh-file-preview" style={{ '--preview-fade-top': edges.top, '--preview-fade-bottom': edges.bottom }} onWheelCapture={cancelRestoration} onPointerDownCapture={cancelRestoration} onKeyDownCapture={cancelRestoration} onScrollCapture={event => {
    if (event.target !== scrollport.current) return;
    if (restoringTop.current !== undefined || restoringPage.current !== undefined) { measure(); return; }
    scrollTop.current = event.target.scrollTop;
    callback.current?.({ scrollTop: scrollTop.current }); measure();
  }}>
    {line !== undefined && (kind === 'text' || kind === 'code') && (line < 1 || line > text.split('\n').length) ? <p role="status">请求行不在此版本的源码范围内。</p> : null}
    {portal ? <HostPortalProvider value={portal}>{kind === 'text' || kind === 'markdown' ? <div className="dsh-file-preview__scroll" ref={bindScrollport}>{body}</div> : body}</HostPortalProvider> : null}
  </div>;
}
