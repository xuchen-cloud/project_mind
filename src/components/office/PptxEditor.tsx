import { useEffect, useLayoutEffect, useMemo, useRef, useState, useId, type CSSProperties } from 'react';
import { Undo2, Redo2, PanelLeftClose, PanelLeftOpen, ChevronUp, ChevronDown, Minus, Plus, ArrowLeft, ArrowUp, ArrowDown, ArrowRight } from 'lucide-react';
import { HomeSidebarList } from '../home/HomeSidebarList';
import { ToolbarButton } from '../../ui/components/ToolbarButton';
import { previewSlides, ReactSvgSlide } from '../../../packages/office-pptx/dist/browser.mjs';
import type { PptxModel, PptxEdit } from '../../../packages/office-pptx/types';
import './PptxEditor.css';
export type { PptxModel, PptxEdit } from '../../../packages/office-pptx/types';

export interface PptxEditorProps {
  model: PptxModel;
  edits: PptxEdit[];
  onChange: (edits: PptxEdit[]) => void;
  readOnly: boolean;
}
const editKey = (e: PptxEdit) => `${e.slideIndex}:${e.cNvPrId}:${e.kind}${e.kind === 'text' ? `:${e.paragraphIndex}:${e.runIndex}` : ''}`;
const zoomLevels = [25, 50, 75, 100, 125, 150, 200];

