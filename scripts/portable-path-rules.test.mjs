import { describe, expect, it } from "vitest";

import { collectPortablePathViolations } from "./portable-path-rules.mjs";

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
