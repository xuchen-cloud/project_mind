import { useId, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { buildRenderSlide } from '@genoffice/pptx-render';
import type { Slide } from './vendor/packages/pptx-engine/src/types';
import type { RenderSlide, RenderNode, RenderFill, RenderTextLayout, GlyphRun, TextLine, ChartRenderNode } from './vendor/packages/pptx-render/src/render-tree';
import type { PptxModel, PptxEdit, PptxRenderSlide, PptxTextElement } from './types';

/** Rebuild real GenOffice layout for pending edits; never mutates the baseline. */
export function previewSlides(model: PptxModel, edits: PptxEdit[]): PptxRenderSlide[] {
  if (!edits.length) return model.renderSlides;
  const editedSlides = new Set(edits.map(e => e.slideIndex));
  const slides = model.slides.map((slide, i) => editedSlides.has(i) ? structuredClone(slide) : slide) as Slide[];
  for (const e of edits) {
    const el = slides[e.slideIndex]?.elements.find(el => el.id === `slide-${e.slideIndex}:shape-${e.cNvPrId}`);
    if (!el) throw new Error('Preview target is missing from the baseline');
    if (e.kind === 'text' && (el.type === 'text' || el.type === 'shape') && el.text) el.text.paragraphs[e.paragraphIndex].runs[e.runIndex].text = e.text;
    else if (e.kind === 'move-image' && el.type === 'picture') el.transform.offset = { ...el.transform.offset, x: e.x, y: e.y };
    else throw new Error('Unsupported preview edit');
  }
  return slides.map((slide, index) => editedSlides.has(index) ? buildRenderSlide(slide, model.size, { fitWidthPx: 960, slideNo: index + 1, media: ref => model.media[ref] }) : model.renderSlides[index]);
}

function FillDefs({ fill, id }: { fill: RenderFill; id: string }) {
  if (fill.kind === 'gradient') {
    const stops = fill.stops.map((s, i) => <stop key={i} offset={`${s.pos * 100}%`} stopColor={s.color} />);
    return fill.radial ? <radialGradient id={id} cx={fill.center?.x ?? 0.5} cy={fill.center?.y ?? 0.5}>{stops}</radialGradient> : <linearGradient id={id} x1="0" y1="0" x2="1" y2="0" gradientTransform={`rotate(${fill.angleDeg} .5 .5)`}>{stops}</linearGradient>;
  }
  if (fill.kind === 'image') return <pattern id={id} width="1" height="1" patternContentUnits="objectBoundingBox"><image href={fill.dataUrl} width="1" height="1" opacity={fill.alpha} preserveAspectRatio="none" /></pattern>;
  if (fill.kind === 'pattern') return <pattern id={id} width={fill.cellPx} height={fill.cellPx} patternUnits="userSpaceOnUse"><rect width={fill.cellPx} height={fill.cellPx} fill={fill.bg} /><path d={`M0 0 L${fill.cellPx} ${fill.cellPx}`} stroke={fill.fg} strokeWidth="1" /></pattern>;
  return null;
}
const fillPaint = (fill: RenderFill, id: string) => fill.kind === 'none' ? 'none' : fill.kind === 'solid' ? fill.color : `url(#${id})`;

type TextEditingProps = {
  textTarget?: PptxTextElement;
  edits?: PptxEdit[];
  readOnly?: boolean;
  onTextChange?: (paragraphIndex: number, runIndex: number, text: string) => void;
};

/** Stable source-run keys keep the native input (and IME/caret) alive through preview layout. */
function RunInput({ value, paragraphIndex, runIndex, style, autoFocus, onTextChange, onFocus, onBlur }: {
  value: string; paragraphIndex: number; runIndex: number; style: CSSProperties; autoFocus: boolean;
  onTextChange: NonNullable<TextEditingProps['onTextChange']>; onFocus: () => void; onBlur: () => void;
}) {
  const composing = useRef(false);
  return <textarea aria-label={`第 ${paragraphIndex + 1} 段第 ${runIndex + 1} 片段`}
    title="原位编辑已有文字片段；支持中文输入，不支持新增换行；复杂排版按片段编辑，字体与换行以预览为准。"
    value={value} autoFocus={autoFocus} rows={1} spellCheck={false} style={style}
    onFocus={onFocus} onBlur={onBlur} onClick={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.key === 'Enter') {
        event.stopPropagation();
        if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) event.preventDefault();
      }
    }}
    onBeforeInput={event => {
      const input = event.nativeEvent as InputEvent;
      if (!composing.current && !input.isComposing && (input.inputType === 'insertParagraph' || input.inputType === 'insertLineBreak')) event.preventDefault();
    }}
    onChange={event => onTextChange(paragraphIndex, runIndex, event.currentTarget.value)} />;
}

