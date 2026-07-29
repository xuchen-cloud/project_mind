import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

afterEach(async () => {
  const { resetAiJobSync } = await import("../lib/aiJobs");
  resetAiJobSync();
  cleanup();
});
