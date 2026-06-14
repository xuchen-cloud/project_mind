import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { desktopApi } from "../../services/desktopApi";
import { RichTextViewer } from "./RichTextViewer";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(desktopApi, "toFileUrl").mockImplementation((path) => `asset://${path}`);
  vi.spyOn(desktopApi, "readFileAsDataUrl").mockImplementation(async (path, mimeType) => {
    const resolvedMimeType = mimeType || "image/png";
    return `data:${resolvedMimeType};base64,${btoa(path)}`;
  });
});

describe("RichTextViewer", () => {
  it("proactively loads managed images from the stored file path", async () => {
    const { container } = render(
      <RichTextViewer
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        "image/png",
      );
      expect(image.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
    });
  });

  it("reuses cached managed image data urls across re-renders", async () => {
    const sourceHtml =
      '<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>';
    const { container, rerender } = render(
      <RichTextViewer html={sourceHtml} />,
    );

    await waitFor(() => {
      const image = container.querySelector("img");

      expect(image?.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
    });

    const readSpy = vi.mocked(desktopApi.readFileAsDataUrl);
    readSpy.mockClear();

    rerender(<RichTextViewer html={sourceHtml} />);

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toBe(
      `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
    );
    expect(readSpy).not.toHaveBeenCalled();
  });
});
