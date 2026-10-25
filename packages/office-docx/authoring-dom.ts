import { JSDOM, VirtualConsole } from 'jsdom';
let installed = false;
/** Isolated worker DOM only; scripts and resource loading remain disabled. */
export async function ensureDom(): Promise<void> {
    if (installed)
        return;
    // The SDK test/browser host may already own a DOM. Preserve that realm so
    // its nodes and MutationObserver keep the same identity.
    if (globalThis.window?.document) {
        installed = true;
        return;
    }
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = dom.window as unknown as Record<string, unknown>, g = globalThis as unknown as Record<string, unknown>;
    for (const key of ['window', 'document', 'navigator'])
        Object.defineProperty(g, key, { value: key === 'window' ? w : w[key], configurable: true, writable: true });
    for (const key of Object.getOwnPropertyNames(w))
        if (!(key in g)) {
            try {
                g[key] = w[key];
            }
            catch { }
        }
    g.ResizeObserver ??= class {
        observe() { }
        unobserve() { }
        disconnect() { }
    };
    const noMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    g.matchMedia ??= noMedia;
    w.matchMedia ??= noMedia;
    g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
    g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    const range = (w.Range as {
        prototype: Record<string, unknown>;
    }).prototype;
    range.getClientRects ??= () => [];
    range.getBoundingClientRect ??= () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    installed = true;
}
