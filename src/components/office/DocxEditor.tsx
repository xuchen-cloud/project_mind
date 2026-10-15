import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Undo2, Redo2 } from "lucide-react";
import { ToolbarButton } from "../../ui/components/ToolbarButton";
import "../../../packages/office-docx/dist/editor-document.css";
import "../../../packages/office-docx/dist/editor-shell.css";
import type { DocxModel, Edit } from "../../../packages/office-docx/types";
import type { EditorController, EditorOptions } from "../../../packages/office-docx/editor-types";

export type { DocxModel, DocxModel as Model, Edit, Edit as DocxEdit } from "../../../packages/office-docx/types";
export interface DocxEditorProps {
  model: DocxModel;
  edits: Edit[];
  onChange(edits: Edit[]): void;
  readOnly?: boolean;
}

/** Controlled content editor. File identity, save/CAS and persistence belong to the host. */
export function DocxEditor(props: DocxEditorProps) {
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<EditorController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [edges, setEdges] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const [zoomMode, setZoomMode] = useState<number | "fit">("fit");
  const [zoom, setZoom] = useState(1);
  const [paperHeight, setPaperHeight] = useState(props.model.page.height);
  const readOnly = !!props.readOnly || props.model.readOnly;

  function options(): EditorOptions {
    return { ...latest.current,
      onChange: edits => { setError(null); latest.current.onChange(edits); },
      onError: setError,
    };
  }
  function measure() {
    const node = viewport.current;
    if (!node) return;
    // Transform keeps document layout intact; reserve its displayed height for scrolling.
    if (host.current) setPaperHeight(host.current.offsetHeight);
    if (zoomMode === "fit") {
      const style = getComputedStyle(node);
      const available = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available > 0) setZoom(Math.max(0.5, Math.min(2, available / props.model.page.width)));
    } else setZoom(zoomMode);
    function axis(total: number, visible: number, offset: number) {
      const max = Math.max(0, total - visible);
      const position = Math.max(0, Math.min(max, offset));
      const distance = Math.min(64, max / 2);
      return distance ? [Math.min(1, position / distance), Math.min(1, (max - position) / distance)] : [0, 0];
    }
    const [top, bottom] = axis(node.scrollHeight, node.clientHeight, node.scrollTop);
    const [left, right] = axis(node.scrollWidth, node.clientWidth, node.scrollLeft);
    setEdges(old => old.top === top && old.bottom === bottom && old.left === left && old.right === right
      ? old : { top, bottom, left, right });
  }

  useEffect(() => {
    let active = true;
    // This standalone SDK bundle owns Tiptap 3.31; Record keeps its current SDK.
    import("../../../packages/office-docx/dist/editor.mjs").then(runtime => {
      if (!active || !host.current) return;
      controller.current = runtime.mountEditor(host.current, options());
      setReady(true);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; controller.current?.destroy(); controller.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (!controller.current) return;
    try { controller.current.update(options()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [props.model, props.edits, props.readOnly]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [zoomMode, props.model.page.width]);
  useLayoutEffect(measure, [props.model, props.edits, ready, zoom, paperHeight]);

  const { page } = props.model;
  const paperStyle = {
    "--office-doc-zoom": zoom,
    "--office-doc-scaled-height": `${paperHeight * zoom}px`,
    "--office-doc-page-width": `${page.width}px`, "--office-doc-page-height": `${page.height}px`,
    "--office-doc-padding-top": `${page.margins.top}px`, "--office-doc-padding-right": `${page.margins.right}px`,
    "--office-doc-padding-bottom": `${page.margins.bottom}px`, "--office-doc-padding-left": `${page.margins.left}px`,
    "--office-doc-font-size": page.fontSizePt ? `${page.fontSizePt}pt` : "11pt",
    "--office-doc-font": page.fontFamily ? `${JSON.stringify(page.fontFamily)}, var(--font-ui)` : "var(--font-ui)",
    "--doc-east-asian-font": page.eastAsianFontFamily ? `${JSON.stringify(page.eastAsianFontFamily)}, var(--font-ui)` : "var(--font-ui)",
  } as CSSProperties;
  return <section className="office-docx" aria-label="Word 文档编辑器" aria-busy={!ready && !error}>
    <div className="office-docx__toolbar" role="toolbar" aria-label="Word 编辑操作">
      <ToolbarButton type="button" title="撤销" aria-label="撤销" disabled={readOnly || !ready} onClick={() => controller.current?.undo()}><Undo2 size={15} /></ToolbarButton>
      <ToolbarButton type="button" title="重做" aria-label="重做" disabled={readOnly || !ready} onClick={() => controller.current?.redo()}><Redo2 size={15} /></ToolbarButton>
      <span className="office-docx__separator" aria-hidden="true" />
      <span className="office-docx__scope" title="可编辑已有段落和表格文字，复杂内容保持原样">{readOnly ? "只读" : "内容编辑"}</span>
      <div className="office-docx__zoom">
        <select aria-label="Word 缩放" value={zoomMode} onChange={event => setZoomMode(event.target.value === "fit" ? "fit" : Number(event.target.value))}>
          <option value="fit">适合宽度</option>
          {[50, 75, 100, 125, 150, 175, 200].map(value => <option key={value} value={value / 100}>{value}%</option>)}
        </select>
        <output aria-label="Word 缩放百分比">{Math.round(zoom * 100)}%</output>
      </div>
    </div>
    {error && <p className="office-docx__error" role="alert">{error}</p>}
    {!ready && !error && <p role="status">正在加载文档…</p>}
    <div className="office-docx__frame" data-overflow-top={edges.top > 0 || undefined} data-overflow-bottom={edges.bottom > 0 || undefined} data-overflow-left={edges.left > 0 || undefined} data-overflow-right={edges.right > 0 || undefined}>
      <div ref={viewport} className="office-docx__viewport" onScroll={measure}>
        <div className="office-docx__stage" style={paperStyle}>
          <div ref={host} className="office-docx__paper" />
        </div>
      </div>
      <div className="office-docx__edge office-docx__edge--top" aria-hidden="true" style={{ opacity: edges.top }} />
      <div className="office-docx__edge office-docx__edge--bottom" aria-hidden="true" style={{ opacity: edges.bottom }} />
      <div className="office-docx__edge office-docx__edge--left" aria-hidden="true" style={{ opacity: edges.left }} />
      <div className="office-docx__edge office-docx__edge--right" aria-hidden="true" style={{ opacity: edges.right }} />
    </div>
  </section>;
}
