import { constrainCaption, rememberCaption, restoreCaption, type CaptionPosition, type CaptionDisplay } from "../lib/voice-window-position";

const STORAGE_KEY = "voice-caption-position-v1";

interface PositionPort {
  displays(): Promise<CaptionDisplay[]>;
  outerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
  setSize(width: number, height: number): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  onMoved(handler: () => void): Promise<() => void>;
  onResized(handler: () => void): Promise<() => void>;
  onScaleChanged(handler: () => void): Promise<() => void>;
}

/** Physical monitor coordinates avoid mixed-DPI desktop-origin conversions. */
export async function trackVoiceWindowPosition(current: PositionPort): Promise<() => void> {
  let disposed = false;
  let updating = false;
  let topology = "";
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const synchronize = async (restore = false, topologyOnly = false) => {
    if (disposed || updating) return;
    updating = true;
    try {
      const displays = await current.displays();
      if (!displays.length || disposed) return;
      const nextTopology = JSON.stringify(displays);
      if (topologyOnly && nextTopology === topology) return;
      topology = nextTopology;
      const [position, size] = await Promise.all([current.outerPosition(), current.outerSize()]);
      let rect = { x: position.x, y: position.y, width: size.width, height: size.height };
      if (restore) {
        let saved: CaptionPosition | null = null;
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { /* Reset invalid preferences. */ }
        if (saved) {
          const currentScale = await current.scaleFactor();
          const targetScale = displays.find(display => display.name === saved.monitor)?.scaleFactor ?? displays[0].scaleFactor;
          rect = restoreCaption(saved, { width: Math.round(size.width / currentScale * targetScale), height: Math.round(size.height / currentScale * targetScale) }, displays);
        }
      }
      rect = constrainCaption(rect, displays);
      if (disposed) return;
      // Move before setting physical size so a DPI transition cannot scale the restored size twice.
      if (rect.x !== position.x || rect.y !== position.y) await current.setPosition(rect.x, rect.y);
      if (rect.width !== size.width || rect.height !== size.height) await current.setSize(rect.width, rect.height);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rememberCaption(rect, displays))); } catch { /* Placement still works when preferences are unavailable. */ }
    } finally { updating = false; }
  };
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void synchronize().catch(() => undefined), 180);
  };
  await synchronize(true);
  const stop: Array<() => void> = [];
  try {
    stop.push(await current.onMoved(schedule));
    stop.push(await current.onResized(schedule));
    stop.push(await current.onScaleChanged(schedule));
  } catch (error) { stop.forEach(unlisten => unlisten()); throw error; }
  // OS monitor removal need not deliver a window movement event.
  const timer = setInterval(() => void synchronize(false, true).catch(() => undefined), 2000);
  return () => { disposed = true; clearTimeout(debounce); clearInterval(timer); stop.forEach(unlisten => unlisten()); };
}
