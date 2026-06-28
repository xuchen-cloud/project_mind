import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { desktopApi } from "../../services/desktopApi";
import { clearManagedImageThumbnailCacheForTests } from "./imageThumbnails";
import { RichTextViewer } from "./RichTextViewer";

beforeEach(() => {
  clearManagedImageThumbnailCacheForTests();
  vi.restoreAllMocks();
  vi.spyOn(desktopApi, "toFileUrl").mockImplementation((path) => `asset://${path}`);
  vi.spyOn(desktopApi, "readFileAsDataUrl").mockImplementation(async (path, mimeType) => {
    const resolvedMimeType = mimeType || "image/png";
    return `data:${resolvedMimeType};base64,${btoa(path)}`;
  });
  vi.spyOn(desktopApi, "generateImageThumbnail").mockImplementation(async (path, maxEdge) => {
    return `${path}.${maxEdge}.thumb.jpg`;
  });
});

describe("RichTextViewer", () => {
  it("defers managed image html repair until the viewer enters the viewport", async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const intersectionCallbacks: IntersectionObserverCallback[] = [];

    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: class IntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback);
        }

        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [];
      },
    });

    try {
      const { container } = render(
        <RichTextViewer
          deferUntilVisible
          html='<p><img src="/tmp/stale.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
        />,
      );

      expect(container.querySelector("img")).toBeNull();
      expect(desktopApi.toFileUrl).not.toHaveBeenCalled();

      intersectionCallbacks[0]?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );

      await waitFor(() => {
        expect(container.querySelector("img")).toBeTruthy();
      });
      await waitFor(() => {
        expect(intersectionCallbacks.length).toBeGreaterThanOrEqual(2);
      });

      intersectionCallbacks[1]?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );

      await waitFor(() => {
        expect(container.querySelector("img")?.getAttribute("src")).toBe(
          "asset:///tmp/managed/clip.png.960.thumb.jpg",
        );
      });
      expect(desktopApi.toFileUrl).toHaveBeenCalledWith("/tmp/managed/clip.png");
      expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        960,
      );
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        value: originalIntersectionObserver,
      });
    }
  });

  it("keeps managed images thumbnail-backed by default", async () => {
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
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
      "/tmp/managed/clip.png",
      960,
    );
    expect(desktopApi.readFileAsDataUrl).not.toHaveBeenCalled();
  });

  it("does not hydrate managed images while inactive", async () => {
    const { container, rerender } = render(
      <RichTextViewer
        active={false}
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
    });

    expect(desktopApi.generateImageThumbnail).not.toHaveBeenCalled();

    rerender(
      <RichTextViewer
        active
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });
    expect(desktopApi.generateImageThumbnail).toHaveBeenCalledTimes(1);
  });

  it("falls back to a data url when a managed image fails to load", async () => {
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

    image.dispatchEvent(new Event("error"));

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

  it("deduplicates concurrent fallback reads for the same managed image", async () => {
    const sourceHtml =
      '<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip one" /><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip two" /></p>';
    let resolveRead: ((value: string) => void) | null = null;
    vi.mocked(desktopApi.readFileAsDataUrl).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { container } = render(
      <RichTextViewer html={sourceHtml} />,
    );

    const images = await waitFor(() => {
      const nextImages = Array.from(container.querySelectorAll("img"));

      expect(nextImages).toHaveLength(2);
      return nextImages as HTMLImageElement[];
    });

    images[0]?.dispatchEvent(new Event("error"));
    images[1]?.dispatchEvent(new Event("error"));

    expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledTimes(1);

    resolveRead?.(`data:image/png;base64,${btoa("/tmp/managed/clip.png")}`);

    await waitFor(() => {
      expect(images[0]?.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
      expect(images[1]?.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
    });
  });
});
