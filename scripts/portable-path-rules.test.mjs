import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { collectPortablePathViolations } from "./portable-path-rules.mjs";
import { collectDocumentationPathViolations } from "./portable-path-policy.mjs";

describe("portable documentation paths", () => {
  it.each([
    ["absolute-markdown-link", "[entry](/opt/project/src/main.tsx)"],
    ["unix-absolute-path", "local path: /Users/alex/project/src/main.tsx"],
    ["unix-absolute-path", "local path: /Users/alex"],
    ["unix-absolute-path", "local path: /home/alex/project/src/main.tsx"],
    ["unix-absolute-path", "local path: /Volumes/Data/project/image.png"],
    ["unix-absolute-path", "local path: /opt/project/image.png"],
    ["unix-absolute-path", "local path: /bin/bash"],
    ["unix-absolute-path", "local path: /sbin/fsck"],
    ["unix-absolute-path", "local path: /dev/disk0"],
    ["unix-absolute-path", "local path: /proc/self/maps"],
    ["unix-absolute-path", "local path: /sys/kernel/debug"],
    ["unix-absolute-path", "local path: /run/user/501/app.sock"],
    ["unix-absolute-path", "local path: /boot/vmlinuz"],
    ["unix-absolute-path", "local path: /lib/libc.so"],
    ["unix-absolute-path", "local path: /nix/store/package"],
    ["unix-absolute-path", "local path: /data/local/app.db"],
    ["unix-absolute-path", "local path: /storage/emulated/0/image.png"],
    ["file-uri", "local link: file:///tmp/project/image.png"],
    ["file-uri", "local link: file://server/share/image.png"],
    ["windows-drive-path", "local path: C:\\Workspace\\project\\image.png"],
    ["unc-path", "local path: \\\\server\\share\\image.png"],
    ["unc-path", "local path: //server/share/image.png"],
  ])("reports %s", (rule, source) => {
    expect(collectPortablePathViolations("fixture.md", source)).toContainEqual(
      expect.objectContaining({ file: "fixture.md", line: 1, rule }),
    );
  });

  it("accepts repository-relative links, placeholders, and remote URLs", () => {
    const source = [
      "[entry](../src/main.tsx)",
      "`<workspace-root>/.project-mind/workspace.sqlite3`",
      "https://github.com/xuchen-cloud/project_mind",
      "https://example.com/docs/image.png",
      "product route: /optical/settings",
      "a runtime `file://` URI is transient",
    ].join("\n");

    expect(collectPortablePathViolations("fixture.md", source)).toEqual([]);
  });
});

describe("portable documentation scope", () => {
  const evidence = JSON.parse(fs.readFileSync(new URL("./portable-path-evidence.json", import.meta.url), "utf8"));
  const sourceLinesFor = (entry) => fs.readFileSync(new URL(`../${entry.file}`, import.meta.url), "utf8").split("\n");
  const digest = (line) => createHash("sha256").update(line).digest("hex");

  it("preserves only recorded historical, platform, protocol and pinned upstream lines", () => {
    expect(new Set(evidence.files.map((entry) => entry.category))).toEqual(new Set([
      "historical-evidence", "platform-path", "protocol-example", "pinned-upstream",
    ]));
    for (const entry of evidence.files) {
      const sourceLines = sourceLinesFor(entry);
      for (const line of entry.lines) {
        expect(sourceLines.filter((source) => digest(source) === line.sha256)).toHaveLength(line.occurrences);
      }
      const snapshot = entry.lines.flatMap((line) =>
        Array(line.occurrences).fill(sourceLines.find((source) => digest(source) === line.sha256)),
      ).join("\n");
      expect(collectDocumentationPathViolations(entry.file, snapshot)).toEqual([]);
      expect(collectDocumentationPathViolations(entry.file, `${snapshot}\nnew checkout: /Users/another/project`))
        .toContainEqual(expect.objectContaining({ rule: "unix-absolute-path" }));
    }
  });

  it("does not exempt changed, duplicated or relocated evidence lines", () => {
    const entry = evidence.files.find((file) => file.file === "scripts/office-selection/README.md");
    const line = sourceLinesFor(entry).find((source) => digest(source) === entry.lines[0].sha256);
    for (const [file, source] of [
      [entry.file, `${line} changed`],
      [entry.file, `${line}\n${line}`],
      ["docs/current/README.md", line],
    ]) {
      expect(collectDocumentationPathViolations(file, source).length).toBeGreaterThan(0);
    }
  });

  it("checks tracked and untracked authored docs, excluding generated reports and ignored materialization", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mind-portable-rules-"));
    try {
      fs.mkdirSync(path.join(root, "scripts"));
      for (const file of ["check-portable-paths.mjs", "portable-path-rules.mjs", "portable-path-policy.mjs", "portable-path-evidence.json"]) {
        fs.copyFileSync(new URL(file, import.meta.url), path.join(root, "scripts", file));
      }
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
      fs.writeFileSync(path.join(root, "README.md"), "[guide](docs/guide.md)\n");
      execFileSync("git", ["add", "README.md"], { cwd: root });
      for (const dir of [".full-review", "node_modules/materialized"]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true });
        fs.writeFileSync(path.join(root, dir, "report.md"), "historical output: /Users/local/cache");
      }
      const check = () => spawnSync(process.execPath, ["scripts/check-portable-paths.mjs"], { cwd: root, encoding: "utf8" });
      expect(check().status).toBe(0);
      fs.writeFileSync(path.join(root, "new-guide.md"), "run from /Users/local/private-checkout");
      const untracked = check();
      expect(untracked.status).toBe(1);
      expect(untracked.stderr).toContain("new-guide.md:1 unix-absolute-path");
      fs.writeFileSync(path.join(root, "new-guide.md"), "run from the repository root");
      fs.writeFileSync(path.join(root, "README.md"), "[entry](/home/local/project/README.md)");
      expect(check().status).toBe(1);
      fs.writeFileSync(path.join(root, "README.md"), "run from the repository root");
      // Ignore rules must never hide a tracked upstream source.
      execFileSync("git", ["add", "--force", "node_modules/materialized/report.md"], { cwd: root });
      const tracked = check();
      expect(tracked.status).toBe(1);
      expect(tracked.stderr).toContain("node_modules/materialized/report.md:1 unix-absolute-path");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
