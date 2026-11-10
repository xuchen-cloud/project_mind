import type {ProgressiveSession} from './progressive';
import type {PhasedContentHost} from './upstream/apps/docs/src/renderer/phased-content';
import type {FileActionContext} from './upstream/apps/docs/src/renderer/file-actions';
import {annotationsFromParsed} from './upstream/apps/docs/src/renderer/editor/ink';
import {setLazyMediaHashes} from './upstream/apps/docs/src/renderer/editor/extensions';

type Active = {
  session: ProgressiveSession; host: PhasedContentHost; context: FileActionContext;
  cancelled: boolean; fullyMounted: boolean; failure?: unknown; reading: Promise<void> | null; cleanup(): void;
};
let active: Active | null = null;
export const progressivePending = () => !!active && (!!active.failure || !active.fullyMounted);
export function updateProgressiveContext(ctx: FileActionContext) {
  if (active && ctx.doc?.parsed === active.session.parsed) active.context = ctx;
}
export function cancelProgressive() {
  if (!active) return;
  active.cancelled = true;
  active.cleanup();
  active = null;
}
const settledEvent = () => document.dispatchEvent(new Event('genoffice:phased-content-settled'));

async function appendNext(state: Active) {
  if (state.failure) throw state.failure;
  if (state.reading) return state.reading;
  if (state.cancelled || state.host.isDestroyed()) throw Error('Word 渐进读取已关闭');
  if (state.session.complete) return;
  state.reading = (async () => {
    try {
      const inkCount = state.session.parsed.inks.length;
      const batch = await state.session.loadMore();
      if (state.cancelled || active !== state || state.host.isDestroyed()) throw Error('Word 渐进读取已失效');
      const wasDirty = state.host.getDirty();
      setLazyMediaHashes(state.session.parsed.extras.lazyMediaHashes);
      // Append to the *live* PM document. Never remount an initial snapshot:
      // that would overwrite text typed while the next batch was parsing.
      if (batch.nodes.length) state.host.appendNodes(batch.nodes);
      state.host.setDirty(wasDirty);
      const ctx = state.context;
      const sections = state.session.sections.map((section, i) => {
        const previous = ctx.sections[i];
        const dirty = ctx.sectionsDirty.includes(i) || ctx.pgNumDirtySections.includes(i) || (ctx.sectionDirty && i === ctx.sections.length - 1);
        return previous && dirty ? {...previous, firstBlockIndex: section.firstBlockIndex, lastBlockIndex: section.lastBlockIndex} : section;
      });
      ctx.setSections(sections);
      if (state.session.parsed.inks.length > inkCount)
        ctx.setInkAnnotations([...ctx.inkAnnotations, ...annotationsFromParsed(state.session.parsed.inks.slice(inkCount))]);
      if (batch.complete) { state.fullyMounted = true; state.cleanup(); settledEvent(); }
    } catch (error) {
      state.failure = error;
      state.cleanup();
      if (!state.cancelled) (window as any).__projectMindDocxHost.reportError(error);
      throw error;
    } finally { state.reading = null; }
  })();
  return state.reading;
}

/** Explicit save/output barrier; a failed or cancelled tail never serializes. */
export async function materializeProgressive() {
  const state = active;
  if (!state) return;
  if (state.failure) throw state.failure;
  if (state.reading) await state.reading;
  if (state.failure) throw state.failure;
  if (active !== state || state.cancelled) throw Error('Word 渐进读取已失效');
  while (!state.fullyMounted) {
    await appendNext(state);
    // Let React commit section/ink state and let input paint between chunks.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (active !== state || state.cancelled) throw Error('Word 渐进读取已失效');
  }
  // A concurrent scroll may have completed the last read before this barrier
  // entered the loop. Its React metadata commit is still part of the barrier.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (state.failure) throw state.failure;
  if (active !== state || state.cancelled) throw Error('Word 渐进读取已失效');
}

// Global editor commands (find/replace, select all, section/ribbon tools)
// depend on the whole body. Defer the original intent behind the same barrier
// used by saving; ordinary typing in the mounted prefix remains immediate.
function gateGlobalCommands(state: Active) {
  const click = (event: MouseEvent) => {
    if (active !== state || (state.fullyMounted && !state.failure)) return;
    const target = (event.target as Element)?.closest<HTMLElement>('.ribbon button, .ribbon [role="tab"]');
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void materializeProgressive().then(() => {
      if (active === state && !state.cancelled && target.isConnected) target.click();
    }, () => {});
  };
  const keydown = (event: KeyboardEvent) => {
    if (active !== state || (state.fullyMounted && !state.failure) || !(event.ctrlKey || event.metaKey) || !['a', 'f', 'h', 'end'].includes(event.key.toLowerCase())) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.ProseMirror, .editor-scroll')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const init = {key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true};
    void materializeProgressive().then(() => {
      if (active === state && !state.cancelled && target.isConnected) target.dispatchEvent(new KeyboardEvent('keydown', init));
    }, () => {});
  };
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', keydown, true);
  return () => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', keydown, true); };
}

/** First content is immediately editable. Distant blocks stay unparsed. */
export function mountProgressiveContent(host: PhasedContentHost, session: ProgressiveSession, ctx: FileActionContext) {
  cancelProgressive();
  const state: Active = {session, host, context: ctx, cancelled: false, fullyMounted: session.complete, reading: null, cleanup: () => {}};
  active = state;
  host.setContent(session.initialDocument);
  if (session.complete) return;
  const scroller = ctx.editor?.view.dom.closest('.editor-scroll') as HTMLElement | null;
  let frame = 0;
  const check = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (active !== state || state.cancelled || state.failure || !scroller) return;
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < scroller.clientHeight * 1.5)
        void appendNext(state).then(() => { if (!session.complete) check(); }, () => {});
    });
  };
  const resize = new ResizeObserver(check);
  const ungate = gateGlobalCommands(state);
  if (scroller) { scroller.addEventListener('scroll', check, {passive: true}); resize.observe(scroller); }
  state.cleanup = () => { cancelAnimationFrame(frame); scroller?.removeEventListener('scroll', check); resize.disconnect(); ungate(); };
  check();
}
