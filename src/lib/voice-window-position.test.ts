import { expect, it } from "vitest";
import { constrainCaption, rememberCaption, restoreCaption } from "./voice-window-position";
const left = { name: "external", scaleFactor: 2, workArea: { position: { x: -2560, y: 0 }, size: { width: 2560, height: 1400 } } };
const main = { name: "main", scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } };
it("restores to the same display after its scale and arrangement change", () => {
  const saved = rememberCaption({ x: -1800, y: 900, width: 1360, height: 440 }, [left, main]);
  const moved = { ...left, scaleFactor: 1, workArea: { position: { x: 1920, y: 0 }, size: { width: 1280, height: 700 } } };
  const result = restoreCaption(saved, { width: 680, height: 220 }, [main, moved]);
  expect(result.x).toBeGreaterThanOrEqual(1920);
  expect(result.x + result.width).toBeLessThanOrEqual(3200);
  expect(result.y + result.height).toBeLessThanOrEqual(700);
});
it("brings a removed display's window back and clamps expansion to work area", () => {
  const rect = constrainCaption({ x: -2000, y: 1500, width: 680, height: 220 }, [main]);
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height).toBeLessThanOrEqual(1040);
  const expanded = constrainCaption({ x: 1800, y: 1000, width: 2400, height: 1400 }, [main]);
  expect(expanded).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
});
it("ignores corrupt persisted geometry", () => {
  expect(restoreCaption({ monitor: "main", x: NaN, y: Infinity }, { width: 680, height: 220 }, [main])).toEqual({ x: 620, y: 790, width: 680, height: 220 });
});
