/** Standalone diagnostic initialization script for Issue #191 / #118.
 * Inject BEFORE the frozen native-page module. No imports, UI changes, calc or
 * readiness/status overrides. A second tracer records exact segment semantics;
 * it does not modify the frozen tracer's verdict. Diagnostic runs add overhead.
 * Final report receives canvasTraceDiagnostic; native-page remains authoritative.
 */
(() => {
'use strict';
if(window.__OFFICE_CANVAS_DIAGNOSTICS__) return;
const frames=[], installed=new WeakSet();
function emit(owner,event) {
  owner.events.push(event); if(owner.events.length>500)owner.events.shift();
  if(JSON.stringify(event).includes('PERF_')) { owner.witnessEvents.push(event); if(owner.witnessEvents.length>120)owner.witnessEvents.shift(); }
}
const sheetCanvases = new WeakMap();
let canvasSequence = 0;
function overlap(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}
function containsBox(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function transformedBox(context, x, y, width, height) {
    const m = context.getTransform();
    if (m.b !== 0 || m.c !== 0 || ![x, y, width, height, m.a, m.d, m.e, m.f].every(Number.isFinite))
        return null;
    const x1 = m.a * x + m.e, x2 = m.a * (x + width) + m.e, y1 = m.d * y + m.f, y2 = m.d * (y + height) + m.f;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
function observeSheetCanvas(target, owner) {
    const realm = target;
    const prototype = realm.CanvasRenderingContext2D.prototype;
    const record = (context) => {
        const canvas = context.canvas;
        let value = sheetCanvases.get(canvas);
        if (!value || value.width !== canvas.width || value.height !== canvas.height) {
            value = { owner, id: ++canvasSequence, width: canvas.width, height: canvas.height, marks: [],
                clip: { x: 0, y: 0, width: canvas.width, height: canvas.height }, stack: [], path: null, rectangularPath: false, segments: [], currentPoint: null, subpathStart: null };
            sheetCanvases.set(canvas, value);
            owner.canvases.add(canvas);
        }
        return value;
    };
    // Setting the same width/height also clears pixels and context state.
    for (const property of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(realm.HTMLCanvasElement.prototype, property);
        Object.defineProperty(realm.HTMLCanvasElement.prototype, property, { ...descriptor,
            set(value) { descriptor.set.call(this, value); sheetCanvases.delete(this); } });
    }
    const wrap = (name, after) => {
        const original = prototype[name];
        prototype[name] = function (...args) {
            const value = record(this);
            const before = value.marks.slice(), beforeClip = value.clip;
            const result = original.apply(this, args);
            after(this, args, value);
            const current = sheetCanvases.get(this.canvas);
            const removed = before.filter(mark => !current?.marks.includes(mark));
            const added = current?.marks.filter(mark => !before.includes(mark)) ?? [];
            if (removed.length || added.length || ['clip', 'drawImage', 'fillText', 'stroke', 'strokeRect'].includes(name)) {
                emit(owner, { method: name, canvas: value.id, domId: this.canvas.id, at: performance.now(),
                    args: args.map(arg => typeof arg === 'object' ? { kind: Object.prototype.toString.call(arg), id: arg?.id, width: arg?.width, height: arg?.height } : String(arg).slice(0, 180)),
                    removed: removed.map(mark => ({ text: mark.text, box: mark.box })), added: added.map(mark => ({ text: mark.text, box: mark.box, chain: mark.chain.length })),
                    beforeClip, clip: current?.clip, rectangularPath: value.rectangularPath, path: value.path,
                    segments: value.segments?.slice(0, 16), knownSegments: value.segments !== null,
                    transform: this.getTransform().toJSON(), alpha: this.globalAlpha, composite: this.globalCompositeOperation, filter: this.filter,
                    lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin, fillStyle: String(this.fillStyle),
                    beforeMarks: before.length, afterMarks: current?.marks.length ?? 0 });
            }
            return result;
        };
    };
    const invalidate = (value, box) => {
        value.marks = box ? value.marks.filter(mark => !overlap(mark.box, box)) : [];
    };
    const canProve = (context, value, box) => (() => {
        const reason = !box ? 'unsupported transform/text metrics' : !box.width || !box.height ? 'empty text bounds'
            : !value.clip ? 'unknown or empty clip' : !containsBox(value.clip, box) ? 'text/destination not fully inside clip'
                : context.globalAlpha !== 1 ? 'nonopaque global alpha' : !['source-over', 'copy'].includes(context.globalCompositeOperation) ? 'unsupported composite'
                    : context.filter !== undefined && context.filter !== 'none' ? 'filtered draw' : null;
        if (reason) {
            owner.rejections[reason] = (owner.rejections[reason] ?? 0) + 1;
            emit(owner, { method: 'proof-rejected', reason, canvas: value.id, box, clip: value.clip, at: performance.now() });
        }
        return reason === null;
    })();
    wrap('save', (_context, _args, value) => { value.stack.push(value.clip); });
    wrap('restore', (_context, _args, value) => { if (value.stack.length)
        value.clip = value.stack.pop(); });
    const point = (context, x, y) => {
        const box = transformedBox(context, x, y, 0, 0);
        return box && { x: box.x, y: box.y };
    };
    const addSegment = (value, from, to) => {
        if (!from || !to || (from.x !== to.x && from.y !== to.y)) {
            value.segments = null;
            return;
        }
        value.segments?.push({ from, to });
    };
    const rectSegments = (context, args) => {
        const [x, y, w, h] = args;
        const points = [point(context, x, y), point(context, x + w, y), point(context, x + w, y + h), point(context, x, y + h)];
        return points.every(Boolean) ? points.map((from, index) => ({ from: from, to: points[(index + 1) % 4] })) : null;
    };
    wrap('beginPath', (_context, _args, value) => {
        value.path = null;
        value.rectangularPath = true;
        value.segments = [];
        value.currentPoint = value.subpathStart = null;
    });
    wrap('rect', (context, args, value) => {
        const edges = rectSegments(context, args);
        if (!edges)
            value.segments = null;
        else
            value.segments?.push(...edges);
        value.currentPoint = value.subpathStart = edges?.[0].from ?? null;
        if (value.path) {
            value.rectangularPath = false;
            value.path = null;
            return;
        }
        value.path = transformedBox(context, args[0], args[1], args[2], args[3]);
    });
    for (const method of ['moveTo', 'lineTo'])
        wrap(method, (context, args, value) => {
            const target = point(context, args[0], args[1]);
            if (method === 'lineTo' && value.currentPoint)
                addSegment(value, value.currentPoint, target);
            else
                value.subpathStart = target;
            value.currentPoint = target;
            if (!value.rectangularPath && !value.path)
                return;
            value.rectangularPath = false;
            if (!target) {
                value.path = null;
                return;
            }
            const previous = value.path;
            value.path = previous ? { x: Math.min(previous.x, target.x), y: Math.min(previous.y, target.y),
                width: Math.max(previous.x + previous.width, target.x) - Math.min(previous.x, target.x),
                height: Math.max(previous.y + previous.height, target.y) - Math.min(previous.y, target.y) } : { ...target, width: 0, height: 0 };
        });
    wrap('closePath', (_context, _args, value) => {
        if (value.currentPoint && value.subpathStart)
            addSegment(value, value.currentPoint, value.subpathStart);
        value.currentPoint = value.subpathStart;
    });
    for (const method of ['arc', 'arcTo', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo', 'roundRect']) {
        if (prototype[method])
            wrap(method, (_context, _args, value) => {
                value.rectangularPath = false;
                value.path = null;
                value.segments = null;
                value.currentPoint = value.subpathStart = null;
            });
    }
    wrap('clip', (_context, args, value) => {
        const known = args.length === 0 || typeof args[0] === 'string';
        value.clip = known && value.rectangularPath && value.path && value.clip ? overlap(value.clip, value.path) : null;
    });
    for (const method of ['clearRect', 'fillRect'])
        wrap(method, (context, args, value) => {
            invalidate(value, context.globalCompositeOperation === 'source-over' || method === 'clearRect' ? transformedBox(context, args[0], args[1], args[2], args[3]) : null);
        });
    wrap('fill', (context, args, value) => { invalidate(value, context.globalCompositeOperation === 'source-over' && typeof args[0] !== 'object' ? value.path : null); });
    // Univer's grid/border primitives are independent axis-aligned segments.
    // Stroke paints their edges, never the rectangular area enclosed by them.
    // Half-width expansion covers caps and 90-degree joins (including miter)
    // under axis-aligned transforms. Curves, diagonals and Path2D stay unknown.
    const invalidateStroke = (context, value, segments) => {
        const m = context.getTransform();
        if (!segments || m.b !== 0 || m.c !== 0 || context.globalCompositeOperation !== 'source-over') {
            value.marks = [];
            return;
        }
        const pad = context.lineWidth / 2 * Math.max(Math.abs(m.a), Math.abs(m.d));
        for (const { from, to } of segments) {
            if (from.x === to.x && from.y === to.y && context.lineCap !== 'round')
                continue;
            invalidate(value, { x: Math.min(from.x, to.x) - pad, y: Math.min(from.y, to.y) - pad,
                width: Math.abs(to.x - from.x) + pad * 2, height: Math.abs(to.y - from.y) + pad * 2 });
        }
    };
    wrap('stroke', (context, args, value) => { invalidateStroke(context, value, typeof args[0] === 'object' ? null : value.segments); });
    wrap('strokeRect', (context, args, value) => { invalidateStroke(context, value, rectSegments(context, args)); });
    wrap('strokeText', (_context, _args, value) => { value.marks = []; });
    wrap('putImageData', (_context, _args, value) => { value.marks = []; });
    if (prototype.reset)
        wrap('reset', (context) => { sheetCanvases.delete(context.canvas); });
    wrap('fillText', (context, args, value) => {
        if (!['source-over', 'copy'].includes(context.globalCompositeOperation))
            value.marks = [];
        const text = String(args[0]);
        if (owner.painted.length < 2000)
            owner.painted.push(text);
        const metrics = context.measureText(text), x = args[1], y = args[2];
        const naturalWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
        const scale = args[3] === undefined ? 1 : Math.min(1, args[3] / metrics.width);
        const box = transformedBox(context, x - metrics.actualBoundingBoxLeft * scale, y - metrics.actualBoundingBoxAscent, naturalWidth * scale, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
        const style = context.fillStyle;
        if (context.globalCompositeOperation === 'copy')
            value.marks = [];
        else
            invalidate(value, box);
        if (typeof style !== 'string' || /^(transparent|white|#fff|#ffffff|rgba\([^)]*,\s*0\))$/i.test(style) || !canProve(context, value, box))
            return;
        if (value.marks.length < 2048)
            value.marks.push({ text, box, origin: value.id, chain: [] });
    });
    wrap('drawImage', (context, args, value) => {
        const source = args[0], from = source && sheetCanvases.get(source);
        // Copy marks before invalidating to handle the renderer's self-cache scroll.
        const sourceMarks = from?.marks.slice() ?? [];
        const sourceWidth = source?.width, sourceHeight = source?.height;
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 9 ? args.slice(1)
            : [0, 0, sourceWidth, sourceHeight, args[1], args[2], args.length === 5 ? args[3] : sourceWidth, args.length === 5 ? args[4] : sourceHeight];
        const destination = transformedBox(context, dx, dy, dw, dh);
        if (context.globalCompositeOperation !== 'source-over')
            value.marks = [];
        else
            invalidate(value, destination);
        if (!from || from.owner !== owner || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 || !destination)
            return;
        const sourceBox = { x: sx, y: sy, width: sw, height: sh };
        for (const mark of sourceMarks) {
            if (!containsBox(sourceBox, mark.box) || mark.chain.length >= 8)
                continue;
            const box = transformedBox(context, dx + (mark.box.x - sx) * dw / sw, dy + (mark.box.y - sy) * dh / sh, mark.box.width * dw / sw, mark.box.height * dh / sh);
            if (!canProve(context, value, box))
                continue;
            if (value.marks.length < 2048)
                value.marks.push({ ...mark, box, chain: [...mark.chain, { at: performance.now(),
                            from: from.id, to: value.id, source: sourceBox, destination, textDestination: box, clip: value.clip,
                            transform: context.getTransform().toJSON(), canvasSize: [value.width, value.height] }] });
        }
    });
}
function sheetComposition(canvas, witness) {
    const record = sheetCanvases.get(canvas);
    if (!record || !witness || !visible(canvas) || canvas.width !== record.width || canvas.height !== record.height)
        return;
    const bounds = canvas.getBoundingClientRect(), doc = canvas.ownerDocument;
    const viewport = { x: 0, y: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const mark = record.marks.find(item => item.text.includes(witness) && item.chain.length > 0 && item.origin !== record.id && containsBox({ x: 0, y: 0, width: canvas.width, height: canvas.height }, item.box) && overlap(viewport, {
        x: bounds.x + item.box.x * bounds.width / canvas.width, y: bounds.y + item.box.y * bounds.height / canvas.height,
        width: item.box.width * bounds.width / canvas.width, height: item.box.height * bounds.height / canvas.height,
    }));
    if (!mark)
        return;
    const screenBox = { x: bounds.x + mark.box.x * bounds.width / canvas.width, y: bounds.y + mark.box.y * bounds.height / canvas.height,
        width: mark.box.width * bounds.width / canvas.width, height: mark.box.height * bounds.height / canvas.height };
    return { witness, text: mark.text, origin: mark.origin, mainCanvas: record.id, canvasSize: [canvas.width, canvas.height],
        mainRect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, screenBox,
        viewportIntersection: overlap(viewport, screenBox), chain: mark.chain };
}
function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < element.ownerDocument.documentElement.clientHeight && rect.left < element.ownerDocument.documentElement.clientWidth && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !element.closest('[hidden]');
}

function install(target, frame) {
  if(installed.has(target))return;
  const owner={painted:[],pixelChecks:[],canvases:new Set(),events:[],witnessEvents:[],rejections:{}};
  const item={target,frame,owner}; frames.push(item); installed.add(target);
  try { observeSheetCanvas(target,owner); }
  catch(error) { item.installError=String(error?.stack??error); }
}
function snapshot(witness) {
  return {version:1,observer:'segment-aware diagnostic only; does not change verdict',at:performance.now(),frames:frames.map(({frame,owner,installError})=>({
    title:frame?.title, connected:frame?.isConnected, installError, rejections:owner.rejections,
    witness,paintedText:owner.painted.slice(0,100),
    canvases:[...owner.canvases].slice(-64).map(canvas=>{
      const record=sheetCanvases.get(canvas);
      return {id:canvas.id,canvas:record?.id,size:[canvas.width,canvas.height],connected:canvas.isConnected,
        clip:record?.clip,marks:record?.marks.length,
        witnessMarks:record?.marks.filter(mark=>witness?mark.text.includes(witness):mark.text.includes('PERF_')).slice(0,12),
        strictComposition:canvas.id?.startsWith('univer-sheet-main-canvas')?sheetComposition(canvas,witness):undefined};
    }), witnessEvents:owner.witnessEvents,events:owner.events
  }))};
}
window.__OFFICE_CANVAS_DIAGNOSTICS__={install,snapshot};
window.addEventListener('message',event=>{
  if(event.data?.officeXlsx!==true||event.data.type!=='bootstrap')return;
  const frame=[...document.querySelectorAll('iframe')].find(node=>node.contentWindow===event.source);
  if(frame?.contentWindow)install(frame.contentWindow,frame);
},true);
const originalFetch=window.fetch;
window.fetch=function(input,init){
  if(input===window.__OFFICE_PERFORMANCE__?.reportUrl && init?.method==='POST' && typeof init.body==='string') {
    try {
      const body=JSON.parse(init.body);
      if(body.kind!=='checkpoint'){
        const witness=body.diagnostics?.sheetCheck?.witness??body.measurements?.at(-1)?.diagnostics?.sheetCheck?.witness
          ??body.measurements?.find(item=>item.evidence?.witness)?.evidence?.witness;
        body.canvasTraceDiagnostic=snapshot(witness);
        init={...init,body:JSON.stringify(body)};
      }
    } catch(error) { console.error('office-performance:canvas_observer_failed',error); }
  }
  return originalFetch.call(this,input,init);
};
})();
