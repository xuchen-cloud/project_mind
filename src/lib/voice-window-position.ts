export interface CaptionDisplay {
  name: string | null;
  scaleFactor: number;
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
}
export interface CaptionRect { x: number; y: number; width: number; height: number }
export interface CaptionPosition { monitor: string | null; x: number; y: number }

function displayFor(rect: CaptionRect, displays: CaptionDisplay[]) {
  return displays.reduce((best, display) => {
    const score = (candidate: CaptionDisplay) => {
      const area = candidate.workArea;
      const x = Math.max(0, Math.min(rect.x + rect.width, area.position.x + area.size.width) - Math.max(rect.x, area.position.x));
      const y = Math.max(0, Math.min(rect.y + rect.height, area.position.y + area.size.height) - Math.max(rect.y, area.position.y));
      return x * y;
    };
    return score(display) > score(best) ? display : best;
  }, displays[0]);
}
export function constrainCaption(rect: CaptionRect, displays: CaptionDisplay[]): CaptionRect {
  if (!displays.length) return rect;
  const area = displayFor(rect, displays).workArea;
  const width = Math.min(rect.width, area.size.width);
  const height = Math.min(rect.height, area.size.height);
  return {
    x: Math.round(Math.max(area.position.x, Math.min(rect.x, area.position.x + area.size.width - width))),
    y: Math.round(Math.max(area.position.y, Math.min(rect.y, area.position.y + area.size.height - height))), width, height,
  };
}
export function rememberCaption(rect: CaptionRect, displays: CaptionDisplay[]): CaptionPosition | null {
  if (!displays.length) return null;
  const display = displayFor(rect, displays);
  return { monitor: display.name,
    x: (rect.x - display.workArea.position.x) / Math.max(1, display.workArea.size.width - rect.width),
    y: (rect.y - display.workArea.position.y) / Math.max(1, display.workArea.size.height - rect.height) };
}
export function restoreCaption(saved: CaptionPosition | null, size: { width: number; height: number }, displays: CaptionDisplay[]): CaptionRect {
  if (!displays.length) return { x: 0, y: 0, ...size };
  const valid = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  const display = (valid && displays.find(display => display.name === saved.monitor)) || displays[0];
  const area = display.workArea;
  const x = valid ? Math.max(0, Math.min(1, saved.x)) : 0.5;
  const y = valid ? Math.max(0, Math.min(1, saved.y)) : 1;
  return constrainCaption({ ...size,
    x: area.position.x + x * Math.max(0, area.size.width - size.width),
    y: area.position.y + y * Math.max(0, area.size.height - size.height) - (valid ? 0 : 30 * display.scaleFactor),
  }, [display]);
}
