import { afterEach, expect, it, vi } from "vitest";
import { trackVoiceWindowPosition } from "./voiceWindowPosition";

afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

it("restores across DPI before resizing and recovers when that display is removed", async () => {
  vi.useFakeTimers();
  localStorage.setItem("voice-caption-position-v1", JSON.stringify({ monitor: "external", x: 0.5, y: 0.5 }));
  const main = { name: "main", scaleFactor: 2, workArea: { position: { x: 0, y: 0 }, size: { width: 2880, height: 1700 } } };
  const external = { name: "external", scaleFactor: 1, workArea: { position: { x: 2880, y: 0 }, size: { width: 1280, height: 700 } } };
  let displays = [main, external];
  let position = { x: 100, y: 100 };
  let size = { width: 1360, height: 440 };
  const operations: string[] = [];
  const unlisten = vi.fn();
  const port = {
    displays: async () => displays,
    outerPosition: async () => position,
    outerSize: async () => size,
    scaleFactor: async () => position.x >= 2880 ? 1 : 2,
    setPosition: async (x: number, y: number) => { operations.push("move"); position = { x, y }; },
    setSize: async (width: number, height: number) => { operations.push("resize"); size = { width, height }; },
    onMoved: async () => unlisten, onResized: async () => unlisten, onScaleChanged: async () => unlisten,
  };
  const stop = await trackVoiceWindowPosition(port);
  expect(operations).toEqual(["move", "resize"]);
  expect(size).toEqual({ width: 680, height: 220 });
  expect(position.x).toBeGreaterThanOrEqual(2880);
  displays = [main];
  await vi.advanceTimersByTimeAsync(2000);
  expect(position.x + size.width).toBeLessThanOrEqual(2880);
  expect(position.y + size.height).toBeLessThanOrEqual(1700);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(3);
});
