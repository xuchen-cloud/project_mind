import { useId, type ReactNode } from 'react';
import { buildRenderSlide } from '@genoffice/pptx-render';
import type { Slide } from './vendor/packages/pptx-engine/src/types';
import type { RenderSlide, RenderNode, RenderFill, RenderTextLayout, ChartRenderNode } from './vendor/packages/pptx-render/src/render-tree';
import type { PptxModel, PptxEdit, PptxRenderSlide } from './types';

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

function Text({ layout }: { layout?: RenderTextLayout }) {
  if (!layout) return null;
  return <g transform={`translate(${layout.insets.l},${layout.insets.t})`}>
    {layout.lines.flatMap((line, i) => line.runs.map((r, j) => <g key={`${i}-${j}`}>
      {r.highlight && <rect x={r.x} y={r.baselineY - (r.ascentPx ?? r.fontSizePx * .8)} width={r.widthPx} height={r.fontSizePx} fill={r.highlight} />}
      {r.image ? <image href={r.image} x={r.x} y={r.baselineY - (r.ascentPx ?? r.fontSizePx)} width={r.widthPx} height={r.ascentPx ?? r.fontSizePx} /> : <text x={r.x} y={r.baselineY} fill={r.color} fontFamily={`${r.fontFamily}, "Noto Sans SC", "Microsoft YaHei", sans-serif`} fontSize={r.fontSizePx} fontWeight={r.bold ? 700 : 400} fontStyle={r.italic ? 'italic' : undefined} textDecoration={[r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined} letterSpacing={r.letterSpacingPx} direction={r.rtl ? 'rtl' : undefined} style={{ whiteSpace: 'pre' }} transform={r.rotate90 ? `rotate(90 ${r.x} ${r.baselineY})` : r.rotate270 ? `rotate(-90 ${r.x} ${r.baselineY})` : undefined}>{r.text}</text>}
    </g>))}
  </g>;
}

function wedgePath(w: NonNullable<ChartRenderNode['wedges']>[number]) {
  const point = (radius: number, deg: number) => `${w.cx + radius * Math.cos(deg * Math.PI / 180)},${w.cy + radius * Math.sin(deg * Math.PI / 180)}`;
  // Split full-circle wedges into two arcs (SVG A cannot draw a coincident arc).
  const sweep = Math.min(359.9999, w.sweepDeg);
  const end = w.startDeg + sweep;
  return `M${point(w.outerR, w.startDeg)} A${w.outerR},${w.outerR} 0 ${sweep > 180 ? 1 : 0} 1 ${point(w.outerR, end)} ${w.innerR ? `L${point(w.innerR, end)} A${w.innerR},${w.innerR} 0 ${sweep > 180 ? 1 : 0} 0 ${point(w.innerR, w.startDeg)}` : `L${w.cx},${w.cy}`} Z`;
}

function Node({ node: n, prefix, onSelect, selectedId }: { node: RenderNode; prefix: string; onSelect?: (id: string) => void; selectedId?: string }) {
  const b = n.box;
  const id = `${prefix}-${n.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const stroke = 'stroke' in n ? n.stroke : undefined;
  const strokeProps = { stroke: stroke?.color ?? 'none', strokeWidth: stroke?.widthPx, strokeDasharray: stroke?.dash?.join(' '), strokeLinecap: stroke?.cap, strokeLinejoin: stroke?.join };
  let drawing: ReactNode;
  if (n.type === 'group') drawing = n.children.map(child => <Node key={child.id} node={child} prefix={id} onSelect={onSelect} selectedId={selectedId} />);
  else if (n.type === 'text' || n.type === 'shape') {
    const paint = fillPaint(n.fill, `${id}-fill`);
    const shape = n.pathData ? <path d={n.pathData} fill={paint} {...strokeProps} /> : n.polygonPoints ? <polygon points={n.polygonPoints.join(' ')} fill={paint} {...strokeProps} /> : n.presetGeometry === 'ellipse' ? <ellipse cx={b.w / 2} cy={b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={paint} {...strokeProps} /> : !n.line ? <rect width={b.w} height={b.h} rx={n.cornerRadiusPx} fill={paint} {...strokeProps} /> : null;
    drawing = <><defs><FillDefs fill={n.fill} id={`${id}-fill`} /></defs>{shape}{n.fillPathData && <path d={n.fillPathData} fill={paint} />}{n.strokePathData && <path d={n.strokePathData} fill="none" {...strokeProps} />}{n.line && <polyline points={n.line.points.join(' ')} fill="none" {...strokeProps} />}<Text layout={n.text} /></>;
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
  return <g data-node-type={n.type} data-source-id={n.sourceId} transform={`translate(${b.x},${b.y}) rotate(${b.rotationDeg},${b.w / 2},${b.h / 2}) translate(${b.flipH ? b.w : 0},${b.flipV ? b.h : 0}) scale(${b.flipH ? -1 : 1},${b.flipV ? -1 : 1})`} onClick={event => { if (!n.decoration && onSelect) { event.stopPropagation(); onSelect(n.sourceId); } }}>{drawing}{selectedId === n.sourceId && <rect width={b.w} height={b.h} fill="none" stroke="var(--color-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />}</g>;
}

/** Thin React SVG draw layer over GenOffice's actual pptx-render geometry. */
export function ReactSvgSlide({ slide: payload, label, onSelect, selectedId }: { slide: PptxRenderSlide; label: string; onSelect?: (id: string) => void; selectedId?: string }) {
  const slide = payload as RenderSlide;
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return <svg viewBox={`0 0 ${slide.widthPx} ${slide.heightPx}`} width="100%" role="img" aria-label={label} style={{ display: 'block', background: 'white', overflow: 'hidden' }}>
    <defs><FillDefs fill={slide.background} id={`${prefix}-background`} /></defs><rect width={slide.widthPx} height={slide.heightPx} fill={fillPaint(slide.background, `${prefix}-background`)} />
    {slide.nodes.map(n => <Node key={n.id} node={n} prefix={prefix} onSelect={onSelect} selectedId={selectedId} />)}
  </svg>;
}
