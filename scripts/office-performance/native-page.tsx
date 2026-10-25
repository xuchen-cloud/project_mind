/** Native ProjectFileContent benchmark. Issue: #191 (parent #118), delegated native performance package.
 * Depends on the opt-in Tauri host and runner-owned fixtures. Measures this shell,
 * not full application startup. No mock IO, editor preloading or screenshots. Optional acceptance edits isolated fixtures.
 * Acceptance: real content + renderer readiness + stable painted viewport; 1s budget.
 * Verification here is static only; the native runner owns execution/visual evidence.
 */
import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ProjectFileContent } from '../../src/components/document/ProjectFileContent';
import { createProjectMindQueryClient } from '../../src/lib/queryClient';
import { desktopApi } from '../../src/services/desktopApi';
import { projectMindApi } from '../../src/services/projectMindApi';
import { projectFileApi } from '../../src/services/projectFileApi';
import { recordDocumentApi } from '../../src/services/recordDocumentApi';
import { officeFileApi } from '../../src/services/officeFileApi';
import { fileDocumentApi } from '../../src/services/fileDocumentApi';
import { officePreviewCache } from '../../src/lib/office-preview-cache';
import { NativeRaceObserver, runPendingFileRace } from './native-races';
import { runNativeHistoryAcceptance } from './native-history';
import type { AgentSourceRef } from '../../src/lib/agent-types';
import type { AgentWorkspaceBinding } from '../../src/lib/agent-types';
import type { ProjectFileView } from '../../src/components/document/ProjectFileContent';
import type { ProjectDirectoryFile, ProjectDirectoryScanResult } from '../../src/lib/file-types';
import type { OfficeModel } from '../../src/lib/office-types';
import { format as formatNumber } from '../../packages/office-xlsx/node_modules/numfmt';
import type { PptxRenderSlide } from '../../packages/office-pptx/types';
import type { Model as XlsxModel } from '../../packages/office-xlsx/types';
import '@fontsource/work-sans/400.css';
import '@fontsource/work-sans/500.css';
import '@fontsource/work-sans/600.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '../../src/styles/app.css';

type Format = 'docx' | 'pptx' | 'xlsx' | 'md';
type Sample = 'simple' | 'complex' | 'large';
interface Config {
  workspaceRoot: string; reportUrl: string; format: Format; sample: Sample;
  run: number; width?: number; setup?: boolean; acceptance?: boolean; cycles?: number; controls?: boolean; races?: boolean;
}
type DisplayMode = 'preview' | 'edit' | 'rich' | 'source';
interface DebugOperations {
  open(sample: Sample): Promise<unknown>; close(): Promise<void>; setMode(mode: DisplayMode): Promise<unknown>; getState(): Record<string, unknown>;
}
declare global { interface Window { __OFFICE_PERFORMANCE__: Config; officePerformance: DebugOperations } }
// The multi-entry measurement bundle can share dependencies with the full App.
// Only native.html owns this diagnostic root and the command/canvas observers.
function installNativePage() {
const config = window.__OFFICE_PERFORMANCE__;
const raceObserver = config.races ? new NativeRaceObserver() : undefined;
const rootElement = document.getElementById('root')!;
const root = createRoot(rootElement);
const queryClient = createProjectMindQueryClient();
const commands: { api: string; name: string; startTime: number; duration?: number; error?: string }[] = [];
const errors: string[] = [];
const models = new Map<string, OfficeModel>();
const textSources = new Map<string, string>();
const sourceRefs = new Map<string, AgentSourceRef | null>();
const measurements: Record<string, unknown>[] = [];
interface Commit { fileId: string; command: string; receipt: { versionNumber: number; contentHash: string; noChange: boolean }; time: number }
const commits: Commit[] = [];
const fileViews = new Map<string, ProjectFileView>();
let projectContext: { projectId: number; binding: AgentWorkspaceBinding } | undefined;
let displayedFile: ProjectDirectoryFile | null = null;
let harnessRunning = true, debugBusy = false;
const controlStatus = document.getElementById('native-control-status');
let activeMeasurement: { name: string; fileId: string; fileName: string; source: boolean; editing: boolean; expiresAt: number; expired: boolean } | undefined;
let waitStage = 'shell';
let lastSheetCheck: Record<string, unknown> = {};
let lastTimeout: Record<string, unknown> | undefined;
const shellReady = performance.now();
const scope = 'native ProjectFileContent shell (not full application startup)';
function runErrors(): string[] {
  // A retained acceptance failure must affect reporting without poisoning the
  // runtime-error gate used by later, independently reset acceptance checks.
  return [...new Set([...errors, ...measurements.filter(item => item.status === 'error')
    .map(item => typeof item.error === 'string' ? item.error : `Measurement ${item.name} failed`)])];
}
function reportStatus(): 'error' | 'over_budget' | 'passed' {
  return runErrors().length ? 'error' : measurements.some(item => item.status === 'over_budget') ? 'over_budget' : 'passed';
}
const reportBase = () => ({ scope, config, visibility: document.visibilityState, lastTimeout, shell_ready: { startTime: shellReady, navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()) }, commands, errors: runErrors(), measurements, commits });
console.info('office-performance:shell_ready', JSON.stringify(reportBase().shell_ready));
performance.setResourceTimingBufferSize(10000);

function errorMessage(error: unknown): string {
  // Error and DOMException from child windows fail this realm's instanceof.
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof value.name === 'string' || typeof value.message === 'string') {
      const detail = `${typeof value.name === 'string' ? value.name : 'Error'}: ${typeof value.message === 'string' ? value.message : ''}`;
      return typeof value.stack === 'string' ? `${detail}\n${value.stack}` : detail;
    }
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
// Preserve both fulfilled values and native rejection objects. Observe inspect's existing
// result to check source-specific content without introducing an extra native read.
for (const api of ['command', 'fileCommand'] as const) {
  const original = desktopApi[api].bind(desktopApi);
  desktopApi[api] = (async (name: string, payload?: Record<string, unknown>) => {
    const record = { api, name, startTime: performance.now() } as typeof commands[number];
    commands.push(record);
    const raceToken = raceObserver?.commandStarted(name, payload) ?? null;
    try {
      const result = await original(name, payload!);
      const response = result as { ok?: boolean; data?: { model?: OfficeModel; text?: string; startChar?: number; receipt?: Commit["receipt"]; commit?: { receipt: Commit["receipt"] } }; error?: unknown };
      if (response?.ok === false) record.error = errorMessage(response.error);
      const model = response?.data?.model;
      const input = payload?.input as { data?: { object?: { id: string }; text?: string } } | undefined;
      if (['file_office_inspect', 'file_office_save'].includes(name) && model && input?.data?.object) models.set(input.data.object.id, model);
      if (name === 'file_source_read' && input?.data?.object && response.data?.startChar === 0 && typeof response.data.text === 'string') textSources.set(input.data.object.id, response.data.text);
      if (response?.ok === true && input?.data?.object && ['file_office_save', 'file_text_save'].includes(name)) {
        const receipt = response.data?.commit?.receipt ?? response.data?.receipt;
        if (receipt) commits.push({ fileId: input.data.object.id, command: name, receipt, time: performance.now() });
        if (name === 'file_text_save' && typeof input.data.text === 'string') textSources.set(input.data.object.id, input.data.text);
      }
      return result;
    } catch (error) { record.error = errorMessage(error); throw error; }
    finally { record.duration = performance.now() - record.startTime; raceObserver?.commandSettled(raceToken, record.error ?? null); }
  }) as typeof desktopApi[typeof api];
}
window.addEventListener('error', event => errors.push(event.error ? errorMessage(event.error) : event.message));
window.addEventListener('unhandledrejection', event => errors.push(errorMessage(event.reason)));

