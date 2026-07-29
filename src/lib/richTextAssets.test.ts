import { describe, expect, it, vi } from "vitest";

vi.mock("../services/desktopApi", () => ({
  desktopApi: {
    toFileUrl: vi.fn((path: string) => `asset://${path}`),
  },
}));

import {
  repairRichTextAssetHtml,
  resolveRichTextAttachmentHref,
  resolveRichTextImageSrc,
} from "./richTextAssets";

describe("resolveRichTextImageSrc", () => {
  it("prefers the managed path even when an embedded data url exists", () => {
    expect(resolveRichTextImageSrc("/tmp/fixed.png", "data:image/png;base64,AA==")).toBe(
      "asset:///tmp/fixed.png",
    );
  });

  it("prefers the managed path over a stale src", () => {
    expect(resolveRichTextImageSrc("/tmp/fixed.png", "/tmp/stale.png")).toBe("asset:///tmp/fixed.png");
  });

  it("normalizes file uris back into asset urls", () => {
    expect(resolveRichTextImageSrc(null, "file:///tmp/demo%20image.png")).toBe(
      "asset:///tmp/demo image.png",
    );
  });
});

describe("resolveRichTextAttachmentHref", () => {
  it("rebuilds attachment hrefs from the managed path", () => {
    expect(resolveRichTextAttachmentHref("/tmp/demo file.pdf", "#")).toBe(
      "file:///tmp/demo%20file.pdf",
    );
  });
});

describe("repairRichTextAssetHtml", () => {
  it("repairs image src and attachment href from stored paths", () => {
    expect(
      repairRichTextAssetHtml(
        '<p><img src="/tmp/stale.png" data-path="/tmp/fixed.png" alt="demo"></p><div data-type="attachment" data-path="/tmp/demo file.pdf"><a class="rich-editor__attachment-link" href="#">demo</a></div>',
      ),
    ).toContain('src="asset:///tmp/fixed.png"');

    expect(
      repairRichTextAssetHtml(
        '<div data-type="attachment" data-path="/tmp/demo file.pdf"><a class="rich-editor__attachment-link" href="#">demo</a></div>',
      ),
    ).toContain('href="file:///tmp/demo%20file.pdf"');
  });
});
