import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Beta release configuration", () => {
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
});