type RunFragment = { glyph: GlyphRun; line: TextLine };
function Text({ layout, boxWidth = 0, prefix = '', textTarget, edits = [], readOnly, onTextChange }: {
  layout?: RenderTextLayout; boxWidth?: number; prefix?: string;
} & TextEditingProps) {
  const [active, setActive] = useState<string>();
  const canEdit = textTarget?.editable && !readOnly && onTextChange;
  const fragments = new Map<string, RunFragment[]>();
  const paragraphLines = new Map<number, TextLine[]>();
  let paragraphIndex = -1;
  const lineParagraphs = layout?.lines.map(line => {
    if (line.paraStart || paragraphIndex < 0) paragraphIndex++;
    paragraphLines.set(paragraphIndex, [...(paragraphLines.get(paragraphIndex) ?? []), line]);
    for (const glyph of line.runs) if (!glyph.isBullet && glyph.srcRunIdx != null) {
      const key = `${paragraphIndex}-${glyph.srcRunIdx}`;
      fragments.set(key, [...(fragments.get(key) ?? []), { glyph, line }]);
    }
    return paragraphIndex;
  }) ?? [];
  // Empty model runs have no glyphs. Anchor them between their source neighbours,
  // or on the paragraph's empty layout line, so deleting all text remains reversible.
  const inputs = canEdit ? textTarget.originalRichText.paragraphs.flatMap((paragraph, pi) => {
    let emptyOffset = 0;
    return paragraph.runs.map((run, ri) => {
      if (run.text === '\n') return null;
      const key = `${pi}-${ri}`;
      const parts = fragments.get(key) ?? [];
      const first = parts[0]?.glyph;
      const previous = paragraph.runs.slice(0, ri).flatMap((_, i) => fragments.get(`${pi}-${i}`) ?? []).at(-1);
      const next = paragraph.runs.slice(ri + 1).flatMap((_, i) => fragments.get(`${pi}-${ri + 1 + i}`) ?? [])[0];
      const line = parts[0]?.line ?? previous?.line ?? next?.line ?? paragraphLines.get(pi)?.[0];
      const glyph = first ?? previous?.glyph ?? next?.glyph;
      const fontSize = first?.fontSizePx ?? (run.fontSize ? run.fontSize * 96 / 72 * (layout?.fontScale ?? 1) : glyph?.fontSizePx ?? 16);
      const fallbackY = line?.top ?? pi * fontSize * 1.2;
      const left = parts.length ? Math.min(...parts.map(p => p.glyph.x)) : (previous ? previous.glyph.x + previous.glyph.widthPx : next?.glyph.x ?? line?.marLPx ?? 0) + emptyOffset;
      const top = parts.length ? Math.min(...parts.map(p => p.glyph.baselineY - (p.glyph.ascentPx ?? p.glyph.fontSizePx * .8))) : fallbackY;
      const right = parts.length ? Math.max(...parts.map(p => p.glyph.x + p.glyph.widthPx)) : left + Math.max(12, fontSize * .6);
      const bottom = parts.length ? Math.max(...parts.map(p => p.glyph.baselineY - (p.glyph.ascentPx ?? p.glyph.fontSizePx * .8) + Math.max(p.glyph.fontSizePx * 1.2, p.line.height))) : top + fontSize * 1.2;
      if (!parts.length) emptyOffset += right - left;
      else emptyOffset = 0;
      const w = Math.max(12, right - left), h = Math.max(fontSize * 1.2, bottom - top);
      const clip = `${prefix}-run-${key}`;
      const edit = edits.findLast(e => e.kind === 'text' && e.slideIndex === textTarget.slideIndex && e.cNvPrId === textTarget.cNvPrId && e.paragraphIndex === pi && e.runIndex === ri);
      const value = edit?.kind === 'text' ? edit.text : run.text;
      const focused = active === key;
      const singleLine = new Set(parts.map(p => p.line)).size <= 1;
      const availableWidth = next && next.line === line ? next.glyph.x - left : boxWidth - (layout?.insets.l ?? 0) - (layout?.insets.r ?? 0) - left;
      const inputWidth = focused && singleLine ? Math.max(w, availableWidth) : w;
      return <g key={key}>
        {/* Clip each line separately: a wrapped run's bounding box also contains other runs. */}
        <defs><clipPath id={clip}>{parts.length ? parts.map(({ glyph: r, line: ln }, i) => <rect key={i} x={r.x} y={r.baselineY - (r.ascentPx ?? r.fontSizePx * .8)} width={Math.max(2, r.widthPx)} height={Math.max(r.fontSizePx * 1.2, ln.height)} />) : <rect x={left} y={top} width={w} height={h} />}</clipPath></defs>
        <g clipPath={focused && singleLine ? undefined : `url(#${clip})`}>
          <foreignObject x={left} y={top} width={inputWidth} height={h}>
            <RunInput value={value} paragraphIndex={pi} runIndex={ri} autoFocus={pi === textTarget.originalRichText.paragraphs.findIndex(p => p.runs.length > 0) && ri === 0} onTextChange={onTextChange}
              onFocus={() => setActive(key)} onBlur={() => setActive(undefined)}
              style={{ display: 'block', boxSizing: 'border-box', width: '100%', height: '100%', margin: 0, padding: 0, border: 0, borderRadius: 0,
                outline: 'none', resize: 'none', overflow: 'hidden', background: focused ? (first?.highlight ?? 'transparent') : 'transparent',
                color: focused ? first?.color ?? glyph?.color ?? '#000' : 'transparent', caretColor: first?.color ?? '#000',
                fontFamily: `${first?.fontFamily ?? run.fontFamily ?? glyph?.fontFamily ?? 'Calibri'}, "Noto Sans SC", "Microsoft YaHei", sans-serif`,
                fontSize, fontWeight: (first?.bold ?? run.bold) ? 700 : 400, fontStyle: (first?.italic ?? run.italic) ? 'italic' : 'normal',
                textDecoration: [first?.underline ? 'underline' : '', first?.strike ? 'line-through' : ''].filter(Boolean).join(' '),
                letterSpacing: first?.letterSpacingPx, direction: first?.rtl ? 'rtl' : 'ltr',
                lineHeight: `${parts[0]?.line.height ?? fontSize * 1.2}px`, textIndent: first ? first.x - left : 0,
                whiteSpace: singleLine ? 'pre' : 'pre-wrap', overflowWrap: 'anywhere',
              }} />
          </foreignObject>
        </g>
      </g>;
    });
  }) : [];
  if (!layout && !canEdit) return null;
  return <g transform={`translate(${layout?.insets.l ?? 0},${layout?.insets.t ?? 0})`}>
    {layout?.lines.flatMap((line, i) => line.runs.map((r, j) => <g key={`${i}-${j}`} visibility={canEdit && !r.isBullet && r.srcRunIdx != null && active === `${lineParagraphs[i]}-${r.srcRunIdx}` ? 'hidden' : undefined}>
      {r.highlight && <rect x={r.x} y={r.baselineY - (r.ascentPx ?? r.fontSizePx * .8)} width={r.widthPx} height={r.fontSizePx} fill={r.highlight} />}
      {r.image ? <image href={r.image} x={r.x} y={r.baselineY - (r.ascentPx ?? r.fontSizePx)} width={r.widthPx} height={r.ascentPx ?? r.fontSizePx} /> : <text x={r.x} y={r.baselineY} fill={r.color} fontFamily={`${r.fontFamily}, "Noto Sans SC", "Microsoft YaHei", sans-serif`} fontSize={r.fontSizePx} fontWeight={r.bold ? 700 : 400} fontStyle={r.italic ? 'italic' : undefined} textDecoration={[r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined} letterSpacing={r.letterSpacingPx} direction={r.rtl ? 'rtl' : undefined} style={{ whiteSpace: 'pre' }} transform={r.rotate90 ? `rotate(90 ${r.x} ${r.baselineY})` : r.rotate270 ? `rotate(-90 ${r.x} ${r.baselineY})` : undefined}>{r.text}</text>}
    </g>))}
    {inputs}
  </g>;
}

function wedgePath(w: NonNullable<ChartRenderNode['wedges']>[number]) {
  const point = (radius: number, deg: number) => `${w.cx + radius * Math.cos(deg * Math.PI / 180)},${w.cy + radius * Math.sin(deg * Math.PI / 180)}`;
  // Split full-circle wedges into two arcs (SVG A cannot draw a coincident arc).
  const sweep = Math.min(359.9999, w.sweepDeg);
  const end = w.startDeg + sweep;
  return `M${point(w.outerR, w.startDeg)} A${w.outerR},${w.outerR} 0 ${sweep > 180 ? 1 : 0} 1 ${point(w.outerR, end)} ${w.innerR ? `L${point(w.innerR, end)} A${w.innerR},${w.innerR} 0 ${sweep > 180 ? 1 : 0} 0 ${point(w.innerR, w.startDeg)}` : `L${w.cx},${w.cy}`} Z`;
}

function Node({ node: n, prefix, onSelect, selectedId, ...editing }: { node: RenderNode; prefix: string; onSelect?: (id: string) => void; selectedId?: string } & TextEditingProps) {
  const b = n.box;
  const id = `${prefix}-${n.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const stroke = 'stroke' in n ? n.stroke : undefined;
  const strokeProps = { stroke: stroke?.color ?? 'none', strokeWidth: stroke?.widthPx, strokeDasharray: stroke?.dash?.join(' '), strokeLinecap: stroke?.cap, strokeLinejoin: stroke?.join };
  let drawing: ReactNode;
  if (n.type === 'group') drawing = n.children.map(child => <Node key={child.id} node={child} prefix={id} onSelect={onSelect} selectedId={selectedId} {...editing} />);
  else if (n.type === 'text' || n.type === 'shape') {
    const paint = fillPaint(n.fill, `${id}-fill`);
    const shape = n.pathData ? <path d={n.pathData} fill={paint} {...strokeProps} /> : n.polygonPoints ? <polygon points={n.polygonPoints.join(' ')} fill={paint} {...strokeProps} /> : n.presetGeometry === 'ellipse' ? <ellipse cx={b.w / 2} cy={b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={paint} {...strokeProps} /> : !n.line ? <rect width={b.w} height={b.h} rx={n.cornerRadiusPx} fill={paint} {...strokeProps} /> : null;
    drawing = <><defs><FillDefs fill={n.fill} id={`${id}-fill`} /></defs>{shape}{n.fillPathData && <path d={n.fillPathData} fill={paint} />}{n.strokePathData && <path d={n.strokePathData} fill="none" {...strokeProps} />}{n.line && <polyline points={n.line.points.join(' ')} fill="none" {...strokeProps} />}<Text key={n.sourceId} layout={n.text} boxWidth={b.w} prefix={id} {...editing} textTarget={editing.textTarget && n.sourceId === `slide-${editing.textTarget.slideIndex}:shape-${editing.textTarget.cNvPrId}` ? editing.textTarget : undefined} /></>;
  } else if (n.type === 'picture') {
    const crop = n.srcRect ?? { l: 0, r: 0, t: 0, b: 0 };
    const w = b.w / Math.max(.0001, 1 - crop.l - crop.r), h = b.h / Math.max(.0001, 1 - crop.t - crop.b);
    drawing = <><defs><clipPath id={`${id}-clip`}>{n.clip?.pathData ? <path d={n.clip.pathData} /> : n.clip?.polygonPoints ? <polygon points={n.clip.polygonPoints.join(' ')} /> : <rect width={b.w} height={b.h} rx={n.clip?.cornerRadiusPx} />}</clipPath></defs>{n.bgColor && <rect width={b.w} height={b.h} fill={n.bgColor} />}<g clipPath={`url(#${id}-clip)`}>{n.dataUrl && !/^data:image\/(?:x-emf|x-wmf)/.test(n.dataUrl) ? <image href={n.dataUrl} x={-crop.l * w} y={-crop.t * h} width={w} height={h} opacity={n.opacity} preserveAspectRatio="none" /> : <><rect width={b.w} height={b.h} fill="#eee" /><text x="8" y="20" fill="#555">图片预览不支持此格式</text></>}</g>{stroke && <rect width={b.w} height={b.h} fill="none" {...strokeProps} />}</>;
  } else if (n.type === 'table') drawing = <>{n.cells.map((cell, i) => <g key={i} transform={`translate(${cell.x},${cell.y})`}><defs><FillDefs fill={cell.fill} id={`${id}-cell-${i}`} /></defs><rect width={cell.w} height={cell.h} fill={fillPaint(cell.fill, `${id}-cell-${i}`)} />{(['l', 'r', 't', 'b'] as const).map(side => { const border = cell.borders?.[side]; return border ? <line key={side} x1={side === 'r' ? cell.w : 0} y1={side === 'b' ? cell.h : 0} x2={side === 'l' ? 0 : cell.w} y2={side === 't' ? 0 : cell.h} stroke={border.color} strokeWidth={border.widthPx} strokeDasharray={border.dash?.join(' ')} /> : null; })}<Text layout={cell.text} /></g>)}</>;
  else if (n.type === 'chart') drawing = <>
    {n.bgFill && <><defs><FillDefs fill={n.bgFill} id={`${id}-bg`} /></defs><rect width={b.w} height={b.h} fill={fillPaint(n.bgFill, `${id}-bg`)} /></>}
    {n.plotRect && <rect x={n.plotRect.x} y={n.plotRect.y} width={n.plotRect.w} height={n.plotRect.h} fill={n.plotRect.fill?.kind === 'solid' ? n.plotRect.fill.color : 'none'} stroke={n.plotRect.borderColor} strokeWidth={n.plotRect.borderWidthPx} />}
    {[...n.gridLines, ...n.axisLines].map((line, i) => <line key={`line-${i}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke={line.color} strokeWidth={line.widthPx ?? 1} strokeDasharray={'dash' in line ? line.dash?.join(' ') : undefined} />)}
    {n.paths?.map((p, i) => <path key={`path-${i}`} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidthPx} transform={p.dy ? `translate(0,${p.dy})` : undefined} />)}
    {n.bars.map((bar, i) => <rect key={`bar-${i}`} x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.color} />)}
    {n.polylines.map((line, i) => line.closed ? <polygon key={`poly-${i}`} points={line.points.join(' ')} stroke={line.color} strokeWidth={line.widthPx} fill={line.fill ?? 'none'} /> : <polyline key={`poly-${i}`} points={line.points.join(' ')} stroke={line.color} strokeWidth={line.widthPx} fill="none" strokeDasharray={line.dash?.join(' ')} />)}
    {n.wedges?.map((w, i) => <path key={`wedge-${i}`} d={wedgePath(w)} fill={w.noFill ? 'none' : w.color} stroke={w.stroke ?? 'white'} strokeWidth={w.strokeWidthPx ?? .5} />)}
    {n.markers.map((m, i) => <circle key={`mark-${i}`} cx={m.x} cy={m.y} r={m.r} fill={m.color} />)}
    {n.swatches.map((s, i) => <rect key={`swatch-${i}`} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.color} />)}
    {n.labels.map((l, i) => <text key={`label-${i}`} x={l.x} y={l.y + l.fontSizePx * .8} fill={l.color} fontSize={l.fontSizePx} fontFamily={l.fontFamily ?? 'Calibri, sans-serif'} fontWeight={l.bold ? 700 : 400} fontStyle={l.italic ? 'italic' : undefined} transform={l.rotationDeg ? `rotate(${l.rotationDeg} ${l.x} ${l.y})` : undefined}>{l.text}</text>)}
  </>;
  else if (n.type === 'placeholder-chip') drawing = <><rect width={b.w} height={b.h} fill="#f3f4f6" stroke="#999" /><text x="8" y="20" fill="#555">{n.label}</text></>;
  const selectable = !n.decoration && !!onSelect;
  const editingText = !!editing.textTarget && editing.textTarget.editable && !editing.readOnly && !!editing.onTextChange && n.sourceId === `slide-${editing.textTarget.slideIndex}:shape-${editing.textTarget.cNvPrId}`;
  const objectLabel = (n.type === 'text' || n.type === 'shape') && n.text ? n.text.lines.map(line => line.runs.map(r => r.text).join('')).join(' ') : '';
  return <g role={selectable ? editingText ? 'group' : 'button' : undefined} tabIndex={selectable && !editingText ? 0 : undefined}
    aria-label={selectable ? `${objectLabel ? `文字：${objectLabel}` : n.type === 'picture' ? '图片' : '幻灯片对象'}` : undefined}
    onKeyDown={event => { if (selectable && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); onSelect(n.sourceId); } }}
    data-node-type={n.type} data-source-id={n.sourceId} transform={`translate(${b.x},${b.y}) rotate(${b.rotationDeg},${b.w / 2},${b.h / 2}) translate(${b.flipH ? b.w : 0},${b.flipV ? b.h : 0}) scale(${b.flipH ? -1 : 1},${b.flipV ? -1 : 1})`} onClick={event => { if (!n.decoration && onSelect) { event.stopPropagation(); onSelect(n.sourceId); } }}>{selectable && n.type !== 'group' && <rect width={b.w} height={b.h} fill="transparent" pointerEvents="all" />}{drawing}{selectedId === n.sourceId && <rect width={b.w} height={b.h} fill="none" stroke="var(--color-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />}</g>;
}

/** Thin React SVG draw layer over GenOffice's actual pptx-render geometry. */
export function ReactSvgSlide({ slide: payload, label, onSelect, selectedId, ...editing }: { slide: PptxRenderSlide; label: string; onSelect?: (id: string) => void; selectedId?: string } & TextEditingProps) {
  const slide = payload as RenderSlide;
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return <svg viewBox={`0 0 ${slide.widthPx} ${slide.heightPx}`} width="100%" role={onSelect || (editing.textTarget && !editing.readOnly && editing.onTextChange) ? 'group' : 'img'} aria-label={label} style={{ display: 'block', background: 'white', overflow: 'hidden' }}>
    <defs><FillDefs fill={slide.background} id={`${prefix}-background`} /></defs><rect width={slide.widthPx} height={slide.heightPx} fill={fillPaint(slide.background, `${prefix}-background`)} />
    {slide.nodes.map(n => <Node key={n.id} node={n} prefix={prefix} onSelect={onSelect} selectedId={selectedId} {...editing} />)}
  </svg>;
}
