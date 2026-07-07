import { describe, expect, it } from "vitest";

import { appendMarkdownSection } from "./record-move";

describe("appendMarkdownSection", () => {
  it("separates appended markdown from existing content", () => {
    expect(appendMarkdownSection("原内容", "追加内容")).toBe("原内容\n\n---\n\n追加内容");
  });

  it("uses appended markdown directly when the existing record is empty", () => {
    expect(appendMarkdownSection("", "追加内容")).toBe("追加内容");
  });

  it("keeps existing markdown when the appended selection is empty", () => {
    expect(appendMarkdownSection("原内容", "  ")).toBe("原内容");
  });
});