export function PptxEditor({ model, edits, onChange, readOnly }: PptxEditorProps) {
  const thumbnailsId = useId();
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<{ slideIndex: number; id: string } | null>(null);
  const [thumbnailsOpen, setThumbnailsOpen] = useState(true);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [viewportWidth, setViewportWidth] = useState(0);
  const [error, setError] = useState('');
  const [edges, setEdges] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLDivElement | null)[]>([]);
  const thumbnails = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<{ undo: PptxEdit[][]; redo: PptxEdit[][] }>({ undo: [], redo: [] });
  const currentPage = Math.min(page, Math.max(0, model.slides.length - 1));
  const slides = useMemo(() => previewSlides(model, edits), [model, edits]);
  const text = selection && model.textElements.find(e => e.slideIndex === selection.slideIndex && selection.id === `slide-${e.slideIndex}:shape-${e.cNvPrId}`);
  const image = selection && model.pictureElements.find(e => e.slideIndex === selection.slideIndex && selection.id === `slide-${e.slideIndex}:shape-${e.cNvPrId}`);
  const baseWidth = slides[0]?.widthPx ?? 960;
  const fitScale = Math.max(.25, Math.min(1, (viewportWidth - 50) / baseWidth));
  const scale = zoom === 'fit' ? fitScale : zoom / 100;
  const zoomAnchor = useRef<{ page: number; fraction: number } | null>(null);
  const percent = Math.round(scale * 100);
  useEffect(() => { setSelection(null); setError(''); setHistory({ undo: [], redo: [] }); }, [model]);

  function measure() {
    const node = viewport.current;
    if (!node) return;
    setViewportWidth(node.clientWidth);
    const fade = (position: number, max: number) => {
      const distance = Math.min(64, max / 2);
      const clamped = Math.max(0, Math.min(max, position));
      return distance ? [Math.min(1, clamped / distance), Math.min(1, (max - clamped) / distance)] : [0, 0];
    };
    const [top, bottom] = fade(node.scrollTop, Math.max(0, node.scrollHeight - node.clientHeight));
    const [left, right] = fade(node.scrollLeft, Math.max(0, node.scrollWidth - node.clientWidth));
    setEdges(old => old.top === top && old.bottom === bottom && old.left === left && old.right === right ? old : { top, bottom, left, right });
  }
  function trackPage() {
    measure();
    const node = viewport.current;
    if (!node) return;
    const frame = node.getBoundingClientRect();
    let best = currentPage, visible = 0;
    canvases.current.forEach((canvas, index) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(rect.bottom, frame.bottom) - Math.max(rect.top, frame.top));
      if (overlap > visible) { visible = overlap; best = index; }
    });
    if (visible) setPage(best);
  }
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (deck.current) observer.observe(deck.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(measure, [model, edits, zoom, scale, thumbnailsOpen]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const node = viewport.current;
    const canvas = anchor && canvases.current[anchor.page];
    if (!node || !canvas || !anchor) return;
    // Keep the same point of the current slide in view when its displayed size changes.
    const rect = canvas.getBoundingClientRect();
    const top = rect.top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTop = top + anchor.fraction * rect.height;
    setPage(anchor.page);
    measure();
  }, [scale, zoom]);
  useEffect(() => {
    const list = thumbnails.current;
    const item = list?.querySelector<HTMLElement>(`[data-slide-index="${currentPage}"]`);
    if (!list || !item) return;
    const a = list.getBoundingClientRect(), b = item.getBoundingClientRect();
    if (b.top < a.top) list.scrollTop -= a.top - b.top;
    else if (b.bottom > a.bottom) list.scrollTop += b.bottom - a.bottom;
    list.dispatchEvent(new Event('scroll'));
  }, [currentPage, thumbnailsOpen]);

  function navigate(index: number) {
    const canvas = canvases.current[index];
    const node = viewport.current;
    setPage(index); setSelection(null); setError('');
    if (canvas && node) node.scrollTop += canvas.getBoundingClientRect().top - node.getBoundingClientRect().top - 24;
    measure();
  }
  function changeZoom(value: number | 'fit') {
    const node = viewport.current, canvas = canvases.current[currentPage];
    if (node && canvas) {
      const rect = canvas.getBoundingClientRect();
      zoomAnchor.current = { page: currentPage, fraction: rect.height ? (node.getBoundingClientRect().top - rect.top) / rect.height : 0 };
    }
    setZoom(value);
  }
  function stepZoom(direction: number) { changeZoom(Math.max(25, Math.min(200, (Math.round(percent / 25) + direction) * 25))); }
  function update(e: PptxEdit, original: string | { x: number; y: number }) {
    if (readOnly) return;
    const isBaseline = e.kind === 'text' ? e.text === original : typeof original !== 'string' && e.x === original.x && e.y === original.y;
    setHistory(h => ({ undo: [...h.undo.slice(-99), edits], redo: [] }));
    onChange([...edits.filter(existing => editKey(existing) !== editKey(e)), ...(isBaseline ? [] : [e])]);
  }
  function travel(direction: 'undo' | 'redo') {
    if (readOnly || !history[direction].length) return;
    const stack = history[direction];
    const opposite = direction === 'undo' ? 'redo' : 'undo';
    onChange(stack[stack.length - 1]);
    setHistory({ ...history, [direction]: stack.slice(0, -1), [opposite]: [...history[opposite], edits] });
    setError('');
  }
  const pendingImage = image && edits.find(e => e.kind === 'move-image' && e.slideIndex === image.slideIndex && e.cNvPrId === image.cNvPrId);
  const offset = pendingImage?.kind === 'move-image' ? pendingImage : image?.transform.offset;
  if (!slides.length) return <p>此演示文稿没有可预览的幻灯片。</p>;

  return <div className="pptx-editor" onKeyDown={event => {
    if (event.key === 'Escape') { setSelection(null); setError(''); }
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || event.nativeEvent.isComposing) return;
    event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo');
  }}>
    <div className="pptx-editor__toolbar" role="toolbar" aria-label="幻灯片内容编辑">
      <ToolbarButton type="button" aria-label={thumbnailsOpen ? '收起幻灯片列表' : '展开幻灯片列表'} title={thumbnailsOpen ? '收起幻灯片列表' : '展开幻灯片列表'} aria-expanded={thumbnailsOpen} aria-controls={thumbnailsId} onClick={() => setThumbnailsOpen(open => !open)}>{thumbnailsOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</ToolbarButton>
      <span className="pptx-editor__separator" />
      <ToolbarButton type="button" aria-label="撤销" title="撤销" disabled={readOnly || !history.undo.length} onClick={() => travel('undo')}><Undo2 /></ToolbarButton>
      <ToolbarButton type="button" aria-label="重做" title="重做" disabled={readOnly || !history.redo.length} onClick={() => travel('redo')}><Redo2 /></ToolbarButton>
      <span className="pptx-editor__mode">{readOnly ? '只读' : '内容编辑'}</span>
      <span className="pptx-editor__hint">点击文字原位编辑</span>
    </div>
    {image && offset && <div className="pptx-editor__image-tools" role="toolbar" aria-label="图片位置">
      <span>图片位置</span>
      {(['x', 'y'] as const).map(axis => <label key={axis}>{axis.toUpperCase()}<input type="number" aria-label={`图片${axis === 'x' ? '水平' : '垂直'}位置（厘米）`} step="0.1" value={Number((offset[axis] / 360000).toFixed(3))} disabled={readOnly || !image.editable} onChange={event => {
        if (event.target.value === '') return;
        const value = Number(event.target.value);
        if (Number.isFinite(value)) update({ kind: 'move-image', slideIndex: image.slideIndex, cNvPrId: image.cNvPrId, x: offset.x, y: offset.y, [axis]: Math.round(value * 360000) }, image.transform.offset);
      }} /></label>)}
      <span>cm</span>
      {([['左', -228600, 0, ArrowLeft], ['上', 0, -228600, ArrowUp], ['下', 0, 228600, ArrowDown], ['右', 228600, 0, ArrowRight]] as const).map(([label, dx, dy, Icon]) => <ToolbarButton key={label} type="button" aria-label={`图片${label}移`} title={`图片${label}移`} disabled={readOnly || !image.editable} onClick={() => update({ kind: 'move-image', slideIndex: image.slideIndex, cNvPrId: image.cNvPrId, x: offset.x + dx, y: offset.y + dy }, image.transform.offset)}><Icon /></ToolbarButton>)}
    </div>}
    {((text && !text.editable) || (image && !image.editable) || error) && <p className="pptx-editor__notice" role={error ? 'alert' : 'status'}>{error || (text || image)?.unsupportedReason}</p>}
    <div className="pptx-editor__body" data-thumbnails-open={thumbnailsOpen}>
      <aside id={thumbnailsId} className="pptx-editor__thumbnails" inert={!thumbnailsOpen} aria-hidden={!thumbnailsOpen}>
        <div className="pptx-editor__thumbnail-inner"><HomeSidebarList label="选择幻灯片" scrollRef={thumbnails}>{slides.map((slide, i) => <button className="pptx-editor__thumb" data-slide-index={i} key={model.slides[i].path} type="button" aria-label={`第 ${i + 1} 页`} aria-pressed={i === currentPage} onClick={() => navigate(i)}><span>{i + 1}</span><span className="pptx-editor__thumb-canvas"><ReactSvgSlide slide={slide} label={`第 ${i + 1} 页缩略图`} /></span></button>)}</HomeSidebarList></div>
      </aside>
      <section className="pptx-editor__stage" style={{ '--pptx-fade-top': edges.top, '--pptx-fade-bottom': edges.bottom, '--pptx-fade-left': edges.left, '--pptx-fade-right': edges.right } as CSSProperties}>
        <div className="pptx-editor__viewport" role="region" aria-label="幻灯片画布" ref={viewport} onScroll={trackPage}>
          <div className="pptx-editor__deck" ref={deck}>{slides.map((slide, i) => <div key={model.slides[i].path} className="pptx-editor__page">
            <div className="pptx-editor__page-number">{i + 1}</div>
            <div className="pptx-editor__canvas" ref={node => { canvases.current[i] = node; }} style={{ width: slide.widthPx * scale }} onClick={event => {
              if (!(event.target as Element).closest('[data-source-id]')) setSelection(null);
            }}><ReactSvgSlide slide={slide} label={`第 ${i + 1} 页预览`} selectedId={selection?.slideIndex === i ? selection.id : undefined} onSelect={id => { setPage(i); setSelection({ slideIndex: i, id }); setError(''); }} textTarget={!readOnly && text?.slideIndex === i ? text : undefined} edits={edits} readOnly={readOnly} onTextChange={(paragraphIndex, runIndex, value) => {
              if (!text || !text.editable) return;
              if (/[\r\n\u2028\u2029]/.test(value)) { setError('暂不支持新增段落或换行；请分别编辑已有文字。'); return; }
              setError('');
              update({ kind: 'text', slideIndex: i, cNvPrId: text.cNvPrId, paragraphIndex, runIndex, text: value }, text.originalRichText.paragraphs[paragraphIndex].runs[runIndex].text);
            }} /></div>
          </div>)}</div>
        </div>
        {(['top', 'bottom', 'left', 'right'] as const).map(side => <div key={side} className={`pptx-editor__edge pptx-editor__edge--${side}`} aria-hidden="true" />)}
      </section>
    </div>
    <footer className="pptx-editor__footer">
      <div className="pptx-editor__navigation"><ToolbarButton type="button" aria-label="上一页" title="上一页" disabled={currentPage === 0} onClick={() => navigate(currentPage - 1)}><ChevronUp /></ToolbarButton><span>幻灯片 {currentPage + 1} / {slides.length}</span><ToolbarButton type="button" aria-label="下一页" title="下一页" disabled={currentPage === slides.length - 1} onClick={() => navigate(currentPage + 1)}><ChevronDown /></ToolbarButton></div>
      <div className="pptx-editor__zoom"><ToolbarButton type="button" aria-label="缩小" title="缩小" disabled={percent <= 25} onClick={() => stepZoom(-1)}><Minus /></ToolbarButton><select aria-label="幻灯片缩放" data-mode={zoom === 'fit' ? 'fit' : 'manual'} value={zoom} onChange={event => changeZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">适合宽度 · {zoom === 'fit' ? percent : Math.round(fitScale * 100)}%</option>{zoomLevels.map(value => <option value={value} key={value}>{value}%</option>)}{zoom !== 'fit' && !zoomLevels.includes(zoom) && <option value={zoom}>{zoom}%</option>}</select><ToolbarButton type="button" aria-label="放大" title="放大" disabled={percent >= 200} onClick={() => stepZoom(1)}><Plus /></ToolbarButton></div>
    </footer>
  </div>;
}
