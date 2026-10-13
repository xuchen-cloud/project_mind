import { useEffect, useMemo, useState } from 'react';
import { Undo2, Redo2, ChevronDown, ArrowLeft, ArrowUp, ArrowDown, ArrowRight } from 'lucide-react';
import { HomeSidebarList } from '../home/HomeSidebarList';
import { ToolbarButton } from '../../ui/components/ToolbarButton';
import { previewSlides, ReactSvgSlide } from '../../../packages/office-pptx/dist/browser.mjs';
import type { PptxModel, PptxEdit, PptxTextElement } from '../../../packages/office-pptx/types';
export type { PptxModel, PptxEdit } from '../../../packages/office-pptx/types';

export interface PptxEditorProps {
  model: PptxModel;
  edits: PptxEdit[];
  onChange: (edits: PptxEdit[]) => void;
  readOnly: boolean;
}
const editKey = (e: PptxEdit) => `${e.slideIndex}:${e.cNvPrId}:${e.kind}${e.kind === 'text' ? `:${e.paragraphIndex}:${e.runIndex}` : ''}`;

export function PptxEditor({ model, edits, onChange, readOnly }: PptxEditorProps) {
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ undo: PptxEdit[][]; redo: PptxEdit[][] }>({ undo: [], redo: [] });
  const currentPage = Math.min(page, Math.max(0, model.slides.length - 1));
  const slides = useMemo(() => previewSlides(model, edits), [model, edits]);
  const textElements = model.textElements.filter(e => e.slideIndex === currentPage && e.text);
  const pictures = model.pictureElements.filter(e => e.slideIndex === currentPage);
  const text = textElements.find(e => selection === `text:${e.cNvPrId}`);
  const image = pictures.find(e => selection === `picture:${e.cNvPrId}`);
  useEffect(() => { setSelection(''); setError(''); setHistory({ undo: [], redo: [] }); }, [model]);

  function select(value: string) { setSelection(value); setPanelOpen(true); setError(''); }
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
  function textControls(target: PptxTextElement) {
    return <fieldset disabled={readOnly || !target.editable}>
      <legend>文字内容</legend>
      {target.unsupportedReason && <p className="pptx-editor__help" role="status">{target.unsupportedReason}</p>}
      {target.originalRichText.paragraphs.map((paragraph, p) => <div key={p}>
        {paragraph.runs.map((run, r) => {
          if (run.text === '\n') return <br key={r} />;
          const pending = edits.find(e => e.kind === 'text' && e.slideIndex === target.slideIndex && e.cNvPrId === target.cNvPrId && e.paragraphIndex === p && e.runIndex === r);
          return <label key={r} className="pptx-editor__field">
            {target.originalRichText.paragraphs.length === 1 && paragraph.runs.length === 1 ? '选中的文本' : `第 ${p + 1} 段 · 片段 ${r + 1}`}
            <textarea aria-label={`第 ${p + 1} 段第 ${r + 1} 片段`} rows={4} readOnly={readOnly || !target.editable} value={pending?.kind === 'text' ? pending.text : run.text} onChange={event => {
              const value = event.target.value;
              if (/[\r\n]/.test(value)) { setError('暂不支持新增段落或换行；请分别编辑已有片段。'); return; }
              setError('');
              update({ kind: 'text', slideIndex: target.slideIndex, cNvPrId: target.cNvPrId, paragraphIndex: p, runIndex: r, text: value }, run.text);
            }} />
          </label>;
        })}
      </div>)}
      <p className="pptx-editor__help">保留原有样式，分别修改已有文字片段。</p>
    </fieldset>;
  }
  const pendingImage = image && edits.find(e => e.kind === 'move-image' && e.slideIndex === image.slideIndex && e.cNvPrId === image.cNvPrId);
  const offset = pendingImage?.kind === 'move-image' ? pendingImage : image?.transform.offset;
  const selectedSourceId = text || image ? `slide-${currentPage}:shape-${(text ?? image)!.cNvPrId}` : undefined;
  if (!slides[currentPage]) return <p>此演示文稿没有可预览的幻灯片。</p>;

  return <div className="pptx-editor">
    <style>{`
      .pptx-editor { container-type:inline-size; display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; font:12px/1.5 var(--font-ui); color:var(--color-text-primary); background:var(--color-bg); }
      .pptx-editor__toolbar { display:flex; align-items:center; gap:4px; height:36px; flex:none; padding:0 12px; border-bottom:1px solid var(--color-border); }
      .pptx-editor__toolbar button,.pptx-editor__move button { width:28px; height:28px; }
      .pptx-editor__toolbar svg,.pptx-editor__move svg { width:15px; height:15px; }
      .pptx-editor__mode { padding-left:8px; margin-left:4px; border-left:1px solid var(--color-border); color:var(--color-text-secondary); }
      .pptx-editor__body { display:grid; grid-template-columns:156px minmax(0,1fr) 226px; flex:1; min-height:0; min-width:0; }
      .pptx-editor__thumbnails { display:flex; flex-direction:column; min-height:0; padding:12px 10px; border-right:1px solid var(--color-border); background:var(--color-bg-subtle); }
      .pptx-editor .home-side__list-frame { position:relative; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
      .pptx-editor .home-side__list { flex:1; min-height:0; min-width:0; overflow:auto; padding-right:8px; }
      .pptx-editor .home-side__list > div { display:flex; flex-direction:column; gap:14px; }
      .pptx-editor .home-side__list-frame::before,.pptx-editor .home-side__list-frame::after { content:''; position:absolute; left:0; right:8px; height:min(40px,35%); pointer-events:none; z-index:1; }
      .pptx-editor .home-side__list-frame::before { top:0; background:linear-gradient(to bottom,var(--pptx-list-bg),transparent); opacity:var(--scroll-fade-top-opacity,0); }
      .pptx-editor .home-side__list-frame::after { bottom:0; background:linear-gradient(to top,var(--pptx-list-bg),transparent); opacity:var(--scroll-fade-bottom-opacity,0); }
      .pptx-editor__thumbnails { --pptx-list-bg:var(--color-bg-subtle); }
      .pptx-editor__thumb { display:flex; align-items:flex-start; gap:8px; width:100%; border:0; padding:0; background:transparent; color:var(--color-text-tertiary); cursor:pointer; text-align:left; font:inherit; }
      .pptx-editor__thumb > span:first-child { width:10px; flex:none; padding-top:3px; font-size:10px; }
      .pptx-editor__thumb-canvas { flex:1; min-width:0; border:1px solid var(--color-border); }
      .pptx-editor__thumb[aria-pressed=true] .pptx-editor__thumb-canvas { outline:2px solid var(--color-accent); outline-offset:1px; }
      .pptx-editor__stage { display:flex; min-height:0; min-width:0; padding:24px; background:var(--color-canvas); --pptx-list-bg:var(--color-canvas); }
      .pptx-editor__stage .home-side__list > div { min-height:100%; align-items:center; justify-content:center; }
      .pptx-editor__canvas { width:100%; max-width:960px; border:1px solid var(--color-border); }
      .pptx-editor__inspector { display:flex; flex-direction:column; min-height:0; padding:16px; border-left:1px solid var(--color-border); --pptx-list-bg:var(--color-bg); }
      .pptx-editor__inspector-content { display:flex; flex-direction:column; flex:1; min-height:0; }
      .pptx-editor__panel-toggle { display:none; }
      .pptx-editor__object { display:block; margin-bottom:16px; color:var(--color-text-secondary); font-size:11px; }
      .pptx-editor select { display:block; width:100%; min-width:0; height:28px; margin-top:6px; padding:0 6px; border:1px solid var(--color-border); border-radius:6px; font:12px var(--font-ui); color:var(--color-text-primary); background:var(--color-bg); }
      .pptx-editor fieldset { border:0; padding:0; margin:0; min-width:0; }
      .pptx-editor legend { margin:0 0 16px; padding:0; font-size:12px; font-weight:500; }
      .pptx-editor__field { display:block; margin-bottom:12px; color:var(--color-text-secondary); font-size:11px; }
      .pptx-editor textarea,.pptx-editor input { display:block; width:100%; margin-top:6px; padding:8px 9px; box-sizing:border-box; border:1px solid var(--color-border); border-radius:6px; color:var(--color-text-primary); background:var(--color-bg); font:12px/1.75 var(--font-ui); }
      .pptx-editor textarea { resize:vertical; }
      .pptx-editor input { height:28px; padding:4px 6px; }
      .pptx-editor__coordinates { display:flex; gap:8px; }
      .pptx-editor__coordinates label { min-width:0; flex:1; }
      .pptx-editor__move { display:flex; gap:4px; }
      .pptx-editor__help { font-size:11px; line-height:1.7; color:var(--color-text-tertiary); margin:8px 0 16px; }
      .pptx-editor__footer { display:flex; justify-content:space-between; align-items:center; flex:none; height:28px; padding:0 12px; border-top:1px solid var(--color-border); color:var(--color-text-secondary); font-size:11px; }
      .pptx-editor :is(button,input,textarea,select):focus-visible { outline:2px solid var(--color-accent); outline-offset:2px; }
      @container(max-width:800px) {
        .pptx-editor__body { grid-template-columns:156px minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; }
        .pptx-editor__thumbnails { grid-row:1 / 3; }
        .pptx-editor__stage { padding:16px; }
        .pptx-editor__inspector { grid-column:2; height:240px; max-height:240px; box-sizing:border-box; overflow:hidden; padding:0 12px; border-left:0; border-top:1px solid var(--color-border); transition:max-height var(--duration-standard) var(--ease-out); }
        .pptx-editor__inspector-content { flex:none; height:207px; box-sizing:border-box; padding-bottom:12px; opacity:1; visibility:visible; pointer-events:auto; transition:opacity var(--duration-standard) var(--ease-out),visibility 0s; }
        .pptx-editor__panel-toggle { display:flex; align-items:center; justify-content:space-between; height:32px; flex:none; padding:0; border:0; background:transparent; color:var(--color-text-secondary); font:12px var(--font-ui); cursor:pointer; }
        .pptx-editor__panel-toggle svg { width:14px; height:14px; transition:transform var(--duration-standard) var(--ease-out); }
        .pptx-editor__panel-toggle[aria-expanded=true] svg { transform:rotate(180deg); }
        .pptx-editor__inspector[data-collapsed=true] { max-height:32px; }
        .pptx-editor__inspector[data-collapsed=true] .pptx-editor__inspector-content { opacity:0; visibility:hidden; pointer-events:none; transition:opacity var(--duration-standard) var(--ease-out),visibility 0s linear var(--duration-standard); }
      }
      @container(max-width:420px) { .pptx-editor__body { grid-template-columns:112px minmax(0,1fr); } .pptx-editor__stage { padding:10px; } }
      @media(prefers-reduced-motion:reduce) { .pptx-editor__inspector,.pptx-editor__inspector[data-collapsed] .pptx-editor__inspector-content,.pptx-editor__panel-toggle svg { transition:none; } }
    `}</style>
    <div className="pptx-editor__toolbar" role="toolbar" aria-label="幻灯片内容编辑">
      <ToolbarButton type="button" aria-label="撤销" title="撤销" disabled={readOnly || !history.undo.length} onClick={() => travel('undo')}><Undo2 /></ToolbarButton>
      <ToolbarButton type="button" aria-label="重做" title="重做" disabled={readOnly || !history.redo.length} onClick={() => travel('redo')}><Redo2 /></ToolbarButton>
      <span className="pptx-editor__mode">{readOnly ? '只读' : '内容编辑'}</span>
    </div>
    <div className="pptx-editor__body">
      <aside className="pptx-editor__thumbnails">
        <HomeSidebarList label="选择幻灯片">{slides.map((slide, i) => <button className="pptx-editor__thumb" key={model.slides[i].path} type="button" aria-label={`第 ${i + 1} 页`} aria-pressed={i === currentPage} onClick={() => { setPage(i); select(''); }}><span>{i + 1}</span><span className="pptx-editor__thumb-canvas"><ReactSvgSlide slide={slide} label={`第 ${i + 1} 页缩略图`} /></span></button>)}</HomeSidebarList>
      </aside>
      <section className="pptx-editor__stage">
        <HomeSidebarList label="幻灯片预览"><div className="pptx-editor__canvas"><ReactSvgSlide slide={slides[currentPage]} label={`第 ${currentPage + 1} 页预览`} selectedId={selectedSourceId} onSelect={id => {
          const selectedText = textElements.find(t => id === `slide-${currentPage}:shape-${t.cNvPrId}`);
          const selectedPicture = pictures.find(p => id === `slide-${currentPage}:shape-${p.cNvPrId}`);
          if (selectedText) select(`text:${selectedText.cNvPrId}`);
          else if (selectedPicture) select(`picture:${selectedPicture.cNvPrId}`);
        }} /></div></HomeSidebarList>
      </section>
      <aside className="pptx-editor__inspector" data-collapsed={!panelOpen}>
        <button type="button" className="pptx-editor__panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(open => !open)}>对象属性<ChevronDown /></button>
        <div className="pptx-editor__inspector-content">
          <label className="pptx-editor__object">选择对象<select aria-label="选择对象" value={selection} onChange={event => select(event.target.value)}><option value="">选择文字或图片</option>{textElements.map(t => <option key={`text:${t.cNvPrId}`} value={`text:${t.cNvPrId}`}>文字：{t.text}</option>)}{pictures.map((p, i) => <option key={`picture:${p.cNvPrId}`} value={`picture:${p.cNvPrId}`}>图片 {i + 1}</option>)}</select></label>
          <HomeSidebarList label="对象属性">
            {text ? textControls(text) : image && offset ? <fieldset disabled={readOnly || !image.editable}>
              <legend>图片位置</legend>
              {image.unsupportedReason && <p className="pptx-editor__help">{image.unsupportedReason}</p>}
              <div className="pptx-editor__coordinates">{(['x', 'y'] as const).map(axis => <label key={axis} className="pptx-editor__field">{axis === 'x' ? '水平' : '垂直'} · cm<input type="number" aria-label={`图片${axis === 'x' ? '水平' : '垂直'}位置（厘米）`} step="0.1" value={Number((offset[axis] / 360000).toFixed(3))} readOnly={readOnly || !image.editable} onChange={event => {
                if (event.target.value === '') return;
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                update({ kind: 'move-image', slideIndex: image.slideIndex, cNvPrId: image.cNvPrId, x: offset.x, y: offset.y, [axis]: Math.round(value * 360000) }, image.transform.offset);
              }} /></label>)}</div>
              <div className="pptx-editor__move">{([['左', -228600, 0, ArrowLeft], ['上', 0, -228600, ArrowUp], ['下', 0, 228600, ArrowDown], ['右', 228600, 0, ArrowRight]] as const).map(([label, dx, dy, Icon]) => <ToolbarButton key={label} type="button" aria-label={`图片${label}移`} title={`图片${label}移`} disabled={readOnly || !image.editable} onClick={() => update({ kind: 'move-image', slideIndex: image.slideIndex, cNvPrId: image.cNvPrId, x: offset.x + dx, y: offset.y + dy }, image.transform.offset)}><Icon /></ToolbarButton>)}</div>
              <p className="pptx-editor__help">修改位置，保留图片、尺寸及原有样式。</p>
            </fieldset> : <p className="pptx-editor__help">在画布中选择文字或图片，查看可编辑的属性。</p>}
            {error && <p role="alert">{error}</p>}
          </HomeSidebarList>
        </div>
      </aside>
    </div>
    <footer className="pptx-editor__footer"><span>幻灯片 {currentPage + 1} / {slides.length}</span><span>适合画布</span></footer>
  </div>;
}