// Capture the real XLSX runtime before its first attach. The bootstrap message is
// emitted before parent sends init, so this observes the existing production host.
// These opaque renderer objects intentionally stay inside this diagnostic entry.
interface SheetObservation {
  installed: boolean; hostInstalled: boolean; runtime?: any; context?: any; painted: string[]; witness?: string;
  pixelChecks: Record<string, unknown>[]; compositionEvents?: Record<string, unknown>[]; invalidationEvents?: Record<string, unknown>[];
  calculation: { started: number; ended: number; applied: number; pending: boolean; events: Record<string, unknown>[] };
}
// Pixel reads can be blocked after real image content taints a sheet canvas.
// Keep a separate geometric proof of text actually composited into the main
// canvas. Cache-only text never satisfies this proof. Unknown clips/transforms
// deliberately produce no proof rather than claiming a successful paint.
type PaintPoint = { x: number; y: number };
type PaintSegment = { from: PaintPoint; to: PaintPoint };
type PaintBox = { x: number; y: number; width: number; height: number };
interface TextPaint { text: string; box: PaintBox; origin: number; chain: Record<string, unknown>[] }
interface SheetCanvas {
  owner: SheetObservation; id: number; width: number; height: number; marks: TextPaint[]; coverage: PaintBox[] | null; coverageReason?: string;
  segments: PaintSegment[] | null; currentPoint: PaintPoint | null; subpathStart: PaintPoint | null;
  clip: PaintBox | null; stack: (PaintBox | null)[]; path: PaintBox | null; rectangularPath: boolean;
}
const sheetCanvases = new WeakMap<object, SheetCanvas>();
let canvasSequence = 0;
function overlap(a: PaintBox, b: PaintBox): PaintBox | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
function containsBox(outer: PaintBox, inner: PaintBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function transformedBox(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): PaintBox | null {
  const m = context.getTransform();
  if (m.b !== 0 || m.c !== 0 || ![x, y, width, height, m.a, m.d, m.e, m.f].every(Number.isFinite)) return null;
  const x1 = m.a * x + m.e, x2 = m.a * (x + width) + m.e, y1 = m.d * y + m.f, y2 = m.d * (y + height) + m.f;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
function observeSheetCanvas(target: Window, owner: SheetObservation) {
  const realm = target as any;
  const prototype = realm.CanvasRenderingContext2D.prototype;
  const blank = (canvas: HTMLCanvasElement): SheetCanvas => ({ owner, id: ++canvasSequence,
    width: canvas.width, height: canvas.height, marks: [], coverage: [],
    clip: { x: 0, y: 0, width: canvas.width, height: canvas.height }, stack: [], path: null,
    rectangularPath: false, segments: [], currentPoint: null, subpathStart: null });
  const record = (context: CanvasRenderingContext2D) => {
    const canvas = context.canvas;
    let value = sheetCanvases.get(canvas);
    if (!value || value.width !== canvas.width || value.height !== canvas.height) {
      value = blank(canvas); sheetCanvases.set(canvas, value);
    }
    return value;
  };
  // Diagnostics only: retain the operation that actually removes main-canvas
  // evidence, including context resets that replace the tracked record.
  const lossSnapshot = (canvas: HTMLCanvasElement, value: SheetCanvas | undefined) =>
    canvas.id.startsWith('univer-sheet-main-canvas') && value?.marks.length
      ? { id: value.id, marks: value.marks.slice(), size: [value.width, value.height] } : undefined;
  const logLoss = (canvas: HTMLCanvasElement, before: ReturnType<typeof lossSnapshot>, method: string,
    args: unknown[], state: Record<string, unknown> = {}) => {
    if (!before) return;
    const after = sheetCanvases.get(canvas);
    const removed = before.marks.filter(mark => !after?.marks.includes(mark));
    if (!removed.length) return;
    const events = owner.invalidationEvents ??= [];
    events.push({ at: performance.now(), method, args, ...state, canvasId: canvas.id,
      from: before.id, to: after?.id, before: before.marks.length, after: after?.marks.length ?? 0,
      removed: removed.slice(0, 24).map(mark => ({ text: mark.text, box: mark.box, origin: mark.origin })),
      sizeBefore: before.size, sizeAfter: [canvas.width, canvas.height],
      clip: after?.clip, coverageReason: after?.coverageReason });
    if (events.length > 12) events.shift();
  };
  const describeArg = (arg: unknown): unknown => {
    if (arg === null || ['number', 'boolean'].includes(typeof arg)) return arg;
    if (typeof arg === 'string') return arg.slice(0, 160);
    return { type: typeof arg }; // Never retain image, Path2D or ImageData objects.
  };
  // Setting the same width/height also clears pixels and context state.
  for (const property of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(realm.HTMLCanvasElement.prototype, property)!;
    Object.defineProperty(realm.HTMLCanvasElement.prototype, property, { ...descriptor,
      set(this: HTMLCanvasElement, value: number) {
        const before = lossSnapshot(this, sheetCanvases.get(this));
        descriptor.set!.call(this, value); sheetCanvases.set(this, blank(this));
        logLoss(this, before, `set:${property}`, [describeArg(value)]);
      } });
  }
  const wrap = (name: string, after: (context: CanvasRenderingContext2D, args: any[], canvas: SheetCanvas) => void) => {
    const original = prototype[name];
    prototype[name] = function (this: CanvasRenderingContext2D, ...args: any[]) {
      const value = record(this);
      const before = lossSnapshot(this.canvas, value);
      const state = before ? { composite: this.globalCompositeOperation, alpha: this.globalAlpha,
        fillStyle: describeArg(this.fillStyle), strokeStyle: describeArg(this.strokeStyle), filter: this.filter,
        lineWidth: this.lineWidth, lineCap: this.lineCap, shadow: [this.shadowBlur, this.shadowOffsetX, this.shadowOffsetY],
        transform: this.getTransform().toJSON(), clipBefore: value.clip } : undefined;
      const result = original.apply(this, args);
      after(this, args, value);
      logLoss(this.canvas, before, name, (name === 'drawImage' ? args.slice(1) : args).map(describeArg), state);
      return result;
    };
  };
  const invalidate = (value: SheetCanvas, box: PaintBox | null) => {
    value.marks = box ? value.marks.filter(mark => !overlap(mark.box, box)) : [];
  };
  // Coverage is an upper bound on nontransparent source pixels, distinct
  // from positive text proof. Unknown coverage never implies transparency.
  const addCoverage = (context: CanvasRenderingContext2D, value: SheetCanvas, box: PaintBox | null) => {
    if (context.globalCompositeOperation !== 'source-over' || !box ||
        (context.filter !== undefined && context.filter !== 'none') || context.shadowBlur > 0 || context.shadowOffsetX || context.shadowOffsetY) {
      value.coverage = null; value.coverageReason = `paint: box=${JSON.stringify(box)} composite=${context.globalCompositeOperation} filter=${context.filter} shadow=${context.shadowBlur}/${context.shadowOffsetX}/${context.shadowOffsetY}`; return;
    }
    if (context.globalAlpha === 0 || value.coverage === null) return;
    let clipped = overlap(box, { x: 0, y: 0, width: value.width, height: value.height });
    if (clipped && value.clip) clipped = overlap(clipped, value.clip);
    if (!clipped || value.coverage.some(existing => containsBox(existing, clipped!))) return;
    value.coverage = value.coverage.filter(existing => !containsBox(clipped!, existing));
    if (value.coverage.length >= 2048) value.coverage = null;
    else value.coverage.push(clipped);
  };
  const paint = (context: CanvasRenderingContext2D, value: SheetCanvas, box: PaintBox | null) => {
    const affected = box && value.clip ? overlap(box, value.clip) : box;
    const unknownSpread = (context.filter !== undefined && context.filter !== 'none') || context.shadowBlur > 0 || !!context.shadowOffsetX || !!context.shadowOffsetY;
    if (unknownSpread) invalidate(value, null);
    else if (affected || !box || context.globalCompositeOperation !== 'source-over') invalidate(value, context.globalCompositeOperation === 'source-over' ? affected : null);
    addCoverage(context, value, box);
  };
  const clearCoverage = (value: SheetCanvas, box: PaintBox | null) => {
    // A full real clear under a known full clip recovers known transparency.
    const bounds = { x: 0, y: 0, width: value.width, height: value.height };
    if (box && value.clip && containsBox(box, bounds) && containsBox(value.clip, bounds)) { value.coverage = []; value.coverageReason = undefined; return; }
    if (!box || !value.clip || value.coverage === null) return;
    const cleared = overlap(box, value.clip);
    if (!cleared) return;
    value.coverage = value.coverage.flatMap(existing => {
      const cut = overlap(existing, cleared);
      if (!cut) return [existing];
      return [
        { x: existing.x, y: existing.y, width: existing.width, height: cut.y - existing.y },
        { x: existing.x, y: cut.y + cut.height, width: existing.width, height: existing.y + existing.height - cut.y - cut.height },
        { x: existing.x, y: cut.y, width: cut.x - existing.x, height: cut.height },
        { x: cut.x + cut.width, y: cut.y, width: existing.x + existing.width - cut.x - cut.width, height: cut.height },
      ].filter(part => part.width > 0 && part.height > 0);
    });
    if (value.coverage.length > 2048) value.coverage = null;
  };
  const canProve = (context: CanvasRenderingContext2D, value: SheetCanvas, box: PaintBox | null): box is PaintBox =>
    !!box && box.width > 0 && box.height > 0 && !!value.clip && containsBox(value.clip, box) &&
    context.globalAlpha === 1 && ['source-over', 'copy'].includes(context.globalCompositeOperation) && (context.filter === undefined || context.filter === 'none');
  wrap('save', (_context, _args, value) => { value.stack.push(value.clip); });
  wrap('restore', (_context, _args, value) => { if (value.stack.length) value.clip = value.stack.pop()!; });
  const point = (context: CanvasRenderingContext2D, x: number, y: number): PaintPoint | null => {
    const box = transformedBox(context, x, y, 0, 0); return box && { x: box.x, y: box.y };
  };
  const addSegment = (value: SheetCanvas, from: PaintPoint | null, to: PaintPoint | null) => {
    if (!from || !to || (from.x !== to.x && from.y !== to.y)) { value.segments = null; return; }
    value.segments?.push({ from, to });
  };
  const rectSegments = (context: CanvasRenderingContext2D, args: number[]): PaintSegment[] | null => {
    const [x, y, w, h] = args;
    const points = [point(context, x, y), point(context, x + w, y), point(context, x + w, y + h), point(context, x, y + h)];
    return points.every(Boolean) ? points.map((from, index) => ({ from: from!, to: points[(index + 1) % 4]! })) : null;
  };
  wrap('beginPath', (_context, _args, value) => {
    value.path = null; value.rectangularPath = true; value.segments = []; value.currentPoint = value.subpathStart = null;
  });
  wrap('rect', (context, args, value) => {
    const edges = rectSegments(context, args);
    if (!edges) value.segments = null; else value.segments?.push(...edges);
    value.currentPoint = value.subpathStart = edges?.[0].from ?? null;
    if (value.path) { value.rectangularPath = false; value.path = null; return; }
    value.path = transformedBox(context, args[0], args[1], args[2], args[3]);
  });
  for (const method of ['moveTo', 'lineTo']) wrap(method, (context, args, value) => {
    const target = point(context, args[0], args[1]);
    if (method === 'lineTo' && value.currentPoint) addSegment(value, value.currentPoint, target);
    else value.subpathStart = target;
    value.currentPoint = target;
    if (!value.rectangularPath && !value.path) return;
    value.rectangularPath = false;
    if (!target) { value.path = null; return; }
    const previous = value.path;
    value.path = previous ? { x: Math.min(previous.x, target.x), y: Math.min(previous.y, target.y),
      width: Math.max(previous.x + previous.width, target.x) - Math.min(previous.x, target.x),
      height: Math.max(previous.y + previous.height, target.y) - Math.min(previous.y, target.y) } : { ...target, width: 0, height: 0 };
  });
  wrap('closePath', (_context, _args, value) => {
    if (value.currentPoint && value.subpathStart) addSegment(value, value.currentPoint, value.subpathStart);
    value.currentPoint = value.subpathStart;
  });
  // A rounded rectangle is wholly contained in its rectangle. This upper
  // bound keeps a scrollbar fill from invalidating unrelated sheet text.
  if (prototype.roundRect) wrap('roundRect', (context, args, value) => {
    const known = value.rectangularPath || !!value.path, previous = value.path;
    const box = transformedBox(context, args[0], args[1], args[2], args[3]);
    value.rectangularPath = false; value.segments = null; value.currentPoint = value.subpathStart = null;
    value.path = known && box ? previous ? { x: Math.min(previous.x, box.x), y: Math.min(previous.y, box.y),
      width: Math.max(previous.x + previous.width, box.x + box.width) - Math.min(previous.x, box.x),
      height: Math.max(previous.y + previous.height, box.y + box.height) - Math.min(previous.y, box.y) } : box : null;
  });
  wrap('arc', (context, args, value) => {
    const known = value.rectangularPath || !!value.path, previous = value.path;
    const [x,y,radius,start,end] = args;
    // Every arc lies inside its full circle, including connecting lineTo.
    const box = transformedBox(context,x-radius,y-radius,radius*2,radius*2);
    value.rectangularPath=false;value.segments=null;
    value.path=known&&box ? previous ? {x:Math.min(previous.x,box.x),y:Math.min(previous.y,box.y),
      width:Math.max(previous.x+previous.width,box.x+box.width)-Math.min(previous.x,box.x),
      height:Math.max(previous.y+previous.height,box.y+box.height)-Math.min(previous.y,box.y)} : box : null;
    value.subpathStart ??= point(context,x+radius*Math.cos(start),y+radius*Math.sin(start));
    value.currentPoint=point(context,x+radius*Math.cos(end),y+radius*Math.sin(end));
  });
  for (const method of ['arcTo', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo']) {
    if (prototype[method]) wrap(method, (_context, _args, value) => {
      value.rectangularPath = false; value.path = null; value.segments = null; value.currentPoint = value.subpathStart = null;
    });
  }
  wrap('clip', (_context, args, value) => {
    const known = args.length === 0 || typeof args[0] === 'string';
    value.clip = known && value.rectangularPath && value.path && value.clip ? overlap(value.clip, value.path) : null;
  });
  wrap('clearRect', (context, args, value) => {
    const box = transformedBox(context, args[0], args[1], args[2], args[3]);
    invalidate(value, box); clearCoverage(value, box);
  });
  wrap('fillRect', (context, args, value) => { paint(context, value, transformedBox(context, args[0], args[1], args[2], args[3])); });
  wrap('fill', (context, args, value) => { paint(context, value, typeof args[0] !== 'object' ? value.path : null); });
  // Univer's grid/border primitives are independent axis-aligned segments.
  // Stroke paints their edges, never the rectangular area enclosed by them.
  // Half-width expansion covers caps and 90-degree joins (including miter)
  // under axis-aligned transforms. Curves, diagonals and Path2D stay unknown.
  const invalidateStroke = (context: CanvasRenderingContext2D, value: SheetCanvas, segments: PaintSegment[] | null) => {
    const m = context.getTransform();
    if (!segments || m.b !== 0 || m.c !== 0 || context.globalCompositeOperation !== 'source-over') { value.marks = []; value.coverage = null; value.coverageReason = 'unknown stroke segments/transform/composite'; return; }
    const pad = context.lineWidth / 2 * Math.max(Math.abs(m.a), Math.abs(m.d));
    for (const { from, to } of segments) {
      if (from.x === to.x && from.y === to.y && context.lineCap !== 'round') continue;
      paint(context, value, { x: Math.min(from.x, to.x) - pad, y: Math.min(from.y, to.y) - pad,
        width: Math.abs(to.x - from.x) + pad * 2, height: Math.abs(to.y - from.y) + pad * 2 });
    }
  };
  wrap('stroke', (context, args, value) => { invalidateStroke(context, value, typeof args[0] === 'object' ? null : value.segments); });
  wrap('strokeRect', (context, args, value) => { invalidateStroke(context, value, rectSegments(context, args)); });
  wrap('strokeText', (_context, _args, value) => { value.marks = []; value.coverage = null; value.coverageReason = 'strokeText/putImageData'; });
  wrap('putImageData', (_context, _args, value) => { value.marks = []; value.coverage = null; value.coverageReason = 'strokeText/putImageData'; });
  if (prototype.reset) wrap('reset', (context) => { sheetCanvases.set(context.canvas, blank(context.canvas)); });
  wrap('fillText', (context, args, value) => {
    if (!['source-over', 'copy'].includes(context.globalCompositeOperation)) value.marks = [];
    const text = String(args[0]);
    if (owner.painted.length < 2000) owner.painted.push(text);
    const metrics = context.measureText(text), x = args[1], y = args[2];
    const naturalWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
    const scale = args[3] === undefined ? 1 : Math.min(1, args[3] / metrics.width);
    const box = transformedBox(context, x - metrics.actualBoundingBoxLeft * scale, y - metrics.actualBoundingBoxAscent,
      naturalWidth * scale, metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    const style = context.fillStyle;
    paint(context, value, box);
    if (typeof style !== 'string' || /^(transparent|white|#fff|#ffffff|rgba\([^)]*,\s*0\))$/i.test(style) || !canProve(context, value, box)) return;
    if (value.marks.length < 2048) value.marks.push({ text, box, origin: value.id, chain: [] });
  });
  wrap('drawImage', (context, args, value) => {
    const source = args[0];
    const from: SheetCanvas | undefined = source ? sheetCanvases.get(source) : undefined;
    // Copy marks before invalidating to handle the renderer's self-cache scroll.
    const priorMarks = value.marks.slice();
    const sourceMarks = from?.marks.slice() ?? [];
    const sourceCoverage = from?.owner === owner && from.coverage !== null ? from.coverage.slice() : null;
    const sourceWidth = source?.naturalWidth ?? source?.width, sourceHeight = source?.naturalHeight ?? source?.height;
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 9 ? args.slice(1)
      : [0, 0, sourceWidth, sourceHeight, args[1], args[2], args.length === 5 ? args[3] : sourceWidth, args.length === 5 ? args[4] : sourceHeight];
    const destination = transformedBox(context, dx, dy, dw, dh);
    const sourceBox = { x: sx, y: sy, width: sw, height: sh };
    if (context.globalCompositeOperation === 'source-over' && sourceCoverage !== null && sw > 0 && sh > 0 && dw > 0 && dh > 0 && destination) {
      // A transparent overlay's canvas-sized drawImage does not overwrite
      // underlying text. Map only its real painted regions through the crop.
      for (const coverage of sourceCoverage) {
        const cropped = overlap(coverage, sourceBox);
        if (!cropped) continue;
        paint(context, value, transformedBox(context, dx + (cropped.x - sx) * dw / sw,
          dy + (cropped.y - sy) * dh / sh, cropped.width * dw / sw, cropped.height * dh / sh));
      }
    } else paint(context, value, destination);
    if (context.canvas.id.startsWith('univer-sheet-main-canvas')) {
      const events = owner.compositionEvents ??= [];
      events.push({ at: performance.now(), from: from?.id, to: value.id, sameOwner: from?.owner === owner,
        sourceSize: [sourceWidth, sourceHeight], sourceCoverage: sourceCoverage?.slice(0, 24) ?? null,
        coverageCount: sourceCoverage?.length, coverageReason: from?.coverageReason,
        sourceMarks: sourceMarks.map(mark => mark.text).slice(0, 24), before: priorMarks.length, afterInvalidation: value.marks.length,
        removed: priorMarks.filter(mark => !value.marks.includes(mark)).map(mark => mark.text), destination, clip: value.clip });
      if (events.length > 24) events.shift();
    }
    if (!from || from.owner !== owner || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 || !destination) return;
    for (const mark of sourceMarks) {
      if (!containsBox(sourceBox, mark.box) || mark.chain.length >= 8) continue;
      const box = transformedBox(context, dx + (mark.box.x - sx) * dw / sw, dy + (mark.box.y - sy) * dh / sh, mark.box.width * dw / sw, mark.box.height * dh / sh);
      if (!canProve(context, value, box)) continue;
      if (value.marks.length < 2048) value.marks.push({ ...mark, box, chain: [...mark.chain, { at: performance.now(),
        from: from.id, to: value.id, source: sourceBox, destination, textDestination: box, clip: value.clip,
        transform: context.getTransform().toJSON(), canvasSize: [value.width, value.height] }] });
    }
  });
}
function sheetComposition(canvas: HTMLCanvasElement, witness: string | undefined, cellBox?: PaintBox): Record<string, unknown> | undefined {
  const record = sheetCanvases.get(canvas);
  if (!record || !witness || !visible(canvas) || canvas.width !== record.width || canvas.height !== record.height) return;
  const bounds = canvas.getBoundingClientRect(), doc = canvas.ownerDocument;
  const viewport = { x: 0, y: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  const mark = record.marks.find(item => (cellBox ? item.text === witness : item.text.includes(witness)) && item.chain.length > 0 && item.origin !== record.id && containsBox({ x: 0, y: 0, width: canvas.width, height: canvas.height }, item.box) && (!cellBox || overlap(cellBox, {
    x: bounds.x + item.box.x * bounds.width / canvas.width, y: bounds.y + item.box.y * bounds.height / canvas.height,
    width: item.box.width * bounds.width / canvas.width, height: item.box.height * bounds.height / canvas.height,
  })) && overlap(viewport, {
    x: bounds.x + item.box.x * bounds.width / canvas.width, y: bounds.y + item.box.y * bounds.height / canvas.height,
    width: item.box.width * bounds.width / canvas.width, height: item.box.height * bounds.height / canvas.height,
  }));
  if (!mark) return;
  const screenBox = { x: bounds.x + mark.box.x * bounds.width / canvas.width, y: bounds.y + mark.box.y * bounds.height / canvas.height,
    width: mark.box.width * bounds.width / canvas.width, height: mark.box.height * bounds.height / canvas.height };
  return { witness, text: mark.text, origin: mark.origin, mainCanvas: record.id, canvasSize: [canvas.width, canvas.height],
    mainRect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, screenBox,
    viewportIntersection: overlap(viewport, screenBox), chain: mark.chain };
}
const sheets = new WeakMap<Window, SheetObservation>();
window.addEventListener('message', event => {
  if (event.data?.officeXlsx !== true || event.data.type !== 'bootstrap') return;
  const frame = [...rootElement.querySelectorAll('iframe')].find(node => node.contentWindow === event.source);
  if (!frame?.contentWindow || sheets.has(frame.contentWindow)) return;
  const state: SheetObservation = { installed: true, hostInstalled: false, painted: [], pixelChecks: [], calculation: { started: 0, ended: 0, applied: 0, pending: false, events: [] } };
  sheets.set(frame.contentWindow, state);
  observeSheetCanvas(frame.contentWindow, state);
  Object.defineProperty(frame.contentWindow, '__projectMindSheetsHost', {
    configurable: true,
    set(host: any) {
      state.hostInstalled = true;
      const attach = host.attach, render = host.render;
      host.attach = function (runtime: any) {
        state.runtime = runtime;
        const formula = runtime.univerAPI.getFormula();
        const calc = state.calculation;
        const event = (type: string, extra: Record<string, unknown> = {}) => {
          if (calc.events.length < 100) calc.events.push({ type, at: performance.now(), ...extra });
        };
        formula.calculationStart(() => { calc.started++; calc.pending = true; event('start'); });
        formula.calculationEnd((result: unknown) => { calc.ended++; event('end', { result }); });
        formula.calculationResultApplied(() => { calc.applied++; calc.pending = false; event('applied'); });
        return attach.call(this, runtime);
      };
      host.render = function (context: any) { state.context = context; return render.call(this, context); };
      Object.defineProperty(frame.contentWindow!, '__projectMindSheetsHost', { value: host, configurable: true, writable: true });
    },
  });
}, true);

class Boundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: errorMessage(error) }; }
  componentDidCatch(error: unknown) { errors.push(errorMessage(error)); }
  render() { return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children; }
}
let closeGuard: (() => Promise<void>) | undefined;
const registerCloseGuard = (guard: () => Promise<void>) => {
  closeGuard = guard;
  return () => { if (closeGuard === guard) closeGuard = undefined; };
};
function mount(file: ProjectDirectoryFile | null, projectId: number) {
  displayedFile = file;
  const view = file ? fileViews.get(file.object.id) : undefined;
  flushSync(() => root.render(<QueryClientProvider client={queryClient}><Boundary>
    {file && <ProjectFileContent workspaceRoot={config.workspaceRoot} projectId={projectId}
      fileId={Number(file.object.id)} fileName={file.name} visible focused registerCloseGuard={registerCloseGuard}
      onSourceReady={source => {sourceRefs.set(file.object.id, source); raceObserver?.sourceReady(file.object, source);}}
      initialView={view} initialSourceMode={view?.sourceMode} onViewChange={partial => fileViews.set(file.object.id, { ...fileViews.get(file.object.id), ...partial })} />}
  </Boundary></QueryClientProvider>));
  raceObserver?.displayCommitted(file?.object ?? null);
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function timeoutError(label: string, ms: number): Error {
  lastTimeout = { label, timeoutMs: ms, stage: waitStage, ...diagnostics() };
  console.error('office-performance:timeout', JSON.stringify(lastTimeout));
  return Error(`${label} timed out after ${ms}ms; ${JSON.stringify(lastTimeout)}. Hidden native windows may suspend RAF/painting.`);
}
function deadline<T>(promise: Promise<T>, ms: number, label: string, trackStage = true): Promise<T> {
  if (trackStage) waitStage = label;
  const owner = activeMeasurement;
  const remaining = owner ? Math.max(0, Math.min(ms, owner.expiresAt - performance.now())) : ms;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (owner) owner.expired = true;
      reject(timeoutError(label, remaining));
    }, remaining);
    promise.then(value => {
      clearTimeout(timer);
      if (owner?.expired) reject(Error(`Readiness expired during ${label}`)); else resolve(value);
    }, error => { clearTimeout(timer); reject(error); });
  });
}
async function doubleRaf(target: Window, label: string) {
  let first = 0, second = 0;
  try {
    await deadline(new Promise<void>(resolve => {
      first = target.requestAnimationFrame(() => { second = target.requestAnimationFrame(() => resolve()); });
    }), 4000, `double RAF: ${label}`);
  } finally { target.cancelAnimationFrame(first); target.cancelAnimationFrame(second); }
}
function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView!.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < element.ownerDocument.documentElement.clientHeight && rect.left < element.ownerDocument.documentElement.clientWidth && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && !element.closest('[hidden]');
}
function documents(): Document[] {
  const result = [document];
  for (let index = 0; index < result.length; index++) {
    for (const frame of result[index].querySelectorAll('iframe')) {
      if (visible(frame) && frame.contentDocument?.body) result.push(frame.contentDocument);
    }
  }
  return result;
}
function loading(): boolean {
  return documents().some(doc => [...doc.querySelectorAll('.editor-loading')].some(visible));
}
function assertNoErrors() {
  const alerts = documents().flatMap(doc => [...doc.querySelectorAll('[role="alert"]')].filter(visible).map(node => node.textContent?.trim()).filter(Boolean));
  if (errors.length || alerts.length) throw Error([...errors, ...alerts].join('\n'));
}
async function until(check: () => boolean, label: string, started: number) {
  waitStage = label;
  while (true) {
    if (activeMeasurement?.expired || performance.now() - started >= 45000) throw timeoutError(label, 45000);
    assertNoErrors();
    if (check()) return;
    await deadline(pause(25), 1000, label);
  }
}
function contentNodes(format: Format, source: boolean): Element[] {
  return documents().flatMap(doc => [...doc.querySelectorAll(format === 'md'
    ? source ? '.mind-markdown__source-pane .cm-content' : '.mind-markdown__rich-pane .ProseMirror'
    : format === 'docx' ? '.tiptap.doc-page' : format === 'pptx' ? '.stage-rel' : 'canvas[id^="univer-sheet-main-canvas"]')]).filter(visible);
}
function canvasPaint(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 2 || canvas.height < 2) return false;
  // Downsample a copy rather than asking a live WebGL canvas for a 2D context.
  // A uniformly white/transparent canvas is not evidence of painted sheet cells.
  const probe = canvas.ownerDocument.createElement('canvas'); probe.width = 96; probe.height = 64;
  const context = probe.getContext('2d')!;
  context.drawImage(canvas, 0, 0, 96, 64);
  let pixels: Uint8ClampedArray;
  try { pixels = context.getImageData(0, 0, 96, 64).data; }
  catch (error) {
    // Only the real XLSX main canvas may use the composition proof. Other
    // exceptions and tainted PPT canvases retain their original failure.
    if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'SecurityError') throw error;
    const record = sheetCanvases.get(canvas), state = record?.owner;
    if (!state || !canvas.id.startsWith('univer-sheet-main-canvas')) throw error;
    const proof = sheetComposition(canvas, state.witness);
    const evidence = { canvas: canvas.id, at: performance.now(), pixelCheckBlocked: true,
      reason: errorMessage(error), trackedMarkCount: record?.marks.length, compositionEvents: state.compositionEvents, invalidationEvents: state.invalidationEvents, witness: state.witness, method: 'tracked text/cache drawImage chain into visible main canvas', proof: proof ?? null };
    const index = state.pixelChecks.findIndex(item => item.canvas === canvas.id);
    if (index < 0) state.pixelChecks.push(evidence); else state.pixelChecks[index] = evidence;
    return !!proof;
  }
  for (let index = 4; index < pixels.length; index += 4) {
    if (pixels[index + 3] && (pixels[index] !== pixels[0] || pixels[index + 1] !== pixels[1] || pixels[index + 2] !== pixels[2] || pixels[index + 3] !== pixels[3])) return true;
  }
  return false;
}
function diagnostics(): Record<string, unknown> {
  const attempt = (read: () => unknown) => { try { return read(); } catch (error) { return { diagnosticError: errorMessage(error) }; } };
  const surfaces = [document, ...[...rootElement.querySelectorAll('iframe')].flatMap(frame => frame.contentDocument ? [frame.contentDocument] : [])];
  return {
    stage: waitStage, measurement: activeMeasurement, visibility: document.visibilityState, sheetCheck: lastSheetCheck,
    pendingCommands: commands.filter(command => command.duration === undefined).map(command => ({ name: command.name, elapsed: performance.now() - command.startTime })),
    documents: surfaces.map(doc => attempt(() => {
      const frame = [...rootElement.querySelectorAll('iframe')].find(frame => frame.contentDocument === doc);
      const observation = frame?.contentWindow && sheets.get(frame.contentWindow);
      const context = observation?.context, lazy = context?.lazyWorkbookRef.current;
      const api = observation?.runtime?.univerAPI, workbook = api?.getActiveWorkbook(), sheet = workbook?.getActiveSheet();
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect(), style = doc.defaultView!.getComputedStyle(node);
        return { tag: node.tagName, id: node.id, className: String(node.className).slice(0, 140), visible: visible(node),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, visibility: style.visibility,
          ...(node.tagName === 'CANVAS' ? { pixelWidth: (node as HTMLCanvasElement).width, pixelHeight: (node as HTMLCanvasElement).height } : {}) };
      };
      return { title: frame?.title ?? 'shell', visibility: doc.visibilityState, readyState: doc.readyState,
        mode: { html: doc.documentElement.dataset.presentationMode, body: doc.body?.dataset.presentationMode, markdown: doc.querySelector('.mind-markdown')?.getAttribute('data-mode') },
        surfaces: [...doc.querySelectorAll('.tiptap.doc-page,.stage-rel,canvas[id^="univer-sheet-main-canvas"],.cm-content,.mind-markdown__rich-pane .ProseMirror')].slice(0, 8).map(box),
        loading: [...doc.querySelectorAll('.editor-loading')].map(node => ({ stage: node.getAttribute('data-stage'), ...box(node) })),
        alerts: [...doc.querySelectorAll('[role="alert"]')].map(node => ({ text: node.textContent?.slice(0, 1000), visible: visible(node) })),
        fonts: doc.fonts.status,
        tabs: [...doc.querySelectorAll('[data-u-comp="slide-tab-item"],.thumb.active')].slice(0, 20).map(node => ({ text: node.textContent?.trim(), ...box(node) })),
        sheetHost: { bootstrapObserved: !!observation, observerInstalled: observation?.installed ?? false, hostInstalled: observation?.hostInstalled ?? false, runtime: !!observation?.runtime, context: !!context },
        worksheet: sheet && { id: sheet.getSheetId(), name: sheet.getSheetName(), activeRange: workbook.getActiveRange()?.getRange() },
        lifecycle: api?.getCurrentLifecycleStage(), openingWorkbook: context?.openingWorkbook,
        lazy: lazy && { flags: { ...lazy.flags }, formulaMode: lazy.formulaMode, closure: lazy.closure.status, loadedRanges: lazy.loadedRanges.size },
        pixelChecks: observation?.pixelChecks, calculation: observation?.calculation, paintedText: observation?.painted.slice(0, 40),
      };
    })), errors: [...errors],
  };
}
function sheetVisualState(model: XlsxModel, doc: Document, workbook: any,
  decoded: WeakMap<HTMLImageElement, { source: string; status: string; error?: string }>): { ready: boolean; reason?: string; visuals: Record<string, any>[] } {
  const sheet = workbook.getActiveSheet();
  const visuals = (model.visuals as any[]).filter(visual => visual.sheetId === sheet.getSheetId() && ['chart', 'image'].includes(visual.kind));
  const evidence: Record<string, any>[] = [];
  const pending = (reason: string) => ({ ready: false, reason, visuals: evidence });
  if (!visuals.length) return { ready: true, visuals: evidence };
  const view = doc.defaultView!;
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const intersect = (a: any, b: any) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  };
  const onScreen = (node: Element, bounds = box(node)) => {
    let result = intersect(bounds, { x: 0, y: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight });
    for (let parent: Element | null = node; parent && result; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
      if (parent !== node && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const r = box(parent);
        result = intersect(result, { x: /(hidden|clip|auto|scroll)/.test(style.overflowX) ? r.x : result.x,
          y: /(hidden|clip|auto|scroll)/.test(style.overflowY) ? r.y : result.y,
          width: /(hidden|clip|auto|scroll)/.test(style.overflowX) ? r.width : result.width,
          height: /(hidden|clip|auto|scroll)/.test(style.overflowY) ? r.height : result.height });
      }
    }
    return result;
  };
  const surface = doc.querySelector('canvas[id^="univer-sheet-main-canvas"]');
  if (!surface) return pending('visual anchor has no sheet surface');
  const surfaceBox = box(surface), zoom = sheet.getZoom();
  const scroll = workbook.getScrollStateBySheetId(sheet.getSheetId());
  if (!scroll || !(zoom > 0)) return pending('visual anchor scroll/zoom unavailable');
  const origin = sheet.getRange(0, 0, 1, 1).getCellRect();
  const scrollCell = sheet.getRange(scroll.sheetViewStartRow, scroll.sheetViewStartColumn, 1, 1).getCellRect();
  const freeze = sheet.getSheet().getFreeze();
  const scrollX = scrollCell.x - origin.x + scroll.offsetX, scrollY = scrollCell.y - origin.y + scroll.offsetY;
  const nodes = [...doc.querySelectorAll('[data-print-visual]')];
  for (const visual of visuals) {
    const a = visual.anchor, from = sheet.getRange(a.fromRow, a.fromColumn, 1, 1).getCellRect();
    const to = sheet.getRange(a.toRow, a.toColumn, 1, 1).getCellRect();
    const expectedBox = { x: surfaceBox.x + (from.x + a.fromColumnOffset / 9525 - (a.fromColumn < freeze.xSplit ? 0 : scrollX)) * zoom,
      y: surfaceBox.y + (from.y + a.fromRowOffset / 9525 - (a.fromRow < freeze.ySplit ? 0 : scrollY)) * zoom,
      width: Math.max(1, to.x - from.x + (a.toColumnOffset - a.fromColumnOffset) / 9525) * zoom,
      height: Math.max(1, to.y - from.y + (a.toRowOffset - a.fromRowOffset) / 9525) * zoom };
    const node = nodes.find(node => node.getAttribute('data-print-visual') === visual.id);
    const rendered = node?.firstElementChild ?? node;
    const expectedIntersection = onScreen(surface, expectedBox);
    const actualIntersection = rendered && onScreen(rendered);
    const item: Record<string, any> = { id: visual.id, kind: visual.kind, expectedBox, expectedIntersection,
      actualBox: rendered && box(rendered), actualIntersection: actualIntersection ?? null };
    evidence.push(item);
    // Missing asynchronous installs are obligations only where the native
    // anchor intersects this viewport. Existing DOM may also reveal a visual
    // displaced into view; it must meet the same content gate.
    if (!expectedIntersection && !actualIntersection) { item.offscreen = true; continue; }
    if (!node || !rendered || !actualIntersection) return pending(`visible visual ${visual.id} not installed in viewport`);
    item.geometry = [box(rendered)];
    if (visual.kind === 'chart') {
      const chart = visual.chart, svg = node.querySelector('svg.chart-svg'), title = node.querySelector('figcaption');
      const titleText = title?.textContent?.trim();
      item.title = titleText; item.expectedTitle = chart?.title;
      if (!chart || !svg || !title || titleText !== chart.title || !box(svg).width || !box(svg).height || !box(title).height) return pending(`chart ${visual.id} SVG/title not ready`);
      // Fixture charts are clustered positive bars. Resolve uncached series
      // refs from native inspected cells, just as the real chart hydrates them.
      const vectors: number[][] = chart.series.map((series: any) => {
        if (series.values.length) return series.values;
        const ref = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/u.exec(series.valuesRef ?? '');
        if (!ref) throw Error(`Chart ${visual.id} has no verifiable native series: ${series.valuesRef}`);
        const name = (ref[1] ?? ref[2]).replace(/''/g, "'"), sourceSheet = model.sheets.find(sheet => sheet.name === name);
        const col = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
        const values: number[] = [];
        for (let row = Number(ref[4]) - 1; row < Number(ref[6]); row++) for (let column = col(ref[3]); column <= col(ref[5]); column++) {
          const cell = sourceSheet && model.ranges[sourceSheet.id]?.cells.find(cell => cell.row === row && cell.column === column);
          if (typeof cell?.value !== 'number') throw Error(`Chart ${visual.id} native series cell missing/non-numeric: ${row}:${column}`);
          values.push(cell.value);
        }
        return values;
      });
      if (!chart.chartTypes.includes('barChart') || vectors.some(vector => vector.some(value => value < 0))) throw Error(`Unsupported first-screen chart proof: ${visual.id}`);
      const expectedBars = Array.from({ length: Math.max(0, ...vectors.map(vector => vector.length)) }, (_, index) => vectors.map(vector => vector[index] ?? 0)).flat().filter(value => value > 0);
      const bars = [...svg.querySelectorAll('g rect')].filter(bar => Number(bar.getAttribute('width')) > 0 && Number(bar.getAttribute('height')) > 0);
      const lengths = bars.map(bar => Number(bar.getAttribute(chart.barDirection === 'bar' ? 'width' : 'height')));
      const scale = lengths[0] / expectedBars[0];
      item.expectedBars = expectedBars; item.barLengths = lengths;
      if (!expectedBars.length || bars.length !== expectedBars.length || !Number.isFinite(scale) || scale <= 0 || lengths.some((length, index) => Math.abs(length / scale - expectedBars[index]) > 0.001) || bars.some(bar => !box(bar).width || !box(bar).height || view.getComputedStyle(bar).visibility === 'hidden' || view.getComputedStyle(bar).fill === 'none' || view.getComputedStyle(bar).fillOpacity === '0' || view.getComputedStyle(bar).opacity === '0')) return pending(`chart ${visual.id} actual series bars not ready`);
      item.geometry.push(box(svg), box(title), ...bars.map(box));
    } else {
      const image = node.querySelector<HTMLImageElement>('img'), media = model.rendererData?.media[visual.id] as { mediaType: string; base64: string } | undefined;
      if (!media) throw Error(`Native image ${visual.id} has no inspected media witness`);
      if (!image) return pending(`image ${visual.id} not installed`);
      const source = image.currentSrc || image.src;
      item.sourceMatches = source === `data:${media.mediaType};base64,${media.base64}`;
      item.mediaType = media.mediaType; item.naturalWidth = image.naturalWidth; item.naturalHeight = image.naturalHeight;
      if (!item.sourceMatches) return pending(`image ${visual.id} source differs from native media`);
      let state = decoded.get(image);
      if (!state || state.source !== source) {
        state = { source, status: 'pending' }; decoded.set(image, state);
        const current = state;
        void image.decode().then(() => { current.status = 'decoded'; }, error => { current.status = 'error'; current.error = String(error); });
      }
      item.decodeStatus = state.status;
      if (state.status === 'error') throw Error(`Image ${visual.id} decode failed: ${state.error}`);
      if (state.status !== 'decoded' || !image.naturalWidth || !image.naturalHeight || !onScreen(image)) return pending(`image ${visual.id} decoded visible pixels not ready`);
      item.geometry.push(box(image));
    }
  }
  return { ready: true, visuals: evidence };
}
const sheetVisualDecodes = new WeakMap<HTMLImageElement, { source: string; status: string; error?: string }>();
function sheetState(model: XlsxModel): Record<string, unknown> | undefined {
  const pending = (reason: string, details: Record<string, unknown> = {}) => { lastSheetCheck = { reason, ...details }; return undefined; };
  const frame = rootElement.querySelector<HTMLIFrameElement>('iframe[title="Excel 完整编辑器"]');
  const observation = frame?.contentWindow && sheets.get(frame.contentWindow);
  const api = observation?.runtime?.univerAPI, context = observation?.context;
  const workbook = api?.getActiveWorkbook(), sheet = workbook?.getActiveSheet();
  const lazy = context?.lazyWorkbookRef.current;
  if (!observation || !sheet || !lazy) return pending('missing host/runtime/context/worksheet');
  const calc = observation.calculation;
  if (context.openingWorkbook || calc.pending || lazy.flags.preloadRunning || lazy.closure.status === 'pending' || api.getCurrentLifecycleStage() < 3) return pending('opening/calculation/preload/lifecycle not settled');
  if (!(lazy.flags.preloadComplete || (!lazy.formulaMode && lazy.loadedRanges.size > 0))) return pending('initial native range not loaded');
  if (sheet.getSheetId() !== model.activeSheetId) throw Error('XLSX active sheet differs from native inspect');
  const range = model.ranges[model.activeSheetId];
  const expected = range.cells.filter(cell => cell.value !== null && cell.row < 20 && cell.column < 12).slice(0, 8);
  if (!expected.length) throw Error('Native XLSX first viewport contains no sample values to verify');
  const cellWitness = (cell: typeof range.cells[number]) => {
    const facade = sheet.getRange(cell.row, cell.column, 1, 1), actual = facade.getCellData();
    const numberFormat = model.styles[cell.styleIndex ?? 0]?.numberFormat ?? 'General';
    const formatted = typeof cell.value === 'number' ? formatNumber(numberFormat, cell.value) : String(cell.value ?? '');
    const actualValue = actual?.v ?? null;
    return { row: cell.row, column: cell.column, expected: cell.value, numberFormat, formatted,
      actualValue, displayedValue: facade.getValue(), formula: cell.formula,
      actualFormula: actual?.f || lazy.formulaText.get(model.activeSheetId)?.get(`${cell.row}:${cell.column}`),
      matches: Object.is(actualValue, cell.value) || (typeof cell.value === 'number' && actualValue === formatted) };
  };
  const samples = expected.map(cellWitness);
  if (samples.some(cell => !cell.matches || (cell.formula && cell.actualFormula !== cell.formula))) return pending('sample value/formula mismatch', { samples });
  const formulas = range.cells.filter(cell => cell.formula).slice(0, 3).map(cellWitness);
  if (lazy.formulaMode && formulas.length && calc.applied === 0) return pending('natural formula results not applied', { formulas });
  if (formulas.some(cell => cell.actualFormula !== cell.formula || !cell.matches)) return pending('formula witness mismatch', { formulas });
  const witness = expected.find(cell => typeof cell.value === 'string' && cell.value.trim())?.value as string | undefined;
  if (!witness) throw Error('Native XLSX first viewport has no text paint witness');
  observation.witness = witness;
  const canvasWitness = observation.painted.some(text => text.includes(witness));
  if (!canvasWitness) return pending('renderer canvas has not painted native text witness', { witness, paintedText: observation.painted.slice(0, 40) });
  const tabs = [...frame!.contentDocument!.querySelectorAll('[data-u-comp="slide-tab-item"]')].filter(visible);
  if (!tabs.length || !tabs.some(tab => tab.textContent?.includes(sheet.getSheetName()))) return pending('active sheet navigation not visible');
  const visuals = sheetVisualState(model, frame!.contentDocument!, workbook, sheetVisualDecodes);
  if (!visuals.ready) return pending(visuals.reason!, { visuals: visuals.visuals });
  lastSheetCheck = { reason: 'ready', witness, canvasWitness, visuals: visuals.visuals };
  return { sheetId: sheet.getSheetId(), sheetName: sheet.getSheetName(), samples, formulas, witness, canvasWitness, visuals: visuals.visuals,
    calculation: { ...calc, closure: lazy.closure.status, manual: context.calcManual, formulaMode: lazy.formulaMode,
      preloadComplete: lazy.flags.preloadComplete, loadedRanges: lazy.loadedRanges.size, lifecycle: api.getCurrentLifecycleStage(), forcedCalculation: false },
    navigation: tabs.map(tab => tab.textContent?.trim()) };
}
async function ready(file: ProjectDirectoryFile, source: boolean, editing: boolean, start: number) {
  // Existing loading API is the first gate; content and paint are separate gates.
  await until(() => !loading() && contentNodes(config.format, source).length > 0, 'renderer readiness', start);
  let evidence: Record<string, unknown> = {};
  const nativeModel = models.get(file.object.id);
  const canvasImages: HTMLImageElement[] = [];
  if (config.format === 'pptx') {
    const frame = rootElement.querySelector<HTMLIFrameElement>('iframe[title="PPTX 幻灯片编辑画布"]');
    const api = (frame?.contentWindow as (Window & { slidesApi?: { getRenderSlides(): Promise<{ nodes: unknown[] }[] | null> } }) | null)?.slidesApi;
    if (!api || nativeModel?.format !== 'pptx') throw Error('Real PPTX renderer/native model unavailable');
    const slides = await deadline(api.getRenderSlides(), 8000, 'PPTX getRenderSlides');
    if (!slides?.[0]) throw Error('PPTX has no first rendered slide');
    const texts = (value: unknown): string[] => {
      if (!value || typeof value !== 'object') return [];
      if (Array.isArray(value)) return value.flatMap(texts);
      return Object.entries(value).flatMap(([key, item]) => key === 'text' && typeof item === 'string' ? [item] : texts(item));
    };
    // Konva uses Image objects outside the DOM; decode the actual first-slide
    // renderer sources too, then allow its scheduled paint to settle below.
    const imageUrls = (value: unknown): string[] => typeof value === 'string' && value.startsWith('data:image/') ? [value]
      : Array.isArray(value) ? value.flatMap(imageUrls) : value && typeof value === 'object' ? Object.values(value).flatMap(imageUrls) : [];
    for (const url of new Set(imageUrls(slides[0].nodes))) {
      const image = frame!.contentDocument!.createElement('img'); image.src = url; canvasImages.push(image);
    }
    const actual = texts(slides[0].nodes).join('').replace(/\s+/gu, '');
    const expected = nativeModel.textElements.filter(node => node.slideIndex === 0).map(node => node.text.replace(/\s+/gu, '')).filter(Boolean);
    if (!expected.length || !expected.some(text => actual.includes(text.slice(0, 32)))) throw Error('PPTX first-slide text nodes differ from native inspect witness');
    evidence = { textSample: actual.slice(0, 180), expectedText: expected[0].slice(0, 32), slideCount: slides.length };
  }
  await until(() => {
    if (loading()) return false;
    const nodes = contentNodes(config.format, source);
    if (!nodes.length) return false;
    const model = models.get(file.object.id);
    if (config.format === 'xlsx') {
      if (model?.format !== 'xlsx') return false;
      const state = sheetState(model); if (!state) return false; evidence = state;
    } else if (config.format !== 'pptx') {
      const text = nodes.map(node => node.textContent ?? '').join(' ').replace(/\s+/gu, ' ').trim();
      if (!text) return false;
      const expected = model?.format === 'docx' ? model.nodes.find(node => node.text.trim())?.text.trim()
        : config.format === 'md' ? textSources.get(file.object.id)?.split(/\r?\n/u).find(line => line.trim())?.trim() : undefined;
      if (!expected) return false;
      const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '');
      if (!normalize(text).includes(normalize(expected).slice(0, 24))) return false;
      evidence = { textSample: text.slice(0, 180), expectedText: expected?.slice(0, 32) };
    }
    if (config.format !== 'md') {
      const frame = rootElement.querySelector<HTMLIFrameElement>(config.format === 'docx' ? 'iframe[title="Word 文档编辑器"]' : config.format === 'pptx' ? 'iframe[title="PPTX 幻灯片编辑画布"]' : 'iframe[title="Excel 完整编辑器"]')?.contentDocument;
      const mode = frame?.documentElement.dataset.presentationMode ?? frame?.body.dataset.presentationMode;
      if (mode !== (editing ? 'edit' : 'preview')) return false;
      if (config.format === 'pptx') {
        const active = frame?.querySelector('.thumb.active');
        if (!active || !visible(active) || active.querySelector('.thumb-num')?.textContent?.trim() !== '1') return false;
      }
    } else if (rootElement.querySelector('.mind-markdown')?.getAttribute('data-mode') !== (source ? 'source' : 'rich')) return false;
    return true;
  }, 'source-specific visible content and navigation', start);
  const docs = documents();
  await deadline(Promise.all(docs.map(doc => doc.fonts.ready)), 8000, 'fonts ready');
  const images = [...docs.flatMap(doc => [...doc.images].filter(image => {
    if (!visible(image)) return false;
    if (config.format !== 'xlsx') return true;
    const r = image.getBoundingClientRect();
    return r.right > 0 && r.bottom > 0 && r.left < doc.documentElement.clientWidth && r.top < doc.documentElement.clientHeight;
  })), ...canvasImages];
  await deadline(Promise.all(images.map(async image => { await image.decode(); if (!image.naturalWidth) throw Error(`Image has no decoded pixels: ${image.currentSrc.slice(0, 160)}`); })), 8000, 'visible image decode');
  const geometry = () => {
    const surfaces = contentNodes(config.format, source).slice(0, 32).map(node => {
      const rect = node.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height, node.scrollWidth, node.scrollHeight].map(value => Math.round(value * 10) / 10);
    });
    if (nativeModel?.format !== 'xlsx') return surfaces;
    const state = sheetState(nativeModel);
    if (!state) return null;
    evidence = state;
    return { surfaces, visuals: (state.visuals as Record<string, any>[]).filter(visual => !visual.offscreen)
      .map(visual => ({ id: visual.id, geometry: visual.geometry, intersection: visual.actualIntersection })) };
  };
  let previous = JSON.stringify(geometry()), stable = 0;
  while (stable < 3) {
    await deadline(Promise.all(documents().map((doc, index) => doubleRaf(doc.defaultView!, `document ${index}`))), 4000, 'layout double RAF');
    assertNoErrors();
    const layout = geometry(), next = JSON.stringify(layout);
    stable = layout && next === previous && !loading() ? stable + 1 : 0; previous = next;
    if (activeMeasurement?.expired || performance.now() - start > 45000) throw timeoutError('Viewport layout stability', 45000);
  }
  const canvases = documents().flatMap(doc => [...doc.querySelectorAll('canvas')].filter(canvas => visible(canvas) && (config.format !== 'pptx' || !!canvas.closest('.stage-rel')) && (config.format !== 'xlsx' || canvas.id.startsWith('univer-sheet-main-canvas'))));
  const painted = canvases.map(canvasPaint);
  if (canvases.length && !painted.some(Boolean)) throw Error('Visible canvases contain no non-uniform painted pixels');
  if ((config.format === 'xlsx' || config.format === 'pptx') && !painted.some(Boolean)) throw Error(`${config.format} has no painted canvas`);
  if (nativeModel?.format === 'xlsx' && !sheetState(nativeModel)) throw Error('XLSX facade/calculation changed before stable paint');
  assertNoErrors();
  return { ...evidence, decodedImages: images.length, canvasCount: canvases.length, paintedCanvases: painted.filter(Boolean).length,
    pixelChecks: config.format === 'xlsx' ? sheets.get(rootElement.querySelector<HTMLIFrameElement>('iframe[title="Excel 完整编辑器"]')!.contentWindow!)?.pixelChecks : undefined,
    stableDoubleRafPasses: stable, geometry: JSON.parse(previous), visibility: document.visibilityState };
}
function resources() {
  return documents().map((doc, index) => ({ document: index, url: doc.URL,
    entries: doc.defaultView!.performance.getEntriesByType('resource').map(entry => entry.toJSON()),
    marks: doc.defaultView!.performance.getEntriesByType('mark').filter(entry => /^(office-xlsx:|office-component:)/u.test(entry.name)).slice(-100).map(entry => entry.toJSON()) }));
}
async function operation(name: string, file: ProjectDirectoryFile, execute: (start: number) => Promise<Record<string, unknown>>, kind: 'performance' | 'acceptance' = 'acceptance') {
  const start = performance.now(), commandOffset = commands.length;
  activeMeasurement = { name, fileId: file.object.id, fileName: file.name, source: currentMode() === 'source', editing: currentMode() === 'edit', expiresAt: start + 45000, expired: false };
  lastSheetCheck = {};
  let record: Record<string, unknown>, failure: unknown;
  try {
    const evidence = await deadline(execute(start), 45000, `measurement ${name}`, false);
    const duration = performance.now() - start;
    record = { kind, name, file: file.name, fileId: file.object.id, version: file.versionNumber, startTime: start, duration,
      ...(kind === 'performance' ? { budgetMs: 1000, withinBudget: duration <= 1000 } : {}),
      status: kind === 'performance' && duration > 1000 ? 'over_budget' : 'passed',
      commandOffset, commandCount: commands.length - commandOffset, evidence, resources: resources() };
  } catch (error) {
    failure = error;
    record = { kind, name, file: file.name, fileId: file.object.id, startTime: start, duration: performance.now() - start,
      status: 'error', error: errorMessage(error), diagnostics: diagnostics(), resources: resources() };
  } finally { activeMeasurement = undefined; }
  measurements.push(record);
  // Capture elapsed time before any checkpoint network/RSS observation overhead.
  await checkpoint(name, { kind, file: file.name, fileId: file.object.id, duration: record.duration, status: record.status,
    measurementIndex: measurements.length - 1, commandCount: record.commandCount, mode: currentMode(), visibility: document.visibilityState });
  if (failure) throw failure;
  return record;
}
async function measure(name: string, file: ProjectDirectoryFile, action: () => void, source = false, editing = false) {
  return operation(name, file, async start => { action(); return ready(file, source, editing, start); }, 'performance');
}
async function checkpoint(name: string, evidence: Record<string, unknown>) {
  await send({ kind: 'checkpoint', name, time: performance.now(), evidence });
}
function click(label: string) {
  const button = [...rootElement.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label && visible(node));
  if (!button || button.disabled) throw Error(`Enabled visible button not found: ${label}`);
  flushSync(() => button.click());
}
async function send(report: Record<string, unknown>) {
  console.info(report.kind === 'checkpoint' ? 'office-performance:checkpoint' : 'office-performance:report', JSON.stringify(report));
  const response = await deadline(fetch(config.reportUrl, { method: 'POST', body: JSON.stringify(report) }), 8000, 'report POST');
  if (!response.ok) throw Error(`Report POST failed: ${response.status} ${await deadline(response.text(), 2000, 'report response body')}`);
}
function rendererFrame(): HTMLIFrameElement | null {
  const title = config.format === 'docx' ? 'Word 文档编辑器' : config.format === 'pptx' ? 'PPTX 幻灯片编辑画布' : 'Excel 完整编辑器';
  return rootElement.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
}
function rendererDocument(): Document {
  if (config.format === 'md') return document;
  const doc = rendererFrame()?.contentDocument;
  if (!doc) throw Error('Renderer document is unavailable');
  return doc;
}
function currentMode(): DisplayMode | 'closed' {
  if (!displayedFile) return 'closed';
  if (config.format === 'md') return rootElement.querySelector('.mind-markdown')?.getAttribute('data-mode') === 'source' ? 'source' : 'rich';
  const doc = rendererFrame()?.contentDocument;
  return (doc?.documentElement.dataset.presentationMode ?? doc?.body.dataset.presentationMode) === 'edit' ? 'edit' : 'preview';
}
function liveEditor(): any {
  const node = rendererDocument().querySelector(config.format === 'docx' ? '.tiptap.doc-page' : '.mind-markdown__rich-pane .ProseMirror');
  const editor = (node as (HTMLElement & { editor?: any }) | null)?.editor;
  if (!editor || editor.isDestroyed) throw Error('Real Tiptap editor is unavailable on the document body');
  return editor;
}
function liveSheet(): { observation: SheetObservation; workbook: any; sheet: any } {
  const frame = rendererFrame(), observation = frame?.contentWindow && sheets.get(frame.contentWindow);
  const workbook = observation?.runtime?.univerAPI.getActiveWorkbook(), sheet = workbook?.getActiveSheet();
  if (!observation || !workbook || !sheet) throw Error('Real worksheet facade is unavailable');
  return { observation, workbook, sheet };
}
function slidesApi(): { getRenderSlides(): Promise<PptxRenderSlide[] | null>; editText(op: { slideIndex: number; sourceId: string; paragraphs: { srcPara: number; runs: { text: string; srcRun: number }[] }[] }): Promise<unknown> } {
  const api = (rendererFrame()?.contentWindow as any)?.slidesApi;
  if (!api) throw Error('Real slidesApi is unavailable');
  return api;
}
function clickIn(doc: Document, selector: string, index = 0) {
  const nodes = [...doc.querySelectorAll<HTMLElement>(selector)].filter(visible);
  const node = nodes[index < 0 ? nodes.length + index : index];
  if (!node || (node as HTMLButtonElement).disabled || node.closest('[inert]')) throw Error(`Enabled renderer control missing: ${selector} [${index}]`);
  flushSync(() => node.click());
}
async function settle(label: string) {
  const docs = documents();
  await deadline(Promise.all(docs.map(doc => doc.fonts.ready)), 8000, `${label}: fonts`);
  await deadline(Promise.all(docs.map((doc, index) => doubleRaf(doc.defaultView!, `${label} document ${index}`))), 4000, `${label}: paint`);
  assertNoErrors();
}
async function applyMode(mode: DisplayMode) {
  if (!displayedFile) throw Error('No open file');
  if (config.format === 'md' ? !['rich', 'source'].includes(mode) : !['preview', 'edit'].includes(mode)) throw Error(`Unsupported ${config.format} mode: ${mode}`);
  if (currentMode() !== mode) click(config.format === 'md' ? mode === 'source' ? '源码' : '块编辑' : mode === 'edit' ? '编辑' : '保存并预览');
  const started = performance.now();
  await until(() => currentMode() === mode && !loading() && contentNodes(config.format, mode === 'source').length > 0, `mode ${mode}`, started);
  await settle(`mode ${mode}`);
  if (config.format === 'docx' && liveEditor().isEditable !== (mode === 'edit')) throw Error('Word editable state did not follow presentation mode');
  return viewState();
}
function viewState(): Record<string, unknown> {
  const doc = rendererDocument();
  if (config.format === 'xlsx') {
    const { workbook, sheet } = liveSheet();
    return { mode: currentMode(), sheetId: sheet.getSheetId(), zoom: sheet.getZoom(), range: workbook.getActiveRange()?.getRange(), scroll: sheet.getScrollState() };
  }
  if (config.format === 'pptx') return { mode: currentMode(), slide: doc.querySelector('.thumb.active .thumb-num')?.textContent?.trim(), zoom: doc.querySelector('.zoom-value')?.textContent?.trim() };
  const editor = liveEditor(), selection = editor.state.selection;
  return { mode: currentMode(), anchor: selection.anchor, head: selection.head,
    zoom: doc.querySelector(config.format === 'md' ? '.mind-markdown .zoom-value' : '.zoom-value')?.textContent?.trim(),
    scroll: scrollPort(editor.view.dom) ? { top: scrollPort(editor.view.dom)!.scrollTop, left: scrollPort(editor.view.dom)!.scrollLeft } : null };
}
function scrollPort(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(parent.ownerDocument.defaultView!.getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}
function withoutMode(state: Record<string, unknown>) { const { mode: _mode, ...rest } = state; return rest; }
function assertSameView(expected: Record<string, unknown>, actual: Record<string, unknown>) {
  if (JSON.stringify(withoutMode(expected)) !== JSON.stringify(withoutMode(actual))) throw Error(`Navigation/zoom changed across mode switch: ${JSON.stringify({ expected, actual })}`);
}
/** Acceptance after navigation: prove the selected native cell at its current screen position.
 * Initial ready() deliberately retains its separate first-viewport content/paint gates. */
function sheetNavigationPaint(model: XlsxModel): Record<string, unknown> | undefined {
  const { observation, workbook, sheet } = liveSheet();
  const selected = workbook.getActiveRange()?.getRange(), sheetId = sheet.getSheetId();
  if (!selected || selected.sheetId !== sheetId) return;
  const row = selected.startRow, column = selected.startColumn;
  const cell = model.ranges[sheetId]?.cells.find(cell => cell.row === row && cell.column === column);
  if (!cell || cell.value === null) return;
  const facade = sheet.getRange(row, column, 1, 1), actual = facade.getCellData();
  const numberFormat = model.styles[cell.styleIndex ?? 0]?.numberFormat ?? 'General';
  const witness = typeof cell.value === 'number' ? formatNumber(numberFormat, cell.value) : String(cell.value);
  if (!witness.trim() || !(Object.is(actual?.v, cell.value) ||
      (typeof cell.value === 'number' && actual?.v === witness))) return;
  if (cell.formula && (actual?.f || observation.context?.lazyWorkbookRef.current.formulaText.get(sheetId)?.get(`${row}:${column}`)) !== cell.formula) return;
  const doc = rendererDocument(), scroll = workbook.getScrollStateBySheetId(sheetId), zoom = sheet.getZoom();
  if (!scroll || !(zoom > 0)) return;
  const origin = sheet.getRange(0, 0, 1, 1).getCellRect();
  const scrollCell = sheet.getRange(scroll.sheetViewStartRow, scroll.sheetViewStartColumn, 1, 1).getCellRect();
  const rect = facade.getCellRect(), freeze = sheet.getSheet().getFreeze();
  for (const canvas of [...doc.querySelectorAll<HTMLCanvasElement>('canvas[id^="univer-sheet-main-canvas"]')].filter(visible)) {
    if (sheetCanvases.get(canvas)?.owner !== observation) continue;
    const bounds = canvas.getBoundingClientRect();
    const cellBox = { x: bounds.x + (rect.x - (column < freeze.xSplit ? 0 : scrollCell.x - origin.x + scroll.offsetX)) * zoom,
      y: bounds.y + (rect.y - (row < freeze.ySplit ? 0 : scrollCell.y - origin.y + scroll.offsetY)) * zoom,
      width: rect.width * zoom, height: rect.height * zoom };
    const proof = sheetComposition(canvas, witness, cellBox);
    if (proof) return { sheetId, row, column, expected: cell.value, actual: actual.v, numberFormat, witness, zoom, scroll, cellBox, proof };
  }
}
function watchContinuity() {
  const frame = rendererFrame(), doc = frame?.contentDocument;
  if (!frame || !doc) throw Error('Mode continuity requires the existing Office iframe');
  const initialSurface = contentNodes(config.format, false).find(node => node.ownerDocument === doc);
  if (!initialSurface) throw Error('No initial Office surface for continuity observation');
  const sheetModel = config.format === 'xlsx' && displayedFile ? models.get(displayedFile.object.id) : undefined;
  const sheetView = config.format === 'xlsx' ? viewState() : undefined;
  if (config.format === 'xlsx' && sheetModel?.format !== 'xlsx') throw Error('Native XLSX model unavailable for continuity');
  const samples: Record<string, unknown>[] = [];
  let frameRemoved = false, stopped = false, raf = 0;
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.removedNodes].some(node => node === frame || node.contains(frame)))) frameRemoved = true;
  });
  observer.observe(rootElement, { subtree: true, childList: true });
  const sample = () => {
    const sameFrame = rendererFrame() === frame && frame.isConnected && frame.contentDocument === doc;
    const present = sameFrame && initialSurface.isConnected && visible(initialSurface) && visible(frame) && !loading();
    const sheetPaint = present && sheetModel?.format === 'xlsx' &&
      JSON.stringify(withoutMode(viewState())) === JSON.stringify(withoutMode(sheetView!)) ? sheetNavigationPaint(sheetModel) : undefined;
    const painted = present && (config.format === 'xlsx' ? !!sheetPaint : config.format === 'docx' ? !!initialSurface.textContent?.trim()
      : [...doc.querySelectorAll<HTMLCanvasElement>('.stage-rel canvas')].filter(visible).some(canvasPaint));
    if (samples.length < 300) samples.push({ at: performance.now(), sameFrame, sameSurface: initialSurface.isConnected, present, painted, ...(sheetView ? { sheetPaint: sheetPaint ?? null } : {}) });
  };
  const tick = () => { if (!stopped) { sample(); raf = requestAnimationFrame(tick); } };
  sample(); raf = requestAnimationFrame(tick);
  return () => {
    stopped = true; cancelAnimationFrame(raf); sample();
    // Drain records so a removal in the final task cannot escape the observer callback.
    if (observer.takeRecords().some(record => [...record.removedNodes].some(node => node === frame || node.contains(frame)))) frameRemoved = true;
    observer.disconnect();
    if (frameRemoved || samples.some(sample => !sample.sameFrame || !sample.present || !sample.painted)) throw Error(`Office iframe/surface flashed or remounted: ${JSON.stringify({ frameRemoved, samples })}`);
    return { sameIframe: true, sameSurface: true, frameRemoved, samples, observation: 'parent RAF samples plus iframe removal observer; no screenshot assertion' };
  };
}
function firstTextEnd(editor: any): number {
  let end: number | undefined;
  editor.state.doc.descendants((node: any, pos: number) => {
    if (end === undefined && node.isTextblock && node.textContent.trim()) end = pos + 1 + node.content.size;
    return end === undefined;
  });
  if (end === undefined) throw Error('No nonempty editable text block in fixture');
  return end;
}
async function navigateAndZoom(): Promise<Record<string, unknown>> {
  const doc = rendererDocument();
  const before = viewState();
  if (config.format === 'xlsx') {
    const { workbook, sheet } = liveSheet();
    const target = workbook.getSheets().find((item: any) => item.getSheetId() !== sheet.getSheetId()) ?? sheet;
    workbook.setActiveSheet(target);
    target.setActiveRange(target.getRange('B3')); target.scrollToCell(2, 1, 0);
    target.zoom(Math.min(4, target.getZoom() + 0.1));
    await until(() => workbook.getActiveSheet().getSheetId() === target.getSheetId() && workbook.getActiveRange()?.getRange().startRow === 2, 'real worksheet navigation', performance.now());
    const model = displayedFile && models.get(displayedFile.object.id);
    if (model?.format !== 'xlsx') throw Error('Native model unavailable for navigated sheet paint');
    await until(() => !!sheetState({...model, activeSheetId: target.getSheetId()}), 'navigated native sheet content and canvas witness', performance.now());
    await until(() => !!sheetNavigationPaint(model), 'selected native cell composited in navigated viewport', performance.now());
  } else {
    if (config.format === 'pptx') {
      const thumbs = [...doc.querySelectorAll<HTMLElement>('.thumb')].filter(visible);
      if (!thumbs.length) throw Error('PPTX slide navigation missing');
      flushSync(() => thumbs[Math.min(1, thumbs.length - 1)].click());
    } else {
      const editor = liveEditor();
      if (!editor.commands.setTextSelection(firstTextEnd(editor)) || !editor.commands.scrollIntoView()) throw Error('Real text navigation command failed');
    }
    clickIn(doc, config.format === 'md' ? '.mind-markdown .zoom-btn' : '.zoom-btn', -1);
  }
  await settle('navigation/zoom');
  const after = viewState();
  if (before.zoom === after.zoom) throw Error(`Zoom control produced no change: ${JSON.stringify(after)}`);
  return { before, after };
}
async function resetNavigation() {
  if (config.format === 'xlsx') {
    const model = displayedFile && models.get(displayedFile.object.id);
    if (!model || model.format !== 'xlsx') throw Error('Native XLSX model unavailable');
    const { workbook } = liveSheet(); workbook.setActiveSheet(model.activeSheetId);
    const sheet = workbook.getActiveSheet(); sheet.setActiveRange(sheet.getRange('A1')); sheet.scrollToCell(0, 0, 0);
  } else if (config.format === 'pptx') clickIn(rendererDocument(), '.thumb', 0);
  await settle('return to first page');
}
async function closeDisplay() {
  if (!displayedFile) return;
  if (!projectContext || !closeGuard) throw Error('Cannot close without the real ProjectFileContent close guard');
  await deadline(closeGuard(), 15000, 'close guard');
  mount(null, projectContext.projectId);
  await doubleRaf(window, 'closed shell');
  if (rootElement.querySelector('.project-file-content,iframe,.mind-markdown')) throw Error('File surface remained mounted after close');
}
interface MutationWitness { marker: string; method: string; row?: number; column?: number; sheetId?: string; sourceId?: string }
async function mutate(file: ProjectDirectoryFile, marker: string): Promise<MutationWitness> {
  if (config.format === 'docx' || config.format === 'md') {
    const editor = liveEditor();
    if (!editor.isEditable) throw Error('Tiptap fixture is not editable');
    if (!editor.commands.insertContentAt(firstTextEnd(editor), ` ${marker}`) || !editor.getText().includes(marker)) throw Error('Real Tiptap insertion failed');
    return { marker, method: 'Tiptap insertContentAt in existing first text block' };
  }
  if (config.format === 'xlsx') {
    const { sheet } = liveSheet(), range = sheet.getRange('D20');
    if (range.getCellData()?.f) throw Error('Acceptance D20 contains a formula; refusing to replace the formula fixture');
    range.setValue(marker);
    await until(() => range.getValue() === marker, 'worksheet mutation applied', performance.now());
    return { marker, method: 'real FRange.setValue(D20)', sheetId: sheet.getSheetId(), row: 19, column: 3 };
  }
  const model = models.get(file.object.id);
  if (model?.format !== 'pptx') throw Error('PPTX native edit model unavailable');
  const text = model.textElements.find(item => item.slideIndex === 0 && item.editable && item.originalRichText.paragraphs[0]?.runs.length);
  if (!text) throw Error('No supported editable first-slide PPTX text target');
  // Native model IDs and the live renderer session use different namespaces.
  // Resolve the original OOXML shape through the renderer's actual identity API.
  const api = slidesApi() as ReturnType<typeof slidesApi> & {
    getShapeKeys(slideIndex: number): Promise<{ sourceId: string; spid: number | null }[]>;
  };
  const keys = await deadline(api.getShapeKeys(0), 8000, 'resolve live PPTX shape keys');
  const targets = keys.filter(key => key.spid !== null && String(key.spid) === text.cNvPrId);
  if (targets.length !== 1) throw Error(`PPTX original shape has no unique live sourceId: ${text.cNvPrId}`);
  const sourceId = targets[0].sourceId;
  const before = await deadline(api.getRenderSlides(), 8000, 'read PPTX mutation target');
  if (!before?.[0]?.nodes.some(node => (node as { sourceId?: string }).sourceId === sourceId))
    throw Error(`PPTX live sourceId is not rendered: ${sourceId}`);
  const paragraphs = text.originalRichText.paragraphs.map((paragraph, index) => ({ srcPara: index,
    runs: paragraph.runs.map((run, runIndex) => ({ ...run, srcRun: runIndex })) }));
  paragraphs[0].runs[paragraphs[0].runs.length - 1].text += ` ${marker}`;
  const changed = await deadline(api.editText({ slideIndex: 0, sourceId, paragraphs }), 15000, 'real PPTX editText');
  if (!changed) throw Error('PPTX editText returned no changed slide');
  const slides = await deadline(api.getRenderSlides(), 8000, 'read mutated PPTX');
  const mutated = slides?.[0]?.nodes.find(node => (node as { sourceId?: string }).sourceId === sourceId);
  if (!mutated || !JSON.stringify(mutated).includes(marker)) throw Error('PPTX renderer API did not retain the real text mutation');
  return { marker, sourceId, method: 'real slidesApi.editText; autosave from production command journal' };
}
function modelHasMutation(model: OfficeModel, witness: MutationWitness): boolean {
  if (model.format === 'docx') return model.nodes.some(node => node.text.includes(witness.marker));
  if (model.format === 'pptx') return model.textElements.some(node => node.text.includes(witness.marker));
  return !!model.ranges[witness.sheetId!]?.cells.some(cell => cell.row === witness.row && cell.column === witness.column && cell.value === witness.marker);
}
async function renderedHasMutation(witness: MutationWitness): Promise<boolean> {
  if (config.format === 'docx' || config.format === 'md') return liveEditor().getText().includes(witness.marker);
  if (config.format === 'xlsx') return liveSheet().sheet.getRange(witness.row, witness.column).getValue() === witness.marker;
  const slides = await deadline(slidesApi().getRenderSlides(), 8000, 'PPTX reopened text');
  return JSON.stringify(slides?.[0]?.nodes).includes(witness.marker);
}
async function navigationAcceptance(first: ProjectDirectoryFile) {
  try {
    await operation('acceptance_navigation_zoom_and_mode', first, async () => {
      await applyMode(config.format === 'md' ? 'rich' : 'preview');
      const navigation = await navigateAndZoom(), before = viewState();
      let continuity: Record<string, unknown>;
      if (config.format === 'md') {
        const body = liveEditor().view.dom;
        await applyMode('source'); await applyMode('rich');
        if (liveEditor().view.dom !== body) throw Error('Markdown rich editor remounted across source switch');
        continuity = { sameRichEditor: true, iframe: 'not applicable to Markdown', sourceRichRoundtrip: true };
      } else {
        const finish = watchContinuity();
        try { await applyMode('edit'); } catch (error) { finish(); throw error; }
        continuity = finish();
      }
      const after = viewState(); assertSameView(before, after);
      return { navigation, before, after, continuity, persistenceScope: 'navigation/zoom across mode switch in the same renderer; no harness restore' };
    });
  } catch (error) {
    const failed = measurements.at(-1);
    // Continue only an execute failure already retained by operation(). A
    // checkpoint/reporting failure must propagate, even if its row was written.
    if (failed?.name !== 'acceptance_navigation_zoom_and_mode' || failed.status !== 'error' || failed.error !== errorMessage(error)) throw error;
  }
  // Real navigation reset is a prerequisite, never a retry of continuity.
  // Its failure aborts mutation/readback/history and the later race checks.
  await operation('acceptance_reset_navigation', first, async () => {
    await resetNavigation(); return { navigationReset: true, state: viewState() };
  });
}
async function acceptance(first: ProjectDirectoryFile) {
  if (!projectContext) throw Error('Workspace context is unavailable');
  const { projectId, binding } = projectContext;
  await navigationAcceptance(first);
  const originalModel = models.get(first.object.id);
  const contentWitness = config.format === 'md' ? textSources.get(first.object.id)?.split(/\r?\n/u).find(line => line.trim())?.trim()
    : originalModel?.format === 'docx' ? originalModel.nodes.find(node => node.text.trim())?.text.trim()
    : originalModel?.format === 'pptx' ? originalModel.textElements.find(node => node.slideIndex === 0 && node.text.trim())?.text.trim()
    : originalModel?.ranges[originalModel.activeSheetId].cells.find(cell => typeof cell.value === 'string' && cell.value.trim())?.value as string | undefined;
  if (!contentWitness) throw Error('History acceptance requires original native content witness');
  let witness: MutationWitness | undefined, receipt: Commit | undefined, latest = first;
  await operation('acceptance_real_mutation_autosave', first, async () => {
    await applyMode(config.format === 'md' ? 'rich' : 'edit');
    const baseline = await deadline(projectFileApi.resolve(binding, first.object), 15000, 'native pre-edit version');
    const offset = commits.length, mutationStarted = performance.now();
    witness = await mutate(first, `NATIVE${config.format}${config.run}${crypto.randomUUID().slice(0, 8)}`);
    await until(() => {
      receipt = commits.slice(offset).find(commit => commit.fileId === first.object.id && !commit.receipt.noChange && commit.receipt.versionNumber > baseline.versionNumber);
      return !!receipt && rootElement.querySelector('.office-file-content__status')?.textContent?.trim() === '已保存';
    }, 'real autosave receipt and saved UI status', mutationStarted);
    latest = await deadline(projectFileApi.resolve(binding, first.object), 15000, 'native post-autosave version');
    if (latest.versionNumber !== receipt!.receipt.versionNumber || latest.contentHash !== receipt!.receipt.contentHash) throw Error('Native live version does not match autosave receipt');
    return { witness, baselineVersion: baseline.versionNumber, receipt, latestVersion: latest.versionNumber, autosaveMs: performance.now() - mutationStarted, explicitSaveInvoked: false };
  });
  await operation('acceptance_close_and_native_readback', latest, async () => {
    if (!witness || !receipt || !latest.contentHash) throw Error('No completed real mutation receipt');
    await closeDisplay();
    const baseline = { object: latest.object, versionNumber: latest.versionNumber, expectedContentHash: latest.contentHash };
    if (config.format === 'md') {
      const source = await deadline(fileDocumentApi.sourceRead(binding, { ...baseline, budgetChars: 16000 }), 15000, 'native saved Markdown source');
      if (!source.text.includes(witness.marker)) throw Error('Native saved Markdown source lost the accepted edit');
    } else {
      const result = await deadline(officeFileApi.inspect(binding, baseline), 30000, 'native saved Office readback');
      if (!modelHasMutation(result.model, witness)) throw Error('Native saved Office bytes lost the accepted edit');
    }
    return { witness, receipt: receipt.receipt, closeGuardCompleted: true, nativeReadback: true };
  });
  await operation('acceptance_reopen_and_verify', latest, async start => {
    if (!witness) throw Error('Mutation witness is missing');
    mount(latest, projectId);
    const source = config.format === 'md' && !!fileViews.get(latest.object.id)?.sourceMode;
    const firstScreen = await ready(latest, source, false, start);
    await applyMode(config.format === 'md' ? 'rich' : 'edit');
    if (!await renderedHasMutation(witness)) throw Error('Reopened real renderer does not contain saved content');
    return { firstScreen, witness, reopenedVersion: latest.versionNumber, savedContentVerified: true, finalMode: currentMode() };
  });
  await operation('acceptance_native_history_and_stale_cas', latest, async () => {
    if (!witness) throw Error('History acceptance requires a real saved edit');
    await applyMode(config.format === 'md' ? 'rich' : 'preview');
    return runNativeHistoryAcceptance({root: rootElement, file: latest, binding,
      source: () => sourceRefs.get(first.object.id) ?? null,
      ready: file => ready(file, false, false, performance.now()),
      renderedText: async () => {
        if (config.format === 'docx' || config.format === 'md') return liveEditor().getText();
        if (config.format === 'pptx') {
          // The render tree contains laid-out glyph runs, not contiguous JSON text.
          // Rejoin wraps in source order; preserve actual paragraph/soft breaks.
          type TextLayout = { lines: { runs: { text: string; logicalOrder?: number }[];
            paraStart?: boolean; trailingSpace?: boolean; trailingText?: string; softBreakAfter?: number }[] };
          type TextNode = { type: string; text?: TextLayout; children?: TextNode[]; cells?: { text?: TextLayout }[] };
          const layoutText = (layout?: TextLayout): string => layout?.lines.map((line, index) =>
            (index && line.paraStart ? '\n' : '') +
            [...line.runs].sort((a, b) => (a.logicalOrder ?? 0) - (b.logicalOrder ?? 0)).map(run => run.text).join('') +
            (line.trailingSpace ? line.trailingText ?? ' ' : '') + (line.softBreakAfter !== undefined ? '\n' : '')).join('') ?? '';
          const nodeText = (nodes: TextNode[]): string => nodes.map(node =>
            node.type === 'group' ? nodeText(node.children!) : node.type === 'table'
              ? node.cells!.map(cell => layoutText(cell.text)).join('\n') : layoutText(node.text)).join('\n');
          const slides = await slidesApi().getRenderSlides();
          if (!slides) throw Error('PPTX render slides unavailable for history witness');
          return slides.map(slide => nodeText(slide.nodes as TextNode[])).join('\n');
        }
        const {sheet} = liveSheet();
        return sheet.getRange('A1:L20').getValues().map((row: unknown[]) =>
          row.map(value => value == null ? '' : String(value)).join('\t')).join('\n');
      },
    }, {isolatedFixture: true, original: first, editMarker: witness.marker, contentWitness});
  });
}
function debugState(): Record<string, unknown> {
  let state: unknown;
  try { state = displayedFile ? viewState() : null; } catch (error) { state = { error: errorMessage(error) }; }
  return { file: displayedFile && { name: displayedFile.name, id: displayedFile.object.id }, mode: currentMode(), state, harnessRunning, debugBusy, diagnostics: diagnostics() };
}
async function interactive<T>(action: () => Promise<T>): Promise<T> {
  if (harnessRunning || debugBusy) throw Error('Native harness is busy; wait for the final report before manual actions');
  debugBusy = true;
  try { return await action(); } finally { debugBusy = false; }
}
function installControls() {
  window.officePerformance = {
    open: sample => interactive(async () => {
      if (!projectContext || !['simple', 'complex', 'large'].includes(sample)) throw Error('Workspace/sample unavailable');
      await closeDisplay();
      const file = await deadline(projectFileApi.register(projectContext.binding, projectContext.projectId, `${sample}.${config.format}`), 15000, 'debug native register');
      return measure(`manual_open_${sample}`, file, () => mount(file, projectContext!.projectId), !!fileViews.get(file.object.id)?.sourceMode);
    }),
    close: () => interactive(async () => {
      const file = displayedFile;
      if (!file) return;
      await operation('manual_close', file, async () => { await closeDisplay(); return { closed: true, closeGuardCompleted: true }; });
    }),
    setMode: mode => interactive(async () => {
      if (!displayedFile) throw Error('No open file');
      return operation(`manual_mode_${mode}`, displayedFile, () => applyMode(mode));
    }),
    getState: debugState,
  };
  const controls = document.getElementById('native-controls')!;
  document.getElementById('native-width')!.addEventListener('change', event => {
    const width = Number((event.target as HTMLSelectElement).value);
    void interactive(async () => {
      if (![490, 640, 980].includes(width)) throw Error('Unsupported acceptance width');
      rootElement.style.width = `${width}px`;
      await settle('acceptance width change');
      await checkpoint('manual_width', {width: rootElement.getBoundingClientRect().width, mode: currentMode()});
    }).catch(error => {if (controlStatus) controlStatus.textContent = errorMessage(error);});
  });
  controls.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const work = action === 'open' ? window.officePerformance.open((document.getElementById('native-sample') as HTMLSelectElement).value as Sample)
      : action === 'close' ? window.officePerformance.close()
      : action === 'state' ? Promise.resolve(window.officePerformance.getState())
      : window.officePerformance.setMode(config.format === 'md' ? action === 'edit' ? 'rich' : 'source' : action === 'edit' ? 'edit' : 'preview');
    if (controlStatus) controlStatus.textContent = '处理中…';
    void work.then(value => { if (controlStatus) controlStatus.textContent = '完成'; console.info('office-performance:manual', value); }, error => {
      if (controlStatus) controlStatus.textContent = errorMessage(error);
      console.error('office-performance:manual_failed', errorMessage(error), diagnostics());
    });
  });
}
async function run() {
  if (!config || !config.workspaceRoot || !config.reportUrl) throw Error('Missing window.__OFFICE_PERFORMANCE__ workspaceRoot/reportUrl');
  if (config.cycles !== undefined && (!Number.isInteger(config.cycles) || config.cycles < 0)) throw Error('cycles must be a nonnegative integer');
  const showControls = config.controls ?? !!config.acceptance;
  document.getElementById('native-controls')!.hidden = !showControls;
  (document.getElementById('native-sample') as HTMLSelectElement).value = config.sample;
  (document.getElementById('native-width') as HTMLSelectElement).value = String(config.width ?? 980);
  rootElement.style.cssText = `width:${config.width ?? 980}px;max-width:100vw;height:${showControls ? 'calc(100vh - 34px)' : '100vh'};display:flex;min-height:0;flex-direction:column`;
  if (config.setup) {
    await deadline(projectMindApi.workspaceCreate({ rootPath: config.workspaceRoot }), 45000, 'workspace create');
    const project = await deadline(projectMindApi.projectCreate({ name: 'Performance' }), 15000, 'project create');
    await send({ ...reportBase(), status: 'setup', projectRoot: project.rootPath, workspaceRoot: config.workspaceRoot, projectId: project.id });
    return;
  }
  if (!['docx', 'pptx', 'xlsx', 'md'].includes(config.format) || !['simple', 'complex', 'large'].includes(config.sample)) throw Error('Unsupported format/sample');
  await deadline(projectMindApi.workspaceOpen({ rootPath: config.workspaceRoot }), 15000, 'workspace open');
  // The native projects_list path accesses the open DB directly; propagate its real errors.
  const project = (await deadline(projectMindApi.projectsList(), 15000, 'projects list')).find(item => item.name === 'Performance');
  if (!project) throw Error('Performance project not found');
  const binding = await deadline(recordDocumentApi.bindingGet(config.workspaceRoot), 15000, 'workspace binding');
  projectContext = { projectId: project.id, binding };
  // Scan only when an optional large fixture is requested: absence is a skip,
  // whereas scan failures and unreadable existing files are real errors.
  if (config.sample === 'large') {
    let cursor: string | null = null, found = false;
    do {
      const page: ProjectDirectoryScanResult = await deadline(projectFileApi.scan(binding, project.id, cursor), 15000, 'native fixture scan');
      if (page.failures.length) throw Error(`Fixture scan failed: ${JSON.stringify(page.failures)}`);
      found ||= page.files.some(file => file.relativePath === `large.${config.format}`);
      cursor = page.nextCursor;
    } while (cursor);
    if (!found) {
      measurements.push({ name: 'fixture', file: `large.${config.format}`, status: 'skipped', reason: 'Optional large fixture does not exist in complete native directory scan' });
      await send({ ...reportBase(), status: 'skipped' }); return;
    }
  }
  const register = (sample: Sample) => deadline(projectFileApi.register(binding, project.id, `${sample}.${config.format}`), 15000, 'native fixture register');
  const first = await register(config.sample);
  const otherSample = config.sample === 'simple' ? 'complex' : 'simple';
  const other = await register(otherSample);
  await measure('cold_open', first, () => mount(first, project.id));
  await measure('first_other_file', other, () => mount(other, project.id));
  if (closeGuard) await deadline(closeGuard(), 15000, 'close guard');
  mount(null, project.id);
  await measure('close_reopen', other, () => mount(other, project.id));
  await measure('switch_file', first, () => mount(first, project.id));
  if (config.format === 'md') {
    await measure('rich_to_source', first, () => click('源码'), true);
    await measure('source_to_rich', first, () => click('块编辑'));
  } else await measure('preview_to_edit', first, () => click('编辑'), false, true);
  for (let cycle = 0; cycle < (config.cycles ?? 0); cycle++) {
    await closeDisplay();
    await measure(`cycle_${cycle + 1}_other`, other, () => mount(other, project.id));
    await closeDisplay();
    await measure(`cycle_${cycle + 1}_target`, first, () => mount(first, project.id), fileViews.get(first.object.id)?.sourceMode ?? false);
  }
  if (config.acceptance) await acceptance(first);
  if (raceObserver) {
    for (const action of ['switch', 'close'] as const) await operation(`acceptance_pending_file_${action}`, first, async () => {
      // This is a separate cancellation acceptance, not a timed cache scenario.
      // Clear code-independent models to exercise an actual pending native inspect.
      officePreviewCache.clear();
      const result = await runPendingFileRace({ observer: raceObserver, root: rootElement,
        mount: file => mount(file, project.id), close: closeDisplay,
        ready: file => ready(file, false, false, performance.now()),
        settlePaint: () => doubleRaf(window, 'pending native read completion'),
      }, { action, pendingFile: first, replacementFile: action === 'switch' ? other : undefined,
        pendingCommand: config.format === 'md' ? 'file_source_read' : 'file_office_inspect' });
      return result;
    });
    await measure('after_races_reopen', first, () => mount(first, project.id));
  }
  if (displayedFile?.object.id !== first.object.id) throw Error('Final screenshot target differs from first requested file');
  await send({ ...reportBase(), status: reportStatus(), resources: resources() });
}
installControls();
void run().catch(async error => {
  const message = errorMessage(error); errors.push(message);
  console.error('office-performance:failed', message);
  try { await send({ ...reportBase(), status: 'error', error: message, diagnostics: diagnostics(), resources: resources() }); }
  catch (reportError) { console.error('office-performance:report_failed', errorMessage(reportError)); }
}).finally(() => { harnessRunning = false; if (controlStatus) controlStatus.textContent = reportStatus() === 'error' ? '验收失败' : '就绪'; });
}
if (location.pathname === '/scripts/office-performance/native.html') installNativePage();
