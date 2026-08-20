import { describe, expect, it } from "vitest";

import { validateUpdaterManifest } from "./validate-updater-manifest.mjs";

describe("validateUpdaterManifest", () => {
  it("accepts one signed Beta update for every supported desktop target", () => {
    const releaseBase =
      "https://github.com/xuchen-cloud/project-mind-releases/releases/download/v0.2.0-beta.1";
    const manifest = {
      version: "0.2.0-beta.1",
      notes: "Beta update",
      pub_date: "2026-08-20T12:00:00Z",
      platforms: {
        "windows-x86_64": {
          url: `${releaseBase}/ProjectMind_0.2.0_windows_x86_64-setup.exe`,
          signature: "signed-windows-update",
        },
        "darwin-x86_64": {
          url: `${releaseBase}/ProjectMind_0.2.0_macos_x86_64.app.tar.gz`,
          signature: "signed-intel-macos-update",
        },
        "darwin-aarch64": {
          url: `${releaseBase}/ProjectMind_0.2.0_macos_aarch64.app.tar.gz`,
          signature: "signed-apple-silicon-update",
        },
      },
    };

    expect(() => validateUpdaterManifest(manifest)).not.toThrow();
  });

  it("rejects a Beta channel that omits a supported desktop target", () => {
    const manifest = {
      version: "0.2.0-beta.1",
      platforms: {
        "windows-x86_64": {
          url: "https://github.com/xuchen-cloud/project-mind-releases/releases/download/v0.2.0-beta.1/update.exe",
          signature: "signed-windows-update",
        },
      },
    };

    expect(() => validateUpdaterManifest(manifest)).toThrow(
      "missing updater target darwin-x86_64",
    );
  });

  it("accepts GitHub API asset URLs emitted by tauri-action", () => {
    const manifest = {
      version: "0.2.0-beta.1",
      platforms: Object.fromEntries(
        ["windows-x86_64", "darwin-x86_64", "darwin-aarch64"].map(
          (target, index) => [
            target,
            {
              url: `https://api.github.com/repos/xuchen-cloud/project-mind-releases/releases/assets/${index + 1}`,
              signature: `signed-${target}`,
            },
          ],
        ),
      ),
    };

    expect(() => validateUpdaterManifest(manifest)).not.toThrow();
  });
});
