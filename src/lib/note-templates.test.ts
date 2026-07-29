import { describe, expect, it, vi } from "vitest";

vi.mock("../services/desktopApi", () => ({
  desktopApi: {
    toFileUrl: vi.fn((path: string) => `asset://${path}`),
  },
}));

import { getEditableNoteHtml } from "./note-templates";

describe("getEditableNoteHtml", () => {
  it("prefers stored html for editor rehydration instead of falling back to markdown", () => {
    expect(
      getEditableNoteHtml({
        contentHtml:
          '<p><img src="data:image/png;base64,AAAA" data-path="/tmp/managed/demo.png" alt="demo"></p>',
        contentMarkdown: "[图片] markdown placeholder",
      }),
    ).toBe('<p><img src="asset:///tmp/managed/demo.png" data-path="/tmp/managed/demo.png" alt="demo"></p>');
  });
});
