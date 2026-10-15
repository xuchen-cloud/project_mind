import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";
import { resolveDebugBuild } from "./build-mode";

afterEach(() => vi.unstubAllEnvs());
describe("debug build mode", () => {
  it.each([
    { development: true, artifact: false, expected: true },
    { development: false, artifact: true, expected: true },
    { development: false, artifact: false, expected: false },
  ])("resolves dev=$development and nativeDebug=$artifact", ({ development, artifact, expected }) => {
    expect(resolveDebugBuild(development, artifact)).toBe(expected);
  });
  it.each([
    { environment: "true", expected: true },
    { environment: "false", expected: false },
    { environment: undefined, expected: false },
    { environment: "1", expected: false },
  ])("injects the official TAURI_ENV_DEBUG value $environment during production build config", async ({ environment, expected }) => {
    vi.stubEnv("TAURI_ENV_DEBUG", environment);
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, resolve(process.cwd(), "vite.config.ts"));
    expect(loaded?.config.define?.["import.meta.env.PROJECT_MIND_DEBUG_BUILD"]).toBe(expected);
    expect(resolveDebugBuild(false, loaded!.config.define!["import.meta.env.PROJECT_MIND_DEBUG_BUILD"])).toBe(expected);
  });
});
