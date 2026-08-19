import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// Node can expose an incomplete experimental `localStorage` when its
// --localstorage-file flag has no usable path. Keep jsdom tests deterministic.
if (typeof window.localStorage?.clear !== "function") {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

afterEach(async () => {
  const { resetAiJobSync } = await import("../lib/aiJobs");
  resetAiJobSync();
  cleanup();
});
