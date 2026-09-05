import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("Beta release configuration", () => {
  it("keeps verification local and starts tagged releases with packaging", async () => {
    const workflow = await readFile(".github/workflows/publish-beta.yml", "utf8");

    expect(workflow).not.toMatch(/^  verify:/mu);
    expect(workflow).not.toContain("needs: verify");
    expect(workflow).not.toContain("npm run test:unit");
  });

  it("builds updater-enabled app bundles for both macOS architectures", async () => {
    const workflow = await readFile(".github/workflows/publish-beta.yml", "utf8");
    const macUpdaterBuilds = workflow.match(/--bundles app,dmg/gu) ?? [];

    expect(macUpdaterBuilds).toHaveLength(2);
    expect(workflow).toContain("--bundles nsis");
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""');
  });

  it("ships with ProjectMind as the visible application name", async () => {
    const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const html = await readFile("index.html", "utf8");

    expect(tauriConfig.productName).toBe("ProjectMind");
    expect(tauriConfig.app.windows[0].title).toBe("ProjectMind");
    expect(html).toContain("<title>ProjectMind</title>");
    expect(html).not.toContain("Project Mind Alpha");
  });

  it("builds Windows releases as GUI-subsystem executables", async () => {
    const main = await readFile("src-tauri/src/main.rs", "utf8");

    expect(main).toContain(
      '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
    );
  });

  it("allows native window destruction after close lifecycle barriers", async () => {
    const capability = JSON.parse(
      await readFile("src-tauri/capabilities/default.json", "utf8"),
    );

    expect(capability.permissions).toContain("core:window:allow-destroy");
  });

  it("uses ProjectMind consistently across user-visible product surfaces", async () => {
    const visibleProductFiles = [
      ".github/workflows/publish-beta.yml",
      "README.md",
      "docs/beta-release.md",
      "src/App.tsx",
      "src/components/project/CreateProjectModal.tsx",
      "src/components/settings/SettingsDialog.tsx",
      "src/components/settings/UpdateSettingsPanel.tsx",
      "src/features/record-export/docxGenerator.ts",
      "src/features/record-export/pdfGenerator.ts",
      "src-tauri/capabilities/default.json",
      "src-tauri/icons/icon-source.svg",
    ];
    const contents = await Promise.all(
      visibleProductFiles.map((path) => readFile(path, "utf8")),
    );

    expect(contents.join("\n")).not.toContain("Project Mind");
    expect(contents.join("\n")).not.toContain("Project-Mind");
  });

  it("publishes and serves Beta updates from the public source repository", async () => {
    const workflow = await readFile(".github/workflows/publish-beta.yml", "utf8");
    const tauriConfig = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

    expect(workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).not.toContain("RELEASES_TOKEN");
    expect(workflow).not.toContain("project-mind-releases");
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://raw.githubusercontent.com/xuchen-cloud/project_mind/main/beta/latest.json",
    ]);
  });

  it("supports a manual Windows-only patch release without advancing the Beta channel", async () => {
    const workflow = await readFile(
      ".github/workflows/publish-windows-patch.yml",
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("--target x86_64-pc-windows-msvc --bundles nsis");
    expect(workflow).toContain("uploadUpdaterJson: false");
    expect(workflow).toContain("uploadUpdaterSignatures: true");
    expect(workflow).toContain("prerelease: true");
    expect(workflow).toContain("RELEASE_TAG: ${{ inputs.tag }}");
    expect(workflow).not.toContain('"${{ inputs.tag }}"');
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).not.toContain("beta/latest.json");
    expect(workflow).not.toContain("publish-channel");
  });

  it("requires Windows patch tags to match the application version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const validTag = `v${packageJson.version}-windows.1`;
    const valid = spawnSync(
      process.execPath,
      ["scripts/validate-windows-patch-version.mjs", validTag],
      { encoding: "utf8" },
    );
    const invalid = spawnSync(
      process.execPath,
      ["scripts/validate-windows-patch-version.mjs", "v999.0.0-windows.1"],
      { encoding: "utf8" },
    );

    expect(valid.status, valid.stderr).toBe(0);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("does not match application version");
  });
});
